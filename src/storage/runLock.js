/**
 * @module runLock
 * @description KV-based distributed run lock.
 *
 * Prevents duplicate parallel cron executions when multiple triggers fire
 * simultaneously (e.g., cron scheduler stutter, manual + auto trigger overlap).
 *
 * Lock strategy:
 *   - Acquire: write KV key with TTL only if it doesn't already exist
 *   - Release: delete the key
 *   - TTL safeguard: lock auto-expires after LOCK_TTL_SECONDS even if
 *     the Worker crashes before `releaseLock()` is called.
 */

import logger from '../core/logger.js';

/** Lock TTL in seconds — slightly longer than max expected run duration. */
const LOCK_TTL_SECONDS = 4 * 60; // 4 minutes

/** Default lock key (one per batch slot). */
const DEFAULT_LOCK_KEY = 'run:lock:global';

/**
 * Attempt to acquire the run lock.
 * Returns `true` if lock was acquired (safe to proceed).
 * Returns `false` if another run is already holding the lock.
 *
 * @param {KVNamespace} kv
 * @param {string} [lockKey] - Optional custom lock key (e.g., per-batch).
 * @returns {Promise<boolean>}
 */
export async function acquireLock(kv, lockKey = DEFAULT_LOCK_KEY) {
    try {
        // Read-then-write — best effort. KV is eventually consistent
        // but this prevents the vast majority of duplicate runs.
        const existing = await kv.get(lockKey);
        if (existing !== null) {
            logger.warn(`[RunLock] Lock "${lockKey}" already held — skipping this run`);
            return false;
        }

        await kv.put(lockKey, new Date().toISOString(), {
            expirationTtl: LOCK_TTL_SECONDS,
        });
        logger.info(`[RunLock] Lock acquired: ${lockKey}`);
        return true;
    } catch (err) {
        // On lock error → proceed anyway (fail open to avoid silent skips)
        logger.warn(`[RunLock] Lock acquire failed: ${err.message} — proceeding anyway`);
        return true;
    }
}

/**
 * Release the run lock.
 *
 * @param {KVNamespace} kv
 * @param {string} [lockKey]
 * @returns {Promise<void>}
 */
export async function releaseLock(kv, lockKey = DEFAULT_LOCK_KEY) {
    try {
        await kv.delete(lockKey);
        logger.info(`[RunLock] Lock released: ${lockKey}`);
    } catch (err) {
        logger.warn(`[RunLock] Lock release failed: ${err.message}`);
    }
}

/**
 * Wrap an async function with lock acquire/release.
 * Automatically releases the lock even if the function throws.
 *
 * @param {KVNamespace} kv
 * @param {string} lockKey
 * @param {Function} fn - Async function to run inside the lock.
 * @returns {Promise<{ ran: boolean, result?: any }>}
 */
export async function withLock(kv, lockKey, fn) {
    const acquired = await acquireLock(kv, lockKey);
    if (!acquired) return { ran: false };

    try {
        const result = await fn();
        return { ran: true, result };
    } finally {
        await releaseLock(kv, lockKey);
    }
}
