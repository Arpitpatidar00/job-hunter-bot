/**
 * @module db/sources
 * @description Source registry CRUD — discovery, stats, metrics.
 */

import logger from "../core/logger.js";

/**
 * Register a newly discovered source in the D1 registry.
 *
 * @param {D1Database} db
 * @param {object} source - { url, type, name, enabled, discovery_origin }
 */
export async function registerDiscoveredSource(db, source) {
  try {
    const safeUrl = source.url ? decodeURIComponent(source.url) : null;
    const safeName = source.name ? decodeURIComponent(source.name) : "";

    if (!safeUrl) return;

    // Fix 8+10: Source cap with eviction — evict lowest-priority stale source to make room
    const MAX_TOTAL_SOURCES = 10000;
    const countResult = await db
      .prepare("SELECT COUNT(*) as cnt FROM source_registry")
      .first();
    if (countResult && countResult.cnt >= MAX_TOTAL_SOURCES) {
      // Try to evict the worst source before giving up
      try {
        const evictResult = await db.prepare(
          `DELETE FROM source_registry
           WHERE url = (
             SELECT url FROM source_registry
             WHERE enabled = 0
               OR (priority_score < 10 AND last_new_job_at < datetime('now', '-14 days'))
               OR (priority_score IS NULL AND last_fetched_at < datetime('now', '-14 days'))
             ORDER BY priority_score ASC, last_fetched_at ASC
             LIMIT 1
           )`
        ).run();
        const evicted = evictResult?.meta?.changes || 0;
        if (evicted > 0) {
          logger.info(`[D1] Evicted 1 stale source to make room for ${safeUrl}`);
        } else {
          logger.warn(
            `[D1] Source registry at cap (${MAX_TOTAL_SOURCES}), no evictable source, rejecting ${safeUrl}`,
          );
          return;
        }
      } catch (evictErr) {
        logger.warn(`[D1] Source eviction failed: ${evictErr.message}, rejecting ${safeUrl}`);
        return;
      }
    }

    await db
      .prepare(
        `INSERT OR IGNORE INTO source_registry (url, type, name, enabled, discovery_origin, state, ats_platform)
             VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      )
      .bind(
        safeUrl,
        source.type || "rss",
        safeName,
        source.enabled !== false ? 1 : 0,
        source.discovery_origin || "manual",
        source.ats_platform || null,
      )
      .run();
  } catch (err) {
    logger.error(
      `[D1] Failed to register source ${source.url}: ${err.message}`,
    );
  }
}

/**
 * Register multiple newly discovered sources in a single batch.
 *
 * @param {D1Database} db
 * @param {Array<object>} sources
 */
export async function batchRegisterDiscoveredSources(db, sources) {
  if (!sources || sources.length === 0) return;

  try {
    // Fix 5: Enforce 10k source cap before batch insert (mirrors registerDiscoveredSource logic).
    // Evict the oldest stale/low-priority sources to make room for new discoveries.
    const MAX_TOTAL_SOURCES = 10000;
    const countResult = await db
      .prepare("SELECT COUNT(*) as cnt FROM source_registry")
      .first();
    const currentCount = countResult?.cnt || 0;
    const potentialCount = currentCount + sources.length;

    if (potentialCount > MAX_TOTAL_SOURCES) {
      const overflow = potentialCount - MAX_TOTAL_SOURCES;
      try {
        const evictResult = await db
          .prepare(
            `DELETE FROM source_registry
             WHERE url IN (
               SELECT url FROM source_registry
               WHERE enabled = 0
                 OR (priority_score < 10 AND last_new_job_at < datetime('now', '-14 days'))
                 OR (priority_score IS NULL AND last_fetched_at < datetime('now', '-14 days'))
               ORDER BY priority_score ASC, last_fetched_at ASC
               LIMIT ?
             )`,
          )
          .bind(overflow)
          .run();
        const evicted = evictResult?.meta?.changes || 0;
        if (evicted > 0) {
          logger.info(
            `[D1] Evicted ${evicted} stale sources to make room for ${sources.length} new batch sources`,
          );
        } else if (currentCount >= MAX_TOTAL_SOURCES) {
          logger.warn(
            `[D1] Source registry at cap (${MAX_TOTAL_SOURCES}), no evictable sources — some batch entries may be ignored`,
          );
        }
      } catch (evictErr) {
        logger.warn(
          `[D1] Batch source eviction failed: ${evictErr.message}`,
        );
      }
    }

    const stmts = sources.map((source) => {
      const safeUrl = source.url ? decodeURIComponent(source.url) : null;
      const safeName = source.name ? decodeURIComponent(source.name) : "";
      return db
        .prepare(
          `INSERT OR IGNORE INTO source_registry (url, type, name, enabled, discovery_origin, state, ats_platform)
                 VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        )
        .bind(
          safeUrl,
          source.type || "rss",
          safeName,
          source.enabled !== false ? 1 : 0,
          source.discovery_origin || "manual",
          source.ats_platform || null,
        );
    });

    // Execute in batches of 40 (inside D1 batch limits)
    for (let i = 0; i < stmts.length; i += 40) {
      await db.batch(stmts.slice(i, i + 40));
    }
  } catch (err) {
    logger.error(`[D1] Failed to batch register sources: ${err.message}`);
    // Fall back to individual registration
    for (const source of sources) {
      await registerDiscoveredSource(db, source);
    }
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
    const result = await db
      .prepare(
        `SELECT url, type, name, enabled, discovery_origin, success_count, failure_count
             FROM source_registry WHERE enabled = 1`,
      )
      .all();
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
      await db
        .prepare(
          `UPDATE source_registry
                 SET success_count = success_count + 1,
                     consecutive_failures = 0,
                     last_fetched_at = CURRENT_TIMESTAMP,
                     last_success_at = CURRENT_TIMESTAMP,
                     last_job_count = ?
                 WHERE url = ?`,
        )
        .bind(jobCount, url)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE source_registry
                 SET failure_count = failure_count + 1,
                     consecutive_failures = consecutive_failures + 1,
                     last_fetched_at = CURRENT_TIMESTAMP,
                     last_failure_at = CURRENT_TIMESTAMP
                 WHERE url = ?`,
        )
        .bind(url)
        .run();
    }
  } catch (err) {
    logger.warn(
      `[D1] Failed to update source stats for ${url}: ${err.message}`,
    );
  }
}

/**
 * Batch update stats for multiple sources in one db.batch() call.
 * Reduces D1 queries from N to 1 per batch.
 *
 * @param {D1Database} db
 * @param {Array<{url: string, success: boolean, jobCount: number}>} statsList
 */
export async function batchUpdateSourceStats(db, statsList) {
  if (!statsList || statsList.length === 0) return;

  try {
    const stmts = statsList.map(({ url, success, jobCount }) => {
      if (success) {
        return db
          .prepare(
            `UPDATE source_registry
                     SET success_count = success_count + 1,
                         consecutive_failures = 0,
                         last_fetched_at = CURRENT_TIMESTAMP,
                         last_success_at = CURRENT_TIMESTAMP,
                         last_job_count = ?
                     WHERE url = ?`,
          )
          .bind(jobCount, url);
      } else {
        return db
          .prepare(
            `UPDATE source_registry
                     SET failure_count = failure_count + 1,
                         consecutive_failures = consecutive_failures + 1,
                         last_fetched_at = CURRENT_TIMESTAMP,
                         last_failure_at = CURRENT_TIMESTAMP
                     WHERE url = ?`,
          )
          .bind(url);
      }
    });

    // D1 batch limit: 100 statements
    for (let i = 0; i < stmts.length; i += 40) {
      await db.batch(stmts.slice(i, i + 40));
    }
  } catch (err) {
    logger.warn(`[D1] Batch source stats update failed: ${err.message}`);
    // Fall back to individual updates
    for (const stat of statsList) {
      await updateSourceStats(db, stat.url, stat).catch(() => { });
    }
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
    await db
      .prepare(`UPDATE source_registry SET enabled = 0 WHERE url = ?`)
      .bind(url)
      .run();
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
                 GROUP BY type`,
      ),
      db.prepare(`SELECT COUNT(*) as total FROM jobs`),
      db.prepare(
        `SELECT value FROM scoring_meta WHERE key = 'total_documents'`,
      ),
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

