/**
 * @module batcher
 * @description Feed batch splitting for Cloudflare Workers cron distribution.
 *
 * Problem: Running all 25 feeds in one Worker execution risks hitting CPU +
 * subrequest limits. Solution: Split feeds into N balanced batches, each
 * triggered by a separate staggered cron.
 *
 * Batch assignment: derived from cron trigger minute → batch 0 / 1 / 2.
 *   - Batch 0: fires at minute :00, :15, :30, :45  (default cron)
 *   - Batch 1: fires at minute :05, :20, :35, :50
 *   - Batch 2: fires at minute :10, :25, :40, :55
 */

/**
 * Split a flat array of feeds into N balanced batches.
 * The last batch may be slightly larger if feeds.length is not
 * evenly divisible by batchCount.
 *
 * @param {string[] | object[]} feeds - Full feed list.
 * @param {number} batchCount - Number of batches (default 3).
 * @returns {Array<string[] | object[]>} Array of batch arrays.
 */
export function splitFeedsIntoBatches(feeds, batchCount = 3) {
    if (!feeds?.length) return [];
    if (batchCount <= 1) return [feeds];

    const size = Math.ceil(feeds.length / batchCount);
    const batches = [];
    for (let i = 0; i < batchCount; i++) {
        const slice = feeds.slice(i * size, (i + 1) * size);
        if (slice.length > 0) batches.push(slice);
    }
    return batches;
}

/**
 * Derive which batch (0-indexed) this cron trigger belongs to,
 * based on the scheduled time's minute value.
 *
 * Stagger scheme (15-min base interval):
 *   Batch 0 → minutes :00, :15, :30, :45
 *   Batch 1 → minutes :05, :20, :35, :50
 *   Batch 2 → minutes :10, :25, :40, :55
 *
 * @param {number} scheduledTime - event.scheduledTime (ms timestamp).
 * @param {number} batchCount - Total number of batches.
 * @returns {number} Batch index (0-indexed).
 */
export function getBatchId(scheduledTime, batchCount = 3) {
    const minute = new Date(scheduledTime).getUTCMinutes();
    // Map minute mod 15 to batch: 0→0, 5→1, 10→2
    const offsetInInterval = ((minute % 15) / 5);
    return Math.min(Math.floor(offsetInInterval), batchCount - 1);
}

/**
 * Select the feeds for a specific cron run based on scheduledTime.
 *
 * @param {string[] | object[]} feeds - Full feed list from config.
 * @param {number} scheduledTime - event.scheduledTime ms timestamp.
 * @param {number} batchCount - Total batches configured.
 * @returns {{ batch: string[] | object[], batchId: number, total: number }}
 */
export function selectBatch(feeds, scheduledTime, batchCount = 3) {
    const batches = splitFeedsIntoBatches(feeds, batchCount);
    const batchId = getBatchId(scheduledTime, batchCount);
    const safeId = Math.min(batchId, batches.length - 1);
    return {
        batch: batches[safeId] || feeds,
        batchId: safeId,
        total: feeds.length,
    };
}
