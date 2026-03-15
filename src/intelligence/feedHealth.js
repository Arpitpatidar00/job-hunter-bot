/**
 * @module feedHealth
 * @description Per-feed reliability tracking + circuit breaker pattern.
 *
 * ARCHITECTURE FIX (Issue #1): Health records moved from KV to D1.
 * This eliminates ~3840 KV writes/day — the single biggest free-tier
 * quota consumer. Circuit breaker flags remain in KV for TTL-based
 * auto-recovery.
 *
 * Storage mapping:
 *   - Health records (success/fail/latency): D1 table `feed_health`
 *   - Circuit breaker open flags: KV key `feed:circuit:{hash}` (TTL auto-expire)
 *
 * KV write budget (this module):
 *   Before: ~3840 writes/day (health) + ~20 writes/day (circuit)
 *   After:  ~20 writes/day (circuit only — on failures exceeding threshold)
 */

import logger from "../core/logger.js";

/** Consecutive failures before circuit OPENS (hard stop). */
const OPEN_THRESHOLD = 5;

/** Consecutive failures before source is marked DEGRADED (soft downgrade). */
const SOFT_THRESHOLD = 3;

/** Base cooldown in seconds (5 minutes). Scales with failure count. */
const BASE_COOLDOWN_SECONDS = 5 * 60;

/** Maximum cooldown in seconds (4 hours). */
const MAX_COOLDOWN_SECONDS = 4 * 60 * 60;

// ── Key helpers ───────────────────────────────────────────────────────────────

/**
 * Produce a short stable key-safe ID from a URL.
 * Uses a simple FNV-1a-like hash without crypto (sync, fast).
 * @param {string} url
 * @returns {string}
 */
