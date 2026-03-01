/**
 * @module sourceIntelligence
 * @description Priority-based source scoring and adaptive crawl scheduling.
 *
 * Each source gets a dynamic priority score (0–100) that determines its
 * crawl tier (high / medium / low / dormant). Only sources due for
 * crawling in the current cycle are dispatched.
 *
 * Score formula:
 *   - Job yield       (30%) — recent job count vs historical average
 *   - Freshness       (25%) — time since last new job was found
 *   - Reliability     (20%) — success rate (success / total attempts)
 *   - Consistency     (15%) — low variance in job counts
 *   - Relevance       (10%) — % of jobs that scored above threshold
 */

import logger from '../core/logger.js';

// ── Crawl Tier Definitions ──────────────────────────────────────────────────

/** @type {Array<{tier: string, minScore: number, cycleInterval: number}>} */
const CRAWL_TIERS = [
    { tier: 'high', minScore: 70, cycleInterval: 1 },  // Every cron (15 min)
    { tier: 'medium', minScore: 40, cycleInterval: 4 },  // ~1 hour
    { tier: 'low', minScore: 10, cycleInterval: 12 },  // ~3 hours
    { tier: 'dormant', minScore: 0, cycleInterval: 24 },  // ~6 hours
];

/**
 * Determine crawl tier from a priority score.
 * @param {number} score
 * @returns {{ tier: string, cycleInterval: number }}
 */
export function assignTier(score) {
    for (const t of CRAWL_TIERS) {
        if (score >= t.minScore) return { tier: t.tier, cycleInterval: t.cycleInterval };
    }
    return { tier: 'dormant', cycleInterval: 24 };
}

// ── Priority Scoring ────────────────────────────────────────────────────────

/**
 * Calculate priority score for a single source based on its stats.
 *
 * @param {object} source - Source row from D1 source_registry.
 * @returns {number} Priority score 0–100.
 */
export function calculatePriority(source) {
    const totalAttempts = (source.success_count || 0) + (source.failure_count || 0);
    if (totalAttempts === 0) return 50; // New source gets default medium priority

    // 1. Job Yield (30%) — reward sources that produce jobs
    const lastJobCount = source.last_job_count || 0;
    const avgJobCount = source.avg_job_count || 1;
    const yieldRatio = Math.min(lastJobCount / Math.max(avgJobCount, 1), 3); // cap at 3x
    const yieldScore = Math.min(100, yieldRatio * 33.3);

    // 2. Freshness (25%) — how recently did this source produce new jobs
    let freshnessScore = 50; // default
    if (source.last_new_job_at) {
        const hoursSinceNew = (Date.now() - new Date(source.last_new_job_at).getTime()) / 3_600_000;
        if (hoursSinceNew < 1) freshnessScore = 100;
        else if (hoursSinceNew < 6) freshnessScore = 80;
        else if (hoursSinceNew < 24) freshnessScore = 60;
        else if (hoursSinceNew < 72) freshnessScore = 30;
        else freshnessScore = 10;
    }

    // 3. Reliability (20%) — success rate
    const successRate = totalAttempts > 0 ? (source.success_count || 0) / totalAttempts : 0.5;
    const reliabilityScore = successRate * 100;

    // 4. Consistency (15%) — penalize sources with zero jobs most times
    const totalJobsFound = source.total_jobs_found || 0;
    const avgYieldPerFetch = totalAttempts > 0 ? totalJobsFound / totalAttempts : 0;
    const consistencyScore = Math.min(100, avgYieldPerFetch * 10); // 10+ avg → 100

    // 5. Relevance (10%) — posting frequency as proxy
    const postingFreq = source.posting_frequency || 0;
    const relevanceScore = Math.min(100, postingFreq * 20); // 5+ per day → 100

    // Weighted sum
    const priority = Math.round(
        yieldScore * 0.30 +
        freshnessScore * 0.25 +
        reliabilityScore * 0.20 +
        consistencyScore * 0.15 +
        relevanceScore * 0.10
    );

    return Math.max(0, Math.min(100, priority));
}

// ── Batch Recalculation ─────────────────────────────────────────────────────

/**
 * Recalculate priority scores and crawl tiers for all enabled sources.
 *
 * @param {D1Database} db
 * @returns {Promise<number>} Number of sources updated.
 */
