/**
 * @module feedback
 * @description Personalization feedback loop.
 *
 * Records user interactions (clicked, saved, ignored) per job
 * and learns which scoring patterns to upweight or downweight.
 *
 * API:
 *   POST /feedback { jobId, action }  → recordInteraction()
 *   scoreJob() calls applyFeedbackBoost() to adjust the final score
 *
 * Preference model (stored in KV):
 *   - Tracks which matchedSkills, remoteType, seniority, salary presence
 *     correlate with "saved" vs "ignored" interactions
 *   - Positive reinforcement: saved/clicked → +1 for those features
 *   - Negative: ignored → -1 for those features
 *   - Blend weight: ±5 points max influence on final score
 */

import logger from '../core/logger.js';

/** KV key for the preference weight model. */
const WEIGHTS_KEY = 'pref:weights';

/** KV key for raw interaction history (ring buffer). */
const HISTORY_KEY = 'pref:history';

/** Maximum interaction history entries kept. */
const MAX_HISTORY = 500;

/** TTL for preference data — 90 days. */
const PREF_TTL = 90 * 24 * 60 * 60;

/** Max score boost/penalty from feedback (points). */
const MAX_BOOST = 5;

/** @type {string[]} Valid interaction actions. */
const VALID_ACTIONS = ['clicked', 'saved', 'ignored'];

// ── Internal helpers ──────────────────────────────────────────────────────────

async function readWeights(kv) {
    try {
        const raw = await kv.get(WEIGHTS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
}

async function saveWeights(kv, weights) {
    try {
        await kv.put(WEIGHTS_KEY, JSON.stringify(weights), { expirationTtl: PREF_TTL });
    } catch { }
}

async function readHistory(kv) {
    try {
        const raw = await kv.get(HISTORY_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}

async function saveHistory(kv, history) {
    try {
        await kv.put(HISTORY_KEY, JSON.stringify(history), { expirationTtl: PREF_TTL });
    } catch { }
}

/**
 * Extract the features from a score result that the model tracks.
 * @param {import('./relevance.js').ScoreResult} scoreResult
 * @returns {string[]} Feature tokens.
 */
function extractFeatureTokens(scoreResult) {
    const tokens = [];
    const { matchedSkills, features } = scoreResult || {};

    if (Array.isArray(matchedSkills)) {
        for (const s of matchedSkills) tokens.push(`skill:${s.toLowerCase()}`);
    }
    if (features?.remoteType && features.remoteType !== 'unknown') {
        tokens.push(`remote:${features.remoteType}`);
    }
    if (features?.seniority && features.seniority !== 'unknown') {
        tokens.push(`level:${features.seniority}`);
    }
    if (features?.salaryUSD) {
        tokens.push('salary:present');
    }

    return tokens;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record a user interaction for a specific job.
 *
 * @param {KVNamespace} kv
 * @param {string} jobId
 * @param {'clicked'|'saved'|'ignored'} action
 * @param {object} [scoreResult] - Score result to extract features from (optional).
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function recordInteraction(kv, jobId, action, scoreResult = null) {
    if (!VALID_ACTIONS.includes(action)) {
        return { ok: false, message: `Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}` };
    }

    const entry = {
        jobId,
        action,
        ts: new Date().toISOString(),
        features: scoreResult ? extractFeatureTokens(scoreResult) : [],
    };

    // Append to history ring buffer
    const history = await readHistory(kv);
    history.push(entry);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    await saveHistory(kv, history);

    // Update weights if we have feature data
    if (entry.features.length > 0) {
        const weights = await readWeights(kv);
        const delta = action === 'ignored' ? -1 : 1; // saved/clicked = +1, ignored = -1

        for (const token of entry.features) {
            weights[token] = (weights[token] || 0) + delta;
        }

        await saveWeights(kv, weights);
        logger.info(`[Feedback] ${action} → updated ${entry.features.length} weight tokens`);
    }

    return { ok: true };
}

/**
 * Get the learned preference weights (for /metrics endpoint).
 * @param {KVNamespace} kv
 * @returns {Promise<object>}
 */
export async function getPreferenceWeights(kv) {
    return readWeights(kv);
}

/**
 * Get recent interaction history (for /metrics endpoint).
 * @param {KVNamespace} kv
 * @param {number} [limit=20]
 */
export async function getInteractionHistory(kv, limit = 20) {
    const history = await readHistory(kv);
    return history.slice(-limit).reverse(); // most recent first
}

/**
 * Apply a feedback-learned boost/penalty to a job's score.
 * The adjustment is proportional to how strongly the job's features match
 * learned preferences. Capped at ±MAX_BOOST points.
 *
 * @param {import('./relevance.js').ScoreResult} scoreResult
 * @param {object} weights - From `getPreferenceWeights()`.
 * @returns {{ adjustedScore: number, feedbackDelta: number }}
 */
export function applyFeedbackBoost(scoreResult, weights) {
    if (!weights || Object.keys(weights).length === 0) {
        return { adjustedScore: scoreResult.score, feedbackDelta: 0 };
    }

    const tokens = extractFeatureTokens(scoreResult);
    if (!tokens.length) return { adjustedScore: scoreResult.score, feedbackDelta: 0 };

    // Sum raw weight signal for these features
    const rawSignal = tokens.reduce((sum, t) => sum + (weights[t] || 0), 0);

    // Normalize: each token contributes at most ±1 point, total capped at ±MAX_BOOST
    const normalized = rawSignal / tokens.length;
    const delta = Math.max(-MAX_BOOST, Math.min(MAX_BOOST, Math.round(normalized)));

    const adjustedScore = Math.max(0, Math.min(100, scoreResult.score + delta));
    return { adjustedScore, feedbackDelta: delta };
}

// ── Source-Level Feedback Adjustments ─────────────────────────────────────────

/**
 * Priority delta table: maps downstream job outcome → source priority change.
 * @type {Record<string, number>}
 */
const SOURCE_FEEDBACK_DELTAS = {
    interview:  +5,   // Job from this source led to an interview — boost source
    applied:    +2,   // Applied to this job — mild positive signal
    saved:      +1,   // Saved but not applied — minor positive
    clicked:     0,   // Click only — no priority change
    ignored:    -1,   // Saw but ignored — mild negative
    rejected:   -3,   // Applied & rejected — soft deprioritize
};

/**
 * Apply a downstream job outcome to the originating source's priority score.
 * Clamps the resulting score to [0, 100]. Uses db.batch() for efficiency.
 *
 * @param {D1Database} db
 * @param {string} sourceUrl - The `sourceUrl` field of the job.
 * @param {'interview'|'applied'|'saved'|'clicked'|'ignored'|'rejected'} feedbackType
 * @returns {Promise<{ ok: boolean, delta: number }>}
 */
export async function applyFeedbackToSource(db, sourceUrl, feedbackType) {
    const delta = SOURCE_FEEDBACK_DELTAS[feedbackType];
    if (delta === undefined || delta === 0) return { ok: true, delta: 0 };

    try {
        await db.prepare(
            `UPDATE source_registry
             SET priority_score = MAX(0, MIN(100, priority_score + ?))
             WHERE url = ?`
        ).bind(delta, sourceUrl).run();

        logger.info(`[Feedback] Source ${sourceUrl} priority ${delta > 0 ? '+' : ''}${delta} from "${feedbackType}"`);
        return { ok: true, delta };
    } catch (err) {
        logger.warn(`[Feedback] applyFeedbackToSource failed for ${sourceUrl}: ${err.message}`);
        return { ok: false, delta };
    }
}
