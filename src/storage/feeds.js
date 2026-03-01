/**
 * @module feeds
 * @description Backward-compatible thin wrapper — delegates all feed fetching
 * to the modular connector registry in `src/connectors/index.js`.
 *
 * The old `fetchAllFeeds(feedUrls, config)` signature is preserved so that
 * `worker.js` needs no changes during this migration.
 */

import { runAllConnectors } from '../connectors/index.js';

/**
 * Fetch all configured feeds via the connector registry.
 * Returns results in the original `{ feedUrl, items, error? }` shape
 * so the worker loop stays identical.
 *
 * @param {string[] | object[]} feedUrls - Feed URL strings OR {url, name} objects.
 * @param {object} config - Bot configuration.
 * @returns {Promise<Array<{ feedUrl: string, items: import('./schema.js').RawJob[], error?: string }>>}
 */
export async function fetchAllFeeds(feedUrls, config) {
    // Merge feedUrls arg into config so the connector registry sees them
    const mergedConfig = { ...config, feeds: feedUrls };
    const { feedStats } = await runAllConnectors(mergedConfig);

    // Re-map feedStats back to the legacy shape expected by worker.js
    return feedStats.map(stat => ({
        feedUrl: stat.url,
        sourceName: stat.name,
        items: stat.items || [],
        error: stat.error || undefined,
    }));
}