export async function recalculatePriorities(db) {
    try {
        const result = await db.prepare(
            `SELECT url, type, success_count, failure_count, last_job_count,
                    avg_job_count, posting_frequency, last_new_job_at,
                    total_jobs_found, consecutive_failures
             FROM source_registry WHERE enabled = 1`
        ).all();

        if (!result.success || !result.results?.length) return 0;

        const stmts = [];
        for (const source of result.results) {
            // Auto-disable sources with too many consecutive failures
            if ((source.consecutive_failures || 0) >= 10) {
                stmts.push(
                    db.prepare(`UPDATE source_registry SET enabled = 0, crawl_tier = 'disabled' WHERE url = ?`)
                        .bind(source.url)
                );
                logger.warn(`[Intelligence] Auto-disabled source after 10 consecutive failures: ${source.url}`);
                continue;
            }

            const score = calculatePriority(source);
            const { tier, cycleInterval } = assignTier(score);
            const nextCrawlAt = new Date(Date.now() + cycleInterval * 15 * 60_000).toISOString();

            stmts.push(
                db.prepare(
                    `UPDATE source_registry
                     SET priority_score = ?, crawl_tier = ?, next_crawl_at = ?
                     WHERE url = ?`
                ).bind(score, tier, nextCrawlAt, source.url)
            );
        }

        // D1 batch (max 100 statements per batch)
        for (let i = 0; i < stmts.length; i += 100) {
            await db.batch(stmts.slice(i, i + 100));
        }

        logger.info(`[Intelligence] Recalculated priorities for ${stmts.length} sources`);
        return stmts.length;
    } catch (err) {
        logger.error(`[Intelligence] Priority recalculation failed: ${err.message}`);
        return 0;
    }
}

// ── Cycle-Based Source Selection ─────────────────────────────────────────────

/**
 * Get sources that are due for crawling in the current cycle.
 * High-tier sources are always included. Lower tiers are included
 * only when their cycle interval aligns.
 *
 * @param {D1Database} db
 * @param {number} cycleNumber - Monotonically increasing cron counter.
 * @returns {Promise<object[]>} Sources to crawl this cycle.
 */
export async function getSourcesForCycle(db, cycleNumber) {
    try {
        // Always fetch high-priority sources
        // For others, check if cycleNumber aligns with their interval
        const result = await db.prepare(
            `SELECT url, type, name, priority_score, crawl_tier
             FROM source_registry
             WHERE enabled = 1
               AND (
                   crawl_tier = 'high'
                   OR (crawl_tier = 'medium' AND ? % 4 = 0)
                   OR (crawl_tier = 'low'    AND ? % 12 = 0)
                   OR (crawl_tier = 'dormant' AND ? % 24 = 0)
                   OR crawl_tier IS NULL
                   OR priority_score IS NULL
               )`
        ).bind(cycleNumber, cycleNumber, cycleNumber).all();

        return result.success ? result.results : [];
    } catch (err) {
        logger.warn(`[Intelligence] Failed to get sources for cycle ${cycleNumber}: ${err.message}`);
        return [];
    }
}

/**
 * Record the yield of a source after a successful fetch.
 * Updates running averages and posting frequency.
 *
 * @param {D1Database} db
 * @param {string} url
 * @param {number} newJobCount - Number of NEW (not duplicate) jobs found.
 * @param {number} totalJobCount - Total jobs returned by the source.
 */
export async function recordSourceYield(db, url, newJobCount, totalJobCount) {
    try {
        // Update running average: new_avg = old_avg * 0.7 + current * 0.3 (exponential moving average)
        await db.prepare(
            `UPDATE source_registry
             SET total_jobs_found = total_jobs_found + ?,
                 avg_job_count = COALESCE(avg_job_count, 0) * 0.7 + ? * 0.3,
                 last_new_job_at = CASE WHEN ? > 0 THEN CURRENT_TIMESTAMP ELSE last_new_job_at END,
                 posting_frequency = COALESCE(posting_frequency, 0) * 0.8 + ? * 0.2
             WHERE url = ?`
        ).bind(newJobCount, totalJobCount, newJobCount, newJobCount, url).run();
    } catch (err) {
        logger.warn(`[Intelligence] Failed to record yield for ${url}: ${err.message}`);
    }
}

/**
 * Get the current cycle number from KV, incrementing it.
 *
 * @param {KVNamespace} kv
 * @returns {Promise<number>}
 */
export async function getAndIncrementCycle(kv) {
    try {
        const raw = await kv.get('__cycle_number');
        const current = parseInt(raw || '0', 10);
        const next = current + 1;
        await kv.put('__cycle_number', String(next));
        return next;
    } catch {
        return 1;
    }
}
