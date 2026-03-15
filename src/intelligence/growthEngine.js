/**
 * @module growthEngine
 * @description Growth amplification engine — Layer 5 of the discovery pipeline.
 *
 * Detects and surfaces growth signals from the jobs and metrics data:
 *   - detectSkillSpikes      — skills trending week-over-week in new postings
 *   - detectHiringSurge      — companies posting 5+ jobs in 7 days
 *   - scoreCompanyMomentum   — composite momentum score per company
 *   - persistGrowthSignals   — writes results to trend_clusters + company_momentum tables
 */

import logger from '../core/logger.js';

// ── Skill Spike Detection ─────────────────────────────────────────────────────

/**
 * @typedef {object} SkillSpike
 * @property {string} skill
 * @property {number} thisWeekCount
 * @property {number} lastWeekCount
 * @property {number} growthPct
 */

/**
 * Detect skills with ≥20% week-over-week growth using daily_metrics.
 * Reads the last 14 days of skill_counts JSON blobs.
 *
 * @param {D1Database} db
 * @returns {Promise<SkillSpike[]>}
 */
export async function detectSkillSpikes(db) {
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

        /** @type {SkillSpike[]} */
        const spikes = [];

        for (const [skill, currentCount] of Object.entries(thisWeek)) {
            const previousCount = lastWeek[skill] || 0;
            let growthPct = 0;

            if (previousCount === 0 && currentCount >= 5) {
                growthPct = 100; // Treat as 100% new
            } else if (previousCount > 0) {
                growthPct = ((currentCount - previousCount) / previousCount) * 100;
            }

            if (growthPct >= 20) {
                spikes.push({ skill, thisWeekCount: currentCount, lastWeekCount: previousCount, growthPct });
            }
        }

        logger.info(`[GrowthEngine] Skill spikes detected: ${spikes.length} skills (${spikes.map(s => s.skill).join(', ')})`);
        return spikes;
    } catch (err) {
        logger.warn(`[GrowthEngine] detectSkillSpikes failed: ${err.message}`);
        return [];
    }
}

// ── Hiring Surge Detection ────────────────────────────────────────────────────

/**
 * @typedef {object} HiringSurge
 * @property {string} company
 * @property {number} jobCount
 * @property {string} lastPostAt
 */

/**
 * Find companies that have posted ≥5 jobs in the last 7 days.
 * These are marked as "Expansion Mode" and written to company_momentum.
 *
 * @param {D1Database} db
 * @returns {Promise<HiringSurge[]>}
 */
export async function detectHiringSurge(db) {
    try {
        const result = await db.prepare(
            `SELECT company,
                    COUNT(*) as job_count,
                    MAX(fetched_at) as last_post_at
             FROM jobs
             WHERE fetched_at >= datetime('now', '-7 days')
               AND company != ''
             GROUP BY company
             HAVING job_count >= 5
             ORDER BY job_count DESC
             LIMIT 50`
        ).all();

        if (!result.success || !result.results?.length) return [];

        const surges = result.results.map(row => ({
            company: row.company,
            jobCount: row.job_count,
            lastPostAt: row.last_post_at,
        }));

        logger.info(`[GrowthEngine] Hiring surges detected: ${surges.length} companies`);
        return surges;
    } catch (err) {
        logger.warn(`[GrowthEngine] detectHiringSurge failed: ${err.message}`);
        return [];
    }
}

// ── Company Momentum Scoring ──────────────────────────────────────────────────

/**
 * Compute a 0–100 momentum score for a company from its posting frequency
 * and recent job count. Higher frequency + recent activity = higher score.
 *
 * @param {{ jobCount: number, lastPostAt: string }} surgeData
 * @returns {number} 0–100 momentum score
 */
