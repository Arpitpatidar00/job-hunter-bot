/**
 * @module feedHealth
 * @description Per-feed reliability tracking + circuit breaker pattern.
 *
 * Each feed gets a KV health record: `feed:health:<urlHash>`
 * tracking successes, failures, latency, and last seen timestamp.
 *
 * Circuit breaker logic:
 *   - Opens (disables feed) after OPEN_THRESHOLD consecutive failures
 *   - Auto-recovers after COOLDOWN_SECONDS (via KV TTL on the open flag)
 *   - Resets on first success after recovery
 */

import logger from '../core/logger.js';

/** Consecutive failures before circuit opens. */
const OPEN_THRESHOLD = 5;

/** Cooldown in seconds before a failed feed is retried (1 hour). */
const COOLDOWN_SECONDS = 60 * 60;

/** KV TTL for health records — 30 days. */
const HEALTH_TTL = 30 * 24 * 60 * 60;

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

function healthKey(url) { return `feed:health:${urlKey(url)}`; }
function circuitKey(url) { return `feed:circuit:${urlKey(url)}`; }

// ── Data model ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} FeedHealthRecord
 * @property {string} url
 * @property {number} successCount
 * @property {number} failureCount
 * @property {number} consecutiveFailures
 * @property {number} totalLatencyMs
 * @property {number} sampleCount
 * @property {string} lastSeen
 * @property {string} lastError
 */

/** @returns {FeedHealthRecord} */
function defaultRecord(url) {
    return {
        url,
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        totalLatencyMs: 0,
        sampleCount: 0,
        lastSeen: '',
        lastError: '',
    };
}

async function getRecord(kv, url) {
    try {
        const raw = await kv.get(healthKey(url));
        return raw ? JSON.parse(raw) : defaultRecord(url);
    } catch { return defaultRecord(url); }
}

async function saveRecord(kv, url, record) {
    try {
        await kv.put(healthKey(url), JSON.stringify(record), { expirationTtl: HEALTH_TTL });
    } catch (err) {
        logger.warn(`feedHealth: failed to save record for ${url}: ${err.message}`);
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether the circuit for a feed is open (i.e., feed is disabled).
 * @param {KVNamespace} kv
 * @param {string} feedUrl
 * @returns {Promise<boolean>}
 */
export async function isFeedCircuitOpen(kv, feedUrl) {
    try {
        const flag = await kv.get(circuitKey(feedUrl));
        return flag !== null;
    } catch { return false; } // fail open
}

/**
 * Record the result of a single feed fetch attempt.
 * Updates the health record and opens the circuit if threshold exceeded.
 *
 * @param {KVNamespace} kv
 * @param {string} feedUrl
 * @param {{ success: boolean, latencyMs: number, error?: string }} result
 * @returns {Promise<void>}
 */
export async function recordFeedResult(kv, feedUrl, { success, latencyMs = 0, error = '' }) {
    const record = await getRecord(kv, feedUrl);

    record.lastSeen = new Date().toISOString();
    record.sampleCount++;
    record.totalLatencyMs += latencyMs;

    if (success) {
        record.successCount++;
        record.consecutiveFailures = 0;
        // Reset circuit if it was open
        try { await kv.delete(circuitKey(feedUrl)); } catch { }
    } else {
        record.failureCount++;
        record.consecutiveFailures++;
        record.lastError = error;

        // Open circuit if threshold exceeded
        if (record.consecutiveFailures >= OPEN_THRESHOLD) {
            try {
                await kv.put(circuitKey(feedUrl), '1', { expirationTtl: COOLDOWN_SECONDS });
            } catch { }
            logger.warn(`[Circuit] OPEN for ${feedUrl} after ${record.consecutiveFailures} consecutive failures. Cooldown: ${COOLDOWN_SECONDS / 60}min`);
        }
    }

    await saveRecord(kv, feedUrl, record);
}

/**
 * Get a health report for all feeds (used by /metrics endpoint).
 * @param {KVNamespace} kv
 * @param {string[]} feedUrls
 * @returns {Promise<object[]>}
 */
export async function getFeedHealthReport(kv, feedUrls) {
    const report = await Promise.allSettled(
        feedUrls.map(async url => {
            const record = await getRecord(kv, url);
            const circuitOpen = await isFeedCircuitOpen(kv, url);
            const total = record.successCount + record.failureCount;
            const avgLatency = record.sampleCount > 0
                ? Math.round(record.totalLatencyMs / record.sampleCount)
                : 0;
            const successRate = total > 0
                ? Math.round((record.successCount / total) * 100)
                : null;
            return {
                url,
                successRate,
                avgLatencyMs: avgLatency,
                consecutiveFailures: record.consecutiveFailures,
                circuitOpen,
                lastSeen: record.lastSeen,
                lastError: record.lastError || null,
            };
        })
    );

    return report
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);
}

/**
 * Manually reset a feed's circuit breaker (for admin use).
 * @param {KVNamespace} kv
 * @param {string} feedUrl
 */
export async function resetFeedCircuit(kv, feedUrl) {
    try {
        await kv.delete(circuitKey(feedUrl));
        const record = await getRecord(kv, feedUrl);
        record.consecutiveFailures = 0;
        await saveRecord(kv, feedUrl, record);
    } catch (err) {
        logger.warn(`feedHealth: reset failed for ${feedUrl}: ${err.message}`);
    }
}
