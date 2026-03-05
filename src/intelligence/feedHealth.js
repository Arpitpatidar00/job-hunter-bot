/**
 * @module feedHealth
 * @description Per-feed reliability tracking + circuit breaker pattern.
 *
 * Each feed gets a KV health record: `feed:health:<urlHash>`
 * tracking successes, failures, latency, and last seen timestamp.
 *
 * Circuit breaker logic:
 *   - Opens (disables feed) after OPEN_THRESHOLD consecutive failures
 *   - Auto-recovers after dynamic cooldown with jitter (via KV TTL on the open flag)
 *   - Resets on first success after recovery
 *   - Cooldown scales with consecutive failures (exponential backoff)
 */

import logger from '../core/logger.js';

/** Consecutive failures before circuit opens. */
const OPEN_THRESHOLD = 5;

/** Base cooldown in seconds (15 minutes). Scales with failure count. */
const BASE_COOLDOWN_SECONDS = 15 * 60;

/** Maximum cooldown in seconds (4 hours). */
const MAX_COOLDOWN_SECONDS = 4 * 60 * 60;

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

/**
 * Calculate dynamic cooldown with exponential backoff and jitter.
 * @param {number} consecutiveFailures
 * @returns {number} Cooldown in seconds.
 */
function calculateCooldown(consecutiveFailures) {
    // Exponential: base * 2^(failures - threshold), capped at MAX
    const factor = Math.pow(2, Math.max(0, consecutiveFailures - OPEN_THRESHOLD));
    const cooldown = Math.min(MAX_COOLDOWN_SECONDS, BASE_COOLDOWN_SECONDS * factor);
    // Add jitter (±20%) to prevent thundering herd
    const jitter = cooldown * 0.2 * (Math.random() * 2 - 1);
    return Math.round(cooldown + jitter);
}

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
        try { await kv.delete(circuitKey(feedUrl)); } catch (err) {
            logger.warn(`[Circuit] Failed to reset circuit for ${feedUrl}: ${err.message}`);
        }
    } else {
        record.failureCount++;
        record.consecutiveFailures++;
        record.lastError = error;

        // Open circuit if threshold exceeded — with dynamic cooldown
        if (record.consecutiveFailures >= OPEN_THRESHOLD) {
            const cooldown = calculateCooldown(record.consecutiveFailures);
            try {
                await kv.put(circuitKey(feedUrl), '1', { expirationTtl: cooldown });
            } catch (err) {
                logger.warn(`[Circuit] Failed to open circuit for ${feedUrl}: ${err.message}`);
            }
            logger.warn(`[Circuit] OPEN for ${feedUrl} after ${record.consecutiveFailures} consecutive failures. Cooldown: ${Math.round(cooldown / 60)}min`);
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
