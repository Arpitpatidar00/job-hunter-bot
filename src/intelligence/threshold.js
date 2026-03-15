/**
 * @module threshold
 * @description Dynamic notification threshold engine.
 *
 * ARCHITECTURE FIX (Issue #1): Moved from KV to D1.
 * Eliminates ~192 KV writes/day (thresh:window + metrics:score_histogram).
 *
 * Problem: A static threshold can't adapt to feed quality shifts.
 * Solution: Rolling window of last N scores in D1 `threshold_state` table.
 * Auto-adjust threshold to maintain healthy match rate (3–8 per run).
 *
 * Score histogram now uses D1 `score_histogram` table instead of KV.
 */

import logger from "../core/logger.js";

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

/** D1 keys for threshold_state table. */
const WINDOW_KEY = "thresh:window";
const EFFECTIVE_KEY = "thresh:effective";

/** In-memory cache for threshold values to reduce D1 reads */
let _cachedEffective = null;
let _cachedWindow = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayUTC() {
    return new Date().toISOString().split("T")[0];
}

async function readWindow(db) {
    if (_cachedWindow !== null) return _cachedWindow;

    try {
        const row = await db
            .prepare(`SELECT value FROM threshold_state WHERE key = ?`)
            .bind(WINDOW_KEY)
            .first();
        _cachedWindow = row ? JSON.parse(row.value) : [];
        return _cachedWindow;
    } catch {
        return [];
    }
}

async function saveWindow(db, window) {
    _cachedWindow = window;

    try {
        await db
            .prepare(
                `INSERT INTO threshold_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            )
            .bind(WINDOW_KEY, JSON.stringify(window))
            .run();
    } catch (err) {
        logger.warn(`[Threshold] Failed to save score window to D1: ${err.message}`);
    }
}

async function readEffective(db, configDefault) {
    if (_cachedEffective !== null) return _cachedEffective;

    try {
        const row = await db
            .prepare(`SELECT value FROM threshold_state WHERE key = ?`)
            .bind(EFFECTIVE_KEY)
            .first();
        _cachedEffective = row ? parseInt(row.value, 10) : configDefault;
        return _cachedEffective;
    } catch {
        return configDefault;
    }
}

async function saveEffective(db, value) {
    // Only write to D1 if value actually changed significantly
    if (_cachedEffective !== null && Math.abs(_cachedEffective - value) < 2) {
        return;
    }

    _cachedEffective = value;

    try {
        await db
            .prepare(
                `INSERT INTO threshold_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            )
            .bind(EFFECTIVE_KEY, String(value))
            .run();
    } catch (err) {
        logger.warn(
            `[Threshold] Failed to save effective threshold to D1: ${err.message}`,
        );
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Push a newly evaluated job score into the rolling window.
 * CHANGED: Now takes D1 db instead of KV.
 *
 * @param {D1Database} db
 * @param {number} score
 */
export async function recordJobScore(db, score) {
    const window = await readWindow(db);
    window.push(score);
    if (window.length > WINDOW_SIZE)
        window.splice(0, window.length - WINDOW_SIZE);
    await saveWindow(db, window);
}

/**
 * Compute statistics from the rolling window.
 * CHANGED: Now takes D1 db instead of KV.
 *
 * @param {D1Database} db
 * @returns {Promise<{ mean: number, p75: number, p90: number, sampleSize: number }>}
 */
export async function computeWindowStats(db) {
    const window = await readWindow(db);
    if (!window.length)
        return { mean: null, p75: null, p90: null, sampleSize: 0 };

    const sorted = [...window].sort((a, b) => a - b);
    const mean = Math.round(window.reduce((s, v) => s + v, 0) / window.length);
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];

    return { mean, p75, p90, sampleSize: window.length };
}

/**
 * Get the current effective threshold, applying auto-adjustment.
 * CHANGED: Now takes D1 db instead of KV.
 *
 * @param {D1Database} db
 * @param {number} configThreshold - Base threshold from config.
 * @param {{ matchedLastRun?: number }} context
 * @returns {Promise<{ effective: number, base: number, adjusted: boolean }>}
 */
export async function getEffectiveThreshold(db, configThreshold, context = {}) {
    const effective = await readEffective(db, configThreshold);
    const { matchedLastRun } = context;

    if (matchedLastRun === undefined || matchedLastRun === null) {
        return { effective, base: configThreshold, adjusted: false };
    }

    let next = effective;
    let adjusted = false;

    if (matchedLastRun > TARGET_MAX_MATCHES) {
        next = Math.min(MAX_THRESHOLD, effective + ADJUST_STEP);
        adjusted = true;
        logger.info(
            `[Threshold] Too many matches (${matchedLastRun}) → raising to ${next}`,
        );
    } else if (matchedLastRun < TARGET_MIN_MATCHES) {
        next = Math.max(MIN_THRESHOLD, effective - ADJUST_STEP);
        adjusted = true;
        logger.info(
            `[Threshold] Too few matches (${matchedLastRun}) → lowering to ${next}`,
        );
    }

    if (adjusted) await saveEffective(db, next);

    return { effective: next, base: configThreshold, adjusted };
}

/**
 * Batch record multiple job scores with a single D1 write.
 * Also updates the score histogram in D1 (replaces KV histogram).
 *
 * CHANGED: Now takes D1 db instead of KV.
 * Eliminates 2 KV reads + 2 KV writes per evaluateJobs batch.
 *
 * @param {D1Database} db
 * @param {number[]} scores - Array of scores to record
 */
export async function recordJobScoresBatch(db, scores) {
    if (!scores || scores.length === 0) return;

    // Add all scores to the rolling window
    const window = await readWindow(db);
    window.push(...scores);

    if (window.length > WINDOW_SIZE)
        window.splice(0, window.length - WINDOW_SIZE);

    // Save window to D1
    await saveWindow(db, window);

    // Update score histogram in D1 (replaces KV read-modify-write)
    try {
        const date = todayUTC();
        const bucketCounts = {};
        for (const s of scores) {
            const bucket = Math.floor(Math.max(0, Math.min(99, s)) / 10) * 10;
            bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1;
        }

        const stmts = Object.entries(bucketCounts).map(([bucket, count]) =>
            db
                .prepare(
                    `INSERT INTO score_histogram (date, bucket, count) VALUES (?, ?, ?)
           ON CONFLICT(date, bucket) DO UPDATE SET count = count + ?`,
                )
                .bind(date, parseInt(bucket), count, count),
        );

        if (stmts.length > 0) {
            await db.batch(stmts);
        }
    } catch (err) {
        // Non-critical — histogram is for observability only
        logger.warn(`[Threshold] Score histogram D1 write failed: ${err.message}`);
    }
}

/**
 * Read score histogram from D1 for the daily report.
 * Replaces KV get("metrics:score_histogram").
 *
 * @param {D1Database} db
 * @param {string} [date] - Date to query (defaults to today)
 * @returns {Promise<object>} Histogram object { bucket: count }
 */
export async function getScoreHistogram(db, date) {
    const targetDate = date || todayUTC();
    try {
        const result = await db
            .prepare(`SELECT bucket, count FROM score_histogram WHERE date = ?`)
            .bind(targetDate)
            .all();

        const hist = {};
        if (result.success) {
            for (const row of result.results) {
                hist[row.bucket] = row.count;
            }
        }
        return hist;
    } catch {
        return {};
    }
}