function urlKey(url) {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function circuitKey(url) {
  return `feed:circuit:${urlKey(url)}`;
}

/**
 * Calculate dynamic cooldown with exponential backoff and jitter.
 * @param {number} consecutiveFailures
 * @returns {number} Cooldown in seconds.
 */
function calculateCooldown(consecutiveFailures) {
  const factor = Math.pow(2, Math.max(0, consecutiveFailures - OPEN_THRESHOLD));
  const cooldown = Math.min(
    MAX_COOLDOWN_SECONDS,
    BASE_COOLDOWN_SECONDS * factor,
  );
  const jitter = cooldown * 0.2 * (Math.random() * 2 - 1);
  return Math.round(cooldown + jitter);
}

// ── D1 Data Access ────────────────────────────────────────────────────────────

/** @returns {object} Default health record for new feeds */
function defaultRecord(url) {
  return {
    url,
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    totalLatencyMs: 0,
    sampleCount: 0,
    lastSeen: "",
    lastError: "",
  };
}

/** Convert a D1 row to camelCase record format */
function rowToRecord(row) {
  if (!row) return null;
  return {
    url: row.url,
    successCount: row.success_count || 0,
    failureCount: row.failure_count || 0,
    consecutiveFailures: row.consecutive_failures || 0,
    totalLatencyMs: row.total_latency_ms || 0,
    sampleCount: row.sample_count || 0,
    lastSeen: row.last_seen || "",
    lastError: row.last_error || "",
    etag: row.etag || undefined,
    lastModified: row.last_modified || undefined,
  };
}

/**
 * Read a health record from D1.
 * @param {D1Database} db
 * @param {string} url
 * @returns {Promise<object>}
 */
async function getRecord(db, url) {
  try {
    const hash = urlKey(url);
    const row = await db
      .prepare(`SELECT * FROM feed_health WHERE url_hash = ?`)
      .bind(hash)
      .first();
    return row ? rowToRecord(row) : defaultRecord(url);
  } catch {
    return defaultRecord(url);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether the circuit for a feed is open (i.e., feed is disabled).
 * Still uses KV — circuit flags need TTL for auto-recovery.
 * @param {KVNamespace} kv
 * @param {string} feedUrl
 * @returns {Promise<boolean>}
 */
export async function isFeedCircuitOpen(kv, feedUrl) {
  try {
    const flag = await kv.get(circuitKey(feedUrl));
    return flag !== null;
  } catch {
    return false;
  } // fail open
}

/**
 * Synchronous check on a health record to decide whether to skip or downgrade.
 * @param {{ consecutiveFailures: number }} record
 * @returns {{ skip: boolean, reason: string, degraded?: boolean }}
 */
export function shouldSkipSource(record) {
  const failures = record?.consecutiveFailures || 0;

  if (failures >= OPEN_THRESHOLD) {
    return { skip: true, reason: "circuit_open" };
  }
  if (failures >= SOFT_THRESHOLD) {
    return { skip: false, reason: "degraded", degraded: true };
  }
  return { skip: false, reason: "healthy" };
}

/**
 * Get a feed's health record from D1 + circuit status from KV.
 *
 * CHANGED: Now takes (db, kv, url) instead of (kv, url).
 *
 * @param {D1Database} db
 * @param {KVNamespace} kv
 * @param {string} url
 * @returns {Promise<object>}
 */
export async function getFeedHealthRecord(db, kv, url) {
  const [record, circuitOpen] = await Promise.all([
    getRecord(db, url),
    isFeedCircuitOpen(kv, url),
  ]);
  return { ...record, circuitOpen };
}

/**
 * Batch record feed results in a single D1 transaction.
 * Replaces per-feed KV writes (~3840/day) with batched D1 upserts.
 *
 * Circuit breaker flags are still written to KV (only on state changes,
 * ~20 writes/day max).
 *
 * @param {D1Database} db
 * @param {KVNamespace} kv - For circuit breaker flags only
 * @param {Array<{url: string, success: boolean, latencyMs?: number, error?: string, etag?: string, lastModified?: string}>} results
 * @returns {Promise<void>}
 */
export async function batchRecordFeedResults(db, kv, results) {
  if (!results || results.length === 0) return;

  const stmts = [];
  const circuitPromises = [];

  for (const {
    url,
    success,
    latencyMs = 0,
    error = "",
    etag,
    lastModified,
  } of results) {
    const hash = urlKey(url);
    const now = new Date().toISOString();

    if (success) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO feed_health (url_hash, url, success_count, failure_count, consecutive_failures, total_latency_ms, sample_count, last_seen, last_error, etag, last_modified, updated_at)
           VALUES (?, ?, 1, 0, 0, ?, 1, ?, '', ?, ?, ?)
           ON CONFLICT(url_hash) DO UPDATE SET
             success_count = success_count + 1,
             consecutive_failures = 0,
             total_latency_ms = total_latency_ms + ?,
             sample_count = sample_count + 1,
             last_seen = ?,
             etag = COALESCE(?, etag),
             last_modified = COALESCE(?, last_modified),
             updated_at = ?`,
          )
          .bind(
            hash, url, latencyMs, now, etag || null, lastModified || null, now,
            latencyMs, now, etag || null, lastModified || null, now,
          ),
      );

      // Reset circuit breaker on success (KV delete — minimal writes)
      circuitPromises.push(
        kv
          .delete(circuitKey(url))
          .catch((err) =>
            logger.warn(
              `[Circuit] Failed to reset circuit for ${url}: ${err.message}`,
            ),
          ),
      );
    } else {
      stmts.push(
        db
          .prepare(
            `INSERT INTO feed_health (url_hash, url, success_count, failure_count, consecutive_failures, total_latency_ms, sample_count, last_seen, last_error, updated_at)
           VALUES (?, ?, 0, 1, 1, ?, 1, ?, ?, ?)
           ON CONFLICT(url_hash) DO UPDATE SET
             failure_count = failure_count + 1,
             consecutive_failures = consecutive_failures + 1,
             total_latency_ms = total_latency_ms + ?,
             sample_count = sample_count + 1,
             last_seen = ?,
             last_error = ?,
             updated_at = ?`,
          )
          .bind(hash, url, latencyMs, now, error, now, latencyMs, now, error, now),
      );
    }
  }

  // Execute all D1 health writes in batches of 40
  try {
    for (let i = 0; i < stmts.length; i += 40) {
      await db.batch(stmts.slice(i, i + 40));
    }
  } catch (err) {
    logger.warn(`[FeedHealth] Batch D1 write failed: ${err.message}`);
  }

  // Handle circuit breaker logic for failed feeds
  const failedUrls = results.filter((r) => !r.success);
  if (failedUrls.length > 0) {
    try {
      for (const { url } of failedUrls) {
        const hash = urlKey(url);
        const row = await db
          .prepare(
            `SELECT consecutive_failures FROM feed_health WHERE url_hash = ?`,
          )
          .bind(hash)
          .first();

        if (!row) continue;

        if (row.consecutive_failures >= OPEN_THRESHOLD) {
          const cooldown = calculateCooldown(row.consecutive_failures);
          circuitPromises.push(
            kv
              .put(circuitKey(url), "1", { expirationTtl: cooldown })
              .then(() =>
                logger.warn(
                  `[Circuit] OPEN for ${url} after ${row.consecutive_failures} consecutive failures. Cooldown: ${Math.round(cooldown / 60)}min`,
                ),
              )
              .catch((err) =>
                logger.warn(
                  `[Circuit] Failed to open circuit for ${url}: ${err.message}`,
                ),
              ),
          );
        } else if (row.consecutive_failures >= SOFT_THRESHOLD) {
          logger.warn(
            `[Circuit] DEGRADED: ${url} has ${row.consecutive_failures} consecutive failures — reducing crawl frequency`,
          );
        }
      }
    } catch (err) {
      logger.warn(
        `[FeedHealth] Circuit check after batch failed: ${err.message}`,
      );
    }
  }

  // Fire circuit breaker KV operations (minimal writes — only on state changes)
  if (circuitPromises.length > 0) {
    await Promise.allSettled(circuitPromises);
  }
}

/**
 * Record the result of a single feed fetch attempt.
 * Delegates to batchRecordFeedResults for consistency.
 *
 * CHANGED: Now takes (db, kv, feedUrl, result) instead of (kv, feedUrl, result).
 *
 * @param {D1Database} db
 * @param {KVNamespace} kv
 * @param {string} feedUrl
 * @param {{ success: boolean, latencyMs?: number, error?: string, etag?: string, lastModified?: string }} result
 * @returns {Promise<void>}
 */
export async function recordFeedResult(
  db,
  kv,
  feedUrl,
  { success, latencyMs = 0, error = "", etag, lastModified },
) {
  await batchRecordFeedResults(db, kv, [
    { url: feedUrl, success, latencyMs, error, etag, lastModified },
  ]);
}

/**
 * Get a health report for all feeds (used by /metrics endpoint).
 *
 * CHANGED: Now takes (db, kv, feedUrls) instead of (kv, feedUrls).
 *
 * @param {D1Database} db
 * @param {KVNamespace} kv
 * @param {string[]} feedUrls
 * @returns {Promise<object[]>}
 */
export async function getFeedHealthReport(db, kv, feedUrls) {
  const report = await Promise.allSettled(
    feedUrls.map(async (url) => {
      const record = await getRecord(db, url);
      const circuitOpen = await isFeedCircuitOpen(kv, url);
      const total = record.successCount + record.failureCount;
      const avgLatency =
        record.sampleCount > 0
          ? Math.round(record.totalLatencyMs / record.sampleCount)
          : 0;
      const successRate =
        total > 0 ? Math.round((record.successCount / total) * 100) : null;
      return {
        url,
        successRate,
        avgLatencyMs: avgLatency,
        consecutiveFailures: record.consecutiveFailures,
        circuitOpen,
        lastSeen: record.lastSeen,
        lastError: record.lastError || null,
      };
    }),
  );

  return report.filter((r) => r.status === "fulfilled").map((r) => r.value);
}

/**
 * Manually reset a feed's circuit breaker (for admin use).
 *
 * CHANGED: Now takes (db, kv, feedUrl) instead of (kv, feedUrl).
 *
 * @param {D1Database} db
 * @param {KVNamespace} kv
 * @param {string} feedUrl
 */
export async function resetFeedCircuit(db, kv, feedUrl) {
  try {
    await kv.delete(circuitKey(feedUrl));
    const hash = urlKey(feedUrl);
    await db
      .prepare(
        `UPDATE feed_health SET consecutive_failures = 0, updated_at = datetime('now') WHERE url_hash = ?`,
      )
      .bind(hash)
      .run();
  } catch (err) {
    logger.warn(`feedHealth: reset failed for ${feedUrl}: ${err.message}`);
  }
}
