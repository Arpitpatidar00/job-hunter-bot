/**
 * @module notificationQueue
 * @description KV-backed alert retry buffer.
 *
 * When `sendAlert()` fails for a job, the alert payload is parked in KV
 * with an incrementing attempts counter.  On the next cron tick (or via
 * the /health endpoint), `drainRetryQueue()` re-attempts each pending
 * alert and drops it after `MAX_RETRIES` failures.
 */

import { sendAlert } from './notifications.js';

const KV_PREFIX = 'alert-retry:';
const MAX_RETRIES = 3;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Park a failed alert in KV for later retry.
 *
 * @param {KVNamespace} kv
 * @param {{ id: string, title: string, company: string, link: string }} job
 * @param {object} scoreResult
 */
export async function queueFailedAlert(kv, job, scoreResult) {
    const key = `${KV_PREFIX}${job.id}`;
    const existing = await kv.get(key);
    if (existing !== null) return; // already queued

    await kv.put(key, JSON.stringify({ job, scoreResult, attempts: 0 }));
}

/**
 * Attempt to resend all queued alerts.
 *
 * @param {KVNamespace} kv
 * @param {object} env - Worker env bindings (secrets).
 * @param {object} config - Bot config.
 * @returns {Promise<{ retried: number, succeeded: number, dropped: number }>}
 */
export async function drainRetryQueue(kv, env, config) {
    const { keys } = await kv.list({ prefix: KV_PREFIX });
    const stats = { retried: 0, succeeded: 0, dropped: 0 };

    for (const { name: key } of keys) {
        const raw = await kv.get(key);
        if (!raw) continue;

        const entry = JSON.parse(raw);
        stats.retried++;

        if (entry.attempts >= MAX_RETRIES) {
            await kv.delete(key);
            stats.dropped++;
            continue;
        }

        try {
            await sendAlert(entry.job, entry.scoreResult, { env, config });
            await kv.delete(key);
            stats.succeeded++;
        } catch {
            entry.attempts++;
            await kv.put(key, JSON.stringify(entry));
        }
    }

    return stats;
}

/**
 * Get stats about the current retry queue.
 *
 * @param {KVNamespace} kv
 * @returns {Promise<{ pending: number, items: Array<{ title: string, attempts: number }> }>}
 */
export async function getQueueStats(kv) {
    const { keys } = await kv.list({ prefix: KV_PREFIX });
    const items = [];

    for (const { name: key } of keys) {
        const raw = await kv.get(key);
        if (!raw) continue;
        const entry = JSON.parse(raw);
        items.push({ title: entry.job.title, attempts: entry.attempts });
    }

    return { pending: items.length, items };
}
