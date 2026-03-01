/**
 * @module storage
 * @description Seen-jobs storage backed by Cloudflare KV with dual-key deduplication.
 *
 * Strategy:
 *   1. URL-based fast path  → `seen:<guid>` — catches same job from same source.
 *   2. Content-hash slow path → `seen:hash:<sha256(title+company)>` — catches
 *      cross-platform duplicates where the same role appears on multiple job boards.
 *
 * Both keys expire at 7 days to keep KV lean.
 */

import logger from '../core/logger.js';
import { jobDedupeKey } from '../core/schema.js';

/** @type {number} TTL for seen job entries — 7 days in seconds */
const SEEN_JOB_TTL = 7 * 24 * 60 * 60;

// ── SHA-256 Fingerprinting ────────────────────────────────────────────────────

/**
 * Compute a short SHA-256 hex digest of a string using the Web Crypto API.
 * Works natively in Cloudflare Workers runtime.
 * @param {string} input
 * @returns {Promise<string>} First 16 hex chars of SHA-256 digest.
 */
async function sha256Short(input) {
    const encoded = new TextEncoder().encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * Produce a KV-safe content-hash key for a job based on its title + company.
 * @param {import('./schema.js').RawJob} job
 * @returns {Promise<string>}
 */
async function contentHashKey(job) {
    const key = jobDedupeKey(job.title || '', job.company || '');
    const hash = await sha256Short(key);
    return `seen:hash:${hash}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check if a job has been seen before.
 * Checks both the URL-based key (fast) and the content-hash key (cross-platform).
 *
 * @param {KVNamespace} kv - Cloudflare KV namespace binding.
 * @param {string} id - Job identifier (guid or link).
 * @param {import('./schema.js').RawJob} job - Full job object (for content-hash check).
 * @returns {Promise<{ seen: boolean, reason?: string }>}
 */
export async function hasSeen(kv, id, job = null) {
    try {
        // Fast path: URL/GUID-based check
        const urlKey = `seen:${id}`;
        const urlValue = await kv.get(urlKey);
        if (urlValue !== null) return { seen: true, reason: 'url' };

        // Slow path: content-hash check (only if job object provided)
        if (job && job.title) {
            const hashKey = await contentHashKey(job);
            const hashValue = await kv.get(hashKey);
            if (hashValue !== null) return { seen: true, reason: 'content-hash' };
        }

        return { seen: false };
    } catch (err) {
        logger.error(`KV read error for "${id}": ${err.message}`);
        return { seen: false }; // Fail open — better to re-process than to miss
    }
}

/**
 * Mark a job as seen in KV under both the URL key and the content-hash key.
 *
 * @param {KVNamespace} kv - Cloudflare KV namespace binding.
 * @param {string} id - Job identifier (guid or link).
 * @param {import('./schema.js').RawJob} job - Full job object.
 * @returns {Promise<void>}
 */
export async function markSeen(kv, id, job = null) {
    const now = String(Date.now());
    const writes = [];

    // URL-based key (always)
    writes.push(
        kv.put(`seen:${id}`, now, { expirationTtl: SEEN_JOB_TTL }).catch(err =>
            logger.error(`KV write error (url key) for "${id}": ${err.message}`)
        )
    );

    // Content-hash key (when job data available)
    if (job && job.title) {
        writes.push(
            contentHashKey(job).then(hashKey =>
                kv.put(hashKey, now, { expirationTtl: SEEN_JOB_TTL }).catch(err =>
                    logger.error(`KV write error (hash key) for "${id}": ${err.message}`)
                )
            )
        );
    }

    await Promise.allSettled(writes);
}
