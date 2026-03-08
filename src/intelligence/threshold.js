/**
 * @module threshold
 * @description Dynamic notification threshold engine.
 *
 * Problem: A static threshold (50) can't adapt to feed quality shifts.
 * High-quality days → threshold too low → too many alerts.
 * Dead feed days → threshold too high → zero alerts.
 *
 * Solution: Keep a rolling window of the last N job scores in KV.
 * Compute the distribution mean and auto-adjust the threshold to maintain
 * a healthy match rate (target: ~3–8 notifications per cron run).
 *
 * Guardrails: threshold never goes below MIN_THRESHOLD or above MAX_THRESHOLD.
 */

import logger from '../core/logger.js';

/** Rolling window size (last N evaluated scores). */
const WINDOW_SIZE = 200;

/** Absolute minimum threshold — never alert on pure junk. */
const MIN_THRESHOLD = 30;

/** Absolute maximum threshold — never be so strict you miss everything. */
const MAX_THRESHOLD = 70;

/** Auto-adjust step per cron run. */
const ADJUST_STEP = 2;

/** Target notifications per run range. */
const TARGET_MIN_MATCHES = 1;
const TARGET_MAX_MATCHES = 8;

/** KV key for the sliding window of recent scores. */
const WINDOW_KEY = 'thresh:window';

/** KV key for the current effective threshold. */
const EFFECTIVE_KEY = 'thresh:effective';

/** TTL for threshold data — 60 days. */
const THRESHOLD_TTL = 60 * 24 * 60 * 60;

/** In-memory cache for threshold values to reduce KV reads */
let _cachedEffective = null;
let _cachedWindow = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readWindow(kv) {
    // Use in-memory cache if available
    if (_cachedWindow !== null) return _cachedWindow;
    
    try {
        const raw = await kv.get(WINDOW_KEY);
        _cachedWindow = raw ? JSON.parse(raw) : [];
        return _cachedWindow;
    } catch { 
        return []; 
    }
}

async function saveWindow(kv, window) {
    // Update in-memory cache immediately
    _cachedWindow = window;
    
    try {
        await kv.put(WINDOW_KEY, JSON.stringify(window), { expirationTtl: THRESHOLD_TTL });
    } catch { }
}

async function readEffective(kv, configDefault) {
    // Use in-memory cache if available
    if (_cachedEffective !== null) return _cachedEffective;
    
    try {
        const raw = await kv.get(EFFECTIVE_KEY);
        _cachedEffective = raw ? parseInt(raw, 10) : configDefault;
        return _cachedEffective;
    } catch { 
        return configDefault; 
    }
}

async function saveEffective(kv, value) {
    // Only write to KV if value actually changed significantly
    if (_cachedEffective !== null && Math.abs(_cachedEffective - value) < 2) {
        return; // Skip KV write if change is minor
    }
    
    // Update in-memory cache
    _cachedEffective = value;
    
    try {
        await kv.put(EFFECTIVE_KEY, String(value), { expirationTtl: THRESHOLD_TTL });
    } catch { }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Push a newly evaluated job score into the rolling window.
 * @param {KVNamespace} kv
 * @param {number} score
 */
export async function recordJobScore(kv, score) {
    const window = await readWindow(kv);
    window.push(score);
    // Keep only the last WINDOW_SIZE entries
    if (window.length > WINDOW_SIZE) window.splice(0, window.length - WINDOW_SIZE);
    await saveWindow(kv, window);
}

/**
 * Compute statistics from the rolling window.
 * @param {KVNamespace} kv
 * @returns {Promise<{ mean: number, p75: number, p90: number, sampleSize: number }>}
 */
export async function computeWindowStats(kv) {
    const window = await readWindow(kv);
    if (!window.length) return { mean: null, p75: null, p90: null, sampleSize: 0 };

    const sorted = [...window].sort((a, b) => a - b);
    const mean = Math.round(window.reduce((s, v) => s + v, 0) / window.length);
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    const p90 = sorted[Math.floor(sorted.length * 0.90)];

    return { mean, p75, p90, sampleSize: window.length };
}

/**
 * Get the current effective threshold, applying auto-adjustment based on
 * match rate from the last run.
 *
 * @param {KVNamespace} kv
 * @param {number} configThreshold - Base threshold from config.
 * @param {{ matchedLastRun?: number }} context - Pass matched count from last run.
 * @returns {Promise<{ effective: number, base: number, adjusted: boolean }>}
 */
export async function getEffectiveThreshold(kv, configThreshold, context = {}) {
    const effective = await readEffective(kv, configThreshold);
    const { matchedLastRun } = context;

    if (matchedLastRun === undefined || matchedLastRun === null) {
        // First run or no context — return current effective unchanged
        return { effective, base: configThreshold, adjusted: false };
    }

    let next = effective;
    let adjusted = false;

    if (matchedLastRun > TARGET_MAX_MATCHES) {
        // Too many alerts → raise bar
        next = Math.min(MAX_THRESHOLD, effective + ADJUST_STEP);
        adjusted = true;
        logger.info(`[Threshold] Too many matches (${matchedLastRun}) → raising to ${next}`);
    } else if (matchedLastRun < TARGET_MIN_MATCHES) {
        // Too few alerts → lower bar
        next = Math.max(MIN_THRESHOLD, effective - ADJUST_STEP);
        adjusted = true;
        logger.info(`[Threshold] Too few matches (${matchedLastRun}) → lowering to ${next}`);
    }

    if (adjusted) await saveEffective(kv, next);

    return { effective: next, base: configThreshold, adjusted };
}

/**
 * Batch record multiple job scores with a single KV write.
 * Reduces KV writes from N (per job) to 1 (per batch).
 * 
 * @param {KVNamespace} kv
 * @param {number[]} scores - Array of scores to record
 */
export async function recordJobScoresBatch(kv, scores) {
    if (!scores || scores.length === 0) return;
    
    const window = await readWindow(kv);
    // Add all scores at once
    window.push(...scores);
    // Keep only the last WINDOW_SIZE entries
    if (window.length > WINDOW_SIZE) window.splice(0, window.length - WINDOW_SIZE);
    // Single KV write for all scores
    await saveWindow(kv, window);
}
