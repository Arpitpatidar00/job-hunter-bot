/**
 * @module db/jobs
 * @description Job CRUD operations — insert, dedup, cleanup.
 */

import logger from '../core/logger.js';

/**
 * Attempt to insert a fetched job into the D1 database.
 * If the URL or Content Hash already exists, it is silently ignored (deduplicated).
 *
 * @param {D1Database} db
 * @param {object} job - RawJob object with id, url, and content_hash
 * @returns {Promise<{ inserted: boolean }>}
 */
export async function insertJobIfNotExists(db, job) {
    const url = job.url || job.link || job.id;
    const contentHash = job.content_hash || url || '';

    if (!url) {
        logger.warn(`[D1] Skipping job insertion: Missing url for "${job.title}"`);
        return { inserted: false };
    }

    try {
        const result = await db.prepare(
            `INSERT OR IGNORE INTO jobs (id, url, content_hash, title, company)
             VALUES (?, ?, ?, ?, ?)`
        ).bind(
            job.id || url,
            url,
            contentHash,
            job.title,
            job.company || ''
        ).run();

        const inserted = result.success && result.meta.changes > 0;
        return { inserted };
    } catch (err) {
        logger.error(`[D1] Failed to insert job "${job.title}": ${err.message}`);
        return { inserted: false };
    }
}

/**
 * Delete stale jobs older than the given number of days.
 *
 * @param {D1Database} db
 * @param {number} [maxAgeDays=30]
 * @returns {Promise<number>} Number of jobs cleaned up.
 */
export async function cleanupStaleJobs(db, maxAgeDays = 30) {
    try {
        const result = await db.prepare(
            `DELETE FROM jobs WHERE fetched_at < datetime('now', '-' || ? || ' days')`
        ).bind(maxAgeDays).run();

        const deleted = result.meta?.changes || 0;
        if (deleted > 0) {
            logger.info(`[D1] Cleaned up ${deleted} stale jobs (>${maxAgeDays} days old)`);
        }
        return deleted;
    } catch (err) {
        logger.error(`[D1] Failed to cleanup stale jobs: ${err.message}`);
        return 0;
    }
}