/**
 * Fix 12: Update per-source alert metrics (alert_rate, avg_score).
 * Enables data-driven source quality ranking.
 *
 * @param {D1Database} db
 * @param {Map<string, { alertCount: number, totalScore: number, jobCount: number }>} sourceMetrics
 */
export async function updateSourceAlertMetrics(db, sourceMetrics) {
  if (!sourceMetrics || sourceMetrics.size === 0) return;

  try {
    const stmts = [];
    for (const [sourceUrl, metrics] of sourceMetrics) {
      const avgScore = metrics.jobCount > 0
        ? Math.round(metrics.totalScore / metrics.jobCount)
        : 0;
      const alertRate = metrics.jobCount > 0
        ? Math.round((metrics.alertCount / metrics.jobCount) * 100) / 100
        : 0;
      stmts.push(
        db.prepare(
          `UPDATE source_registry
           SET avg_score = COALESCE(
                 ROUND((COALESCE(avg_score, 0) * 0.7 + ? * 0.3)),
                 ?
               ),
               alert_rate = COALESCE(
                 ROUND((COALESCE(alert_rate, 0) * 0.7 + ? * 0.3), 2),
                 ?
               )
           WHERE url = ?`
        ).bind(avgScore, avgScore, alertRate, alertRate, sourceUrl)
      );
    }
    // D1 batch (max 40)
    for (let i = 0; i < stmts.length; i += 40) {
      await db.batch(stmts.slice(i, i + 40));
    }
    logger.info(`[D1] Updated alert metrics for ${sourceMetrics.size} sources`);
  } catch (err) {
    logger.warn(`[D1] Failed to update source alert metrics: ${err.message}`);
  }
}
