/**
 * @module db/sources
 * @description Source registry CRUD — discovery, stats, metrics.
 */

import logger from '../core/logger.js';

/**
 * Register a newly discovered source in the D1 registry.
 *
 * @param {D1Database} db
 * @param {object} source - { url, type, name, enabled, discovery_origin }
 */
export async function registerDiscoveredSource(db, source) {
    try {
        await db.prepare(
            `INSERT OR IGNORE INTO source_registry (url, type, name, enabled, discovery_origin)
             VALUES (?, ?, ?, ?, ?)`
        ).bind(
            source.url,
            source.type || 'rss',
            source.name || '',
            source.enabled !== false ? 1 : 0,
            source.discovery_origin || 'manual'
        ).run();
    } catch (err) {
        logger.error(`[D1] Failed to register source ${source.url}: ${err.message}`);
    }
}

/**
 * Fetch all enabled sources from the registry.
 *
 * @param {D1Database} db
 * @returns {Promise<object[]>}
 */
export async function getEnabledSources(db) {
    try {
        const result = await db.prepare(
            `SELECT url, type, name, enabled, discovery_origin, success_count, failure_count
             FROM source_registry WHERE enabled = 1`
        ).all();
        return result.success ? result.results : [];
    } catch (err) {
        logger.warn(`[D1] Failed to fetch enabled sources: ${err.message}`);
        return [];
    }
}

/**
 * Update stats for a source after a fetch attempt.
 *
 * @param {D1Database} db
 * @param {string} url
 * @param {{ success: boolean, jobCount: number }} stats
 */
export async function updateSourceStats(db, url, { success, jobCount }) {
    try {
        if (success) {
            await db.prepare(
                `UPDATE source_registry
                 SET success_count = success_count + 1,
                     consecutive_failures = 0,
                     last_fetched_at = CURRENT_TIMESTAMP,
                     last_job_count = ?
                 WHERE url = ?`
            ).bind(jobCount, url).run();
        } else {
            await db.prepare(
                `UPDATE source_registry
                 SET failure_count = failure_count + 1,
                     consecutive_failures = consecutive_failures + 1,
                     last_fetched_at = CURRENT_TIMESTAMP
                 WHERE url = ?`
            ).bind(url).run();
        }
    } catch (err) {
        logger.warn(`[D1] Failed to update source stats for ${url}: ${err.message}`);
    }
}

/**
 * Disable a source that has exceeded the failure threshold.
 *
 * @param {D1Database} db
 * @param {string} url
 */
export async function disableUnreliableSource(db, url) {
    try {
        await db.prepare(
            `UPDATE source_registry SET enabled = 0 WHERE url = ?`
        ).bind(url).run();
        logger.warn(`[D1] Disabled unreliable source: ${url}`);
    } catch (err) {
        logger.error(`[D1] Failed to disable source ${url}: ${err.message}`);
    }
}

/**
 * Get aggregate metrics for the /metrics endpoint.
 *
 * @param {D1Database} db
 * @returns {Promise<object>}
 */
export async function getSourceMetrics(db) {
    try {
        const [sourcesRes, jobCountRes, totalDocsRes] = await db.batch([
            db.prepare(
                `SELECT type,
                        COUNT(*) as source_count,
                        SUM(success_count) as total_successes,
                        SUM(failure_count) as total_failures,
                        SUM(last_job_count) as latest_job_volume,
                        SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled_count
                 FROM source_registry
                 GROUP BY type`
            ),
            db.prepare(`SELECT COUNT(*) as total FROM jobs`),
            db.prepare(`SELECT value FROM scoring_meta WHERE key = 'total_documents'`),
        ]);

        return {
            sourcesByType: sourcesRes.results || [],
            totalJobsInDb: jobCountRes.results?.[0]?.total || 0,
            totalDocumentsProcessed: totalDocsRes.results?.[0]?.value || 0,
        };
    } catch (err) {
        logger.warn(`[D1] Failed to get metrics: ${err.message}`);
        return { sourcesByType: [], totalJobsInDb: 0, totalDocumentsProcessed: 0 };
    }
}