export function scoreCompanyMomentum(surgeData) {
    const { jobCount, lastPostAt } = surgeData;

    // Frequency score: 5+ jobs = 40 pts, scales up to 80 pts at 20+ jobs
    const frequencyScore = Math.min(80, (jobCount / 20) * 80);

    // Recency score: 0–20 pts, full 20 pts if posted within 24hr
    let recencyScore = 0;
    if (lastPostAt) {
        const hoursAgo = (Date.now() - new Date(lastPostAt).getTime()) / 3_600_000;
        if (hoursAgo < 24) recencyScore = 20;
        else if (hoursAgo < 72) recencyScore = 12;
        else if (hoursAgo < 168) recencyScore = 6;
    }

    return Math.min(100, Math.round(frequencyScore + recencyScore));
}

// ── Persist Growth Signals ────────────────────────────────────────────────────

/**
 * Write detected skill spikes and hiring surges to the DB.
 * Upserts into trend_clusters and company_momentum tables.
 *
 * @param {D1Database} db
 * @param {SkillSpike[]} skillSpikes
 * @param {HiringSurge[]} hiringSurges
 * @returns {Promise<{ spikesSaved: number, surgesSaved: number }>}
 */
export async function persistGrowthSignals(db, skillSpikes, hiringSurges) {
    let spikesSaved = 0;
    let surgesSaved = 0;

    try {
        // ── Skill spikes → trend_clusters ─────────────────────────────────────
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
        const weekStartStr = weekStart.toISOString().slice(0, 10);

        const spikeStmts = skillSpikes.map(spike =>
            db.prepare(
                `INSERT INTO trend_clusters (skill, week_start, job_count, growth_pct)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(skill, week_start) DO UPDATE SET
                   job_count  = excluded.job_count,
                   growth_pct = excluded.growth_pct`
            ).bind(spike.skill, weekStartStr, spike.thisWeekCount, Math.round(spike.growthPct))
        );

        // ── Hiring surges → company_momentum ──────────────────────────────────
        const surgeStmts = hiringSurges.map(surge => {
            const momentumScore = scoreCompanyMomentum(surge);
            return db.prepare(
                `INSERT INTO company_momentum (company, posting_count, last_post_at, momentum_score, is_surging, updated_at)
                 VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
                 ON CONFLICT(company) DO UPDATE SET
                   posting_count  = excluded.posting_count,
                   last_post_at   = excluded.last_post_at,
                   momentum_score = excluded.momentum_score,
                   is_surging     = 1,
                   updated_at     = CURRENT_TIMESTAMP`
            ).bind(surge.company, surge.jobCount, surge.lastPostAt, momentumScore);
        });

        // Batch in groups of 40 (D1 limit is ~50, use 40 for safety)
        const allStmts = [...spikeStmts, ...surgeStmts];
        for (let i = 0; i < allStmts.length; i += 40) {
            await db.batch(allStmts.slice(i, i + 40));
        }

        spikesSaved = spikeStmts.length;
        surgesSaved = surgeStmts.length;

        logger.info(`[GrowthEngine] Persisted ${spikesSaved} skill spikes, ${surgesSaved} hiring surges`);
    } catch (err) {
        logger.warn(`[GrowthEngine] persistGrowthSignals failed: ${err.message}`);
    }

    return { spikesSaved, surgesSaved };
}

// ── Run Full Growth Engine Cycle ──────────────────────────────────────────────

/**
 * Run a full growth engine cycle: detect spikes + surges, persist results.
 * Call once per cron cycle (or less frequently via cycle-number modulo).
 *
 * @param {D1Database} db
 * @returns {Promise<{ skillSpikes: SkillSpike[], hiringSurges: HiringSurge[], spikesSaved: number, surgesSaved: number }>}
 */
export async function runGrowthEngineCycle(db) {
    const [skillSpikes, hiringSurges] = await Promise.all([
        detectSkillSpikes(db),
        detectHiringSurge(db),
    ]);

    const { spikesSaved, surgesSaved } = await persistGrowthSignals(db, skillSpikes, hiringSurges);

    return { skillSpikes, hiringSurges, spikesSaved, surgesSaved };
}
