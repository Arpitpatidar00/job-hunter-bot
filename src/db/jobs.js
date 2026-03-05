/**
 * @module db/jobs
 * @description Job CRUD operations — insert, dedup, cleanup.
 * 
 * CRITICAL FIX: Uses db.batch() to stay within Cloudflare D1's
 * ~50 queries-per-invocation soft limit. All multi-row operations
 * are chunked into batches of ≤50 statements.
 */

import logger from '../core/logger.js';

/** Max statements per db.batch() call to stay under D1 limits. */
const D1_BATCH_CHUNK = 40;

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
 * BATCH INSERT: Insert many jobs in a single db.batch() call.
 * Uses INSERT OR IGNORE for dedup — no separate dedup queries needed.
 * Returns which jobs were actually inserted (new) vs duplicates.
 *
 * @param {D1Database} db
 * @param {object[]} jobs - Array of RawJob objects
 * @returns {Promise<{ inserted: object[], duplicates: number }>}
 */
export async function batchInsertJobs(db, jobs) {
    if (!jobs || jobs.length === 0) return { inserted: [], duplicates: 0 };

    const validJobs = jobs.filter(job => {
        const url = job.url || job.link || job.id;
        if (!url) {
            logger.warn(`[D1] Skipping batch insert: Missing url for "${job.title}"`);
            return false;
        }
        return true;
    });

    if (validJobs.length === 0) return { inserted: [], duplicates: 0 };

    const allInserted = [];
    let totalDuplicates = 0;

    // Process in chunks to stay under D1's query limit
    for (let i = 0; i < validJobs.length; i += D1_BATCH_CHUNK) {
        const chunk = validJobs.slice(i, i + D1_BATCH_CHUNK);

        try {
            const stmts = chunk.map(job => {
                const url = job.url || job.link || job.id;
                const contentHash = job.content_hash || url || '';
                return db.prepare(
                    `INSERT OR IGNORE INTO jobs (id, url, content_hash, title, company)
                     VALUES (?, ?, ?, ?, ?)`
                ).bind(
                    job.id || url,
                    url,
                    contentHash,
                    job.title,
                    job.company || ''
                );
            });

            const results = await db.batch(stmts);

            for (let j = 0; j < results.length; j++) {
                const wasInserted = results[j].success && results[j].meta?.changes > 0;
                if (wasInserted) {
                    allInserted.push(chunk[j]);
                } else {
                    totalDuplicates++;
                }
            }
        } catch (err) {
            logger.error(`[D1] Batch insert chunk failed (${chunk.length} jobs): ${err.message}`);
            // Fall back to individual inserts for this chunk
            for (const job of chunk) {
                const { inserted } = await insertJobIfNotExists(db, job);
                if (inserted) allInserted.push(job);
                else totalDuplicates++;
            }
        }
    }

    if (allInserted.length > 0) {
        logger.info(`[D1] Batch inserted ${allInserted.length} new jobs (${totalDuplicates} dupes) in ${Math.ceil(validJobs.length / D1_BATCH_CHUNK)} batches`);
    }

    return { inserted: allInserted, duplicates: totalDuplicates };
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
