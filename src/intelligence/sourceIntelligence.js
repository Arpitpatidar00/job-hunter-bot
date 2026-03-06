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
    { tier: 'high', minScore: 65, cycleInterval: 1 },   // Every cron (15 min)
    { tier: 'medium', minScore: 35, cycleInterval: 3 },  // ~45 min
    { tier: 'low', minScore: 10, cycleInterval: 8 },     // ~2 hours
    { tier: 'dormant', minScore: 0, cycleInterval: 16 },  // ~4 hours
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

    // Exploration bonus: new sources (< 10 attempts) get boosted priority
    // to ensure they are crawled frequently before enough data exists to score them.
    if (totalAttempts < 10) {
        // Scale from 70 (brand new) down to 52 as attempts grow
        return Math.round(70 - (totalAttempts * 1.8));
    }

    // 1. Job Yield (25%) — reward sources that produce jobs
    const lastJobCount = source.last_job_count || 0;
    const avgJobCount = source.avg_job_count || 1;
    const yieldRatio = Math.min(lastJobCount / Math.max(avgJobCount, 1), 3); // cap at 3x
    const yieldScore = Math.min(100, yieldRatio * 33.3);

    // 2. Freshness (20%) — gradual decay instead of cliff drops
    let freshnessScore = 50; // default
    if (source.last_new_job_at) {
        const hoursSinceNew = (Date.now() - new Date(source.last_new_job_at).getTime()) / 3_600_000;
        if (hoursSinceNew < 1) freshnessScore = 100;
        else if (hoursSinceNew < 6) freshnessScore = 90;
        else if (hoursSinceNew < 24) freshnessScore = 70;
        else if (hoursSinceNew < 72) freshnessScore = 50;
        else if (hoursSinceNew < 168) freshnessScore = 30; // 7 days
        else freshnessScore = 15;
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

    // Dedup penalty (10%): penalize high-duplication sources
    //    dup_ratio 0.0 = all unique jobs, 1.0 = all duplicates
    const dupRatio = source.dup_ratio || 0;
    // Penalty kicks in above 60% duplication (was 80%). 100% dup → score 0, 60% → score 100
    const dedupScore = dupRatio > 0.6
        ? Math.max(0, 100 - ((dupRatio - 0.6) / 0.4) * 100)
        : 100;

    // Weighted sum (rebalanced: yield 25%, freshness 20%, reliability 20%, consistency 15%, relevance 10%, dedup 10%)
    const priority = Math.round(
        yieldScore * 0.25 +
        freshnessScore * 0.20 +
        reliabilityScore * 0.20 +
        consistencyScore * 0.15 +
        relevanceScore * 0.10 +
        dedupScore * 0.10
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
                    total_jobs_found, consecutive_failures, dup_ratio
             FROM source_registry WHERE enabled = 1`
        ).all();

        if (!result.success || !result.results?.length) return 0;

        const stmts = [];
        for (const source of result.results) {
            // Auto-disable sources with too many consecutive failures (raised from 10 to 20)
            if ((source.consecutive_failures || 0) >= 20) {
                stmts.push(
                    db.prepare(`UPDATE source_registry SET enabled = 0, crawl_tier = 'disabled' WHERE url = ?`)
                        .bind(source.url)
                );
                logger.warn(`[Intelligence] Auto-disabled source after 20 consecutive failures: ${source.url}`);
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

        // Periodic re-enable: give disabled sources another chance every 48 hours
        try {
            const reEnableResult = await db.prepare(
                `UPDATE source_registry
                 SET enabled = 1, consecutive_failures = 0, crawl_tier = 'low', priority_score = 40
                 WHERE enabled = 0
                   AND crawl_tier = 'disabled'
                   AND last_fetched_at < datetime('now', '-48 hours')`
            ).run();
            const reEnabled = reEnableResult?.meta?.changes || 0;
            if (reEnabled > 0) {
                logger.info(`[Intelligence] Re-enabled ${reEnabled} previously disabled sources for retry`);
            }
        } catch (reErr) {
            logger.warn(`[Intelligence] Re-enable check failed: ${reErr.message}`);
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
        // For others, check if cycleNumber aligns with their interval (updated intervals)
        const result = await db.prepare(
            `SELECT url, type, name, priority_score, crawl_tier
             FROM source_registry
             WHERE enabled = 1
               AND (
                   crawl_tier = 'high'
                   OR (crawl_tier = 'medium' AND ? % 3 = 0)
                   OR (crawl_tier = 'low'    AND ? % 8 = 0)
                   OR (crawl_tier = 'dormant' AND ? % 16 = 0)
                   OR crawl_tier IS NULL
                   OR priority_score IS NULL
               )`
        ).bind(cycleNumber, cycleNumber, cycleNumber).all();

        const tieredSources = result.success ? result.results : [];

        // Exploration slot reservation: always include recently discovered sources
        // (< 48 hours old) regardless of their tier, up to 5 per cycle.
        // This ensures new sources get a fair crawl window before scoring kicks in.
        let explorationSources = [];
        try {
            const explorationResult = await db.prepare(
                `SELECT url, type, name, priority_score, crawl_tier
                 FROM source_registry
                 WHERE enabled = 1
                   AND discovered_at > datetime('now', '-72 hours')
                 ORDER BY discovered_at DESC
                 LIMIT 5`
            ).all();
            explorationSources = explorationResult.success ? explorationResult.results : [];
        } catch (expErr) {
            logger.warn(`[Intelligence] Exploration slot query failed: ${expErr.message}`);
        }

        // Merge tiered + exploration sources, deduplicating by URL
        const seenUrls = new Set(tieredSources.map(s => s.url));
        for (const src of explorationSources) {
            if (!seenUrls.has(src.url)) {
                tieredSources.push(src);
                seenUrls.add(src.url);
            }
        }

        return tieredSources;
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
export async function recordSourceYield(db, url, newJobCount, totalJobCount, dupRatio = 0) {
    try {
        // Update running average: new_avg = old_avg * 0.7 + current * 0.3 (exponential moving average)
        // Also track duplication ratio for priority scoring penalty
        await db.prepare(
            `UPDATE source_registry
             SET total_jobs_found = total_jobs_found + ?,
                 avg_job_count = COALESCE(avg_job_count, 0) * 0.7 + ? * 0.3,
                 last_new_job_at = CASE WHEN ? > 0 THEN CURRENT_TIMESTAMP ELSE last_new_job_at END,
                 posting_frequency = COALESCE(posting_frequency, 0) * 0.8 + ? * 0.2,
                 dup_ratio = COALESCE(dup_ratio, 0) * 0.6 + ? * 0.4
             WHERE url = ?`
        ).bind(newJobCount, totalJobCount, newJobCount, newJobCount, dupRatio, url).run();
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

// ── Hiring Velocity Surge Detection ─────────────────────────────────────────

/**
 * Detect sources experiencing a hiring velocity surge (>30% job volume
 * increase vs their rolling average). Promotes surging sources to 'high'
 * tier and adds a +15 priority bonus to accelerate crawling.
 *
 * @param {D1Database} db
 * @returns {Promise<number>} Number of sources promoted.
 */
export async function detectHiringVelocitySurge(db) {
    try {
        const result = await db.prepare(
            `SELECT url, last_job_count, avg_job_count, crawl_tier
             FROM source_registry
             WHERE enabled = 1
               AND avg_job_count > 0
               AND last_job_count > avg_job_count * 1.30
               AND crawl_tier != 'high'`
        ).all();

        if (!result.success || !result.results?.length) return 0;

        const stmts = result.results.map(src =>
            db.prepare(
                `UPDATE source_registry
                 SET crawl_tier = 'high',
                     priority_score = MIN(100, priority_score + 15)
                 WHERE url = ?`
            ).bind(src.url)
        );

        for (let i = 0; i < stmts.length; i += 100) {
            await db.batch(stmts.slice(i, i + 100));
        }

        if (stmts.length > 0) {
            logger.info(`[Intelligence] Hiring surge: promoted ${stmts.length} source(s) to 'high' tier`);
        }

        return stmts.length;
    } catch (err) {
        logger.warn(`[Intelligence] Hiring velocity surge detection failed: ${err.message}`);
        return 0;
    }
}

// ── Skill Trend Spike Detection ──────────────────────────────────────────────

/**
 * Compare this week's skill counts vs last week using daily_metrics.
 * Skills with ≥20% growth (or newly appearing with ≥5 occurrences) are
 * flagged in KV as `trend:spike:<skill>` with a 7-day TTL.
 * The searchExpander and growthEngine read these flags to focus queries.
 *
 * @param {D1Database} db
 * @param {KVNamespace} kv
 * @returns {Promise<string[]>} List of spiking skill names.
 */
export async function detectTrendTrigger(db, kv) {
    try {
        const result = await db.prepare(
            `SELECT date, skill_counts
             FROM daily_metrics
             WHERE date >= date('now', '-14 days')
             ORDER BY date DESC`
        ).all();

        if (!result.success || !result.results?.length) return [];

        const today = new Date().toISOString().slice(0, 10);
        const thisWeek = {};
        const lastWeek = {};

        for (const row of result.results) {
            const daysAgo = Math.round(
                (new Date(today).getTime() - new Date(row.date).getTime()) / 86_400_000
            );
            let counts = {};
            try { counts = JSON.parse(row.skill_counts || '{}'); } catch { continue; }

            const target = daysAgo <= 7 ? thisWeek : lastWeek;
            for (const [skill, count] of Object.entries(counts)) {
                target[skill] = (target[skill] || 0) + count;
            }
        }

        const spikingSkills = [];

        for (const [skill, currentCount] of Object.entries(thisWeek)) {
            const previousCount = lastWeek[skill] || 0;
            if (previousCount === 0 && currentCount >= 5) {
                spikingSkills.push(skill); // New skill with meaningful volume
            } else if (previousCount > 0) {
                const growthPct = ((currentCount - previousCount) / previousCount) * 100;
                if (growthPct >= 20) spikingSkills.push(skill);
            }
        }

        if (spikingSkills.length > 0 && kv) {
            const writes = spikingSkills.map(skill =>
                kv.put(`trend:spike:${skill.toLowerCase()}`, '1', { expirationTtl: 7 * 24 * 60 * 60 })
                    .catch(e => logger.warn(`[Intelligence] KV spike write failed for ${skill}: ${e.message}`))
            );
            await Promise.allSettled(writes);
            logger.info(`[Intelligence] Skill spikes detected: ${spikingSkills.join(', ')}`);
        }

        return spikingSkills;
    } catch (err) {
        logger.warn(`[Intelligence] Trend trigger detection failed: ${err.message}`);
        return [];
    }
}
