/**
 * @module connectors/index
 * @description Connector registry — routes sources to type-specific connectors,
 * runs them, and merges results into a single `RawJob[]` stream.
 *
 * Adding a new connector:
 *   1. Create `src/connectors/<type>.js` exporting a fetch function.
 *   2. Register it in the `CONNECTOR_MAP` below.
 *   3. Add sources with `type: '<type>'` to config.sources[].
 */

import { fetchRssFeeds } from './rss.js';
import { fetchGreenhouseJobs } from './greenhouse.js';
import { fetchLeverJobs } from './lever.js';
import { fetchAshbyJobs } from './ashby.js';
import { fetchWorkableJobs } from './workable.js';
import { fetchCareerPageJobs } from './careerPage.js';
import { buildSourceList, groupByType } from './base.js';
import logger from '../core/logger.js';

/**
 * @typedef {object} ConnectorResult
 * @property {import('../schema.js').RawJob[]} jobs - All normalized jobs from all connectors.
 * @property {object[]} feedStats - Per-source breakdown for observability.
 * @property {number} totalItems - Total items harvested.
 * @property {number} totalErrors - Number of sources that errored.
 */

/**
 * Map of source type → fetch function.
 * Each function signature: (sources: object[], config: object) => Promise<FeedResult[]>
 * where FeedResult = { feedUrl, sourceName, items: RawJob[], error? }
 */
const CONNECTOR_MAP = {
    rss: (sources, config) => {
        // RSS connector expects { url, name } shape
        const rssSources = sources.map(s => ({ url: s.url, name: s.name }));
        return fetchRssFeeds(rssSources, config);
    },
    greenhouse: fetchGreenhouseJobs,
    lever: fetchLeverJobs,
    ashby: fetchAshbyJobs,
    workable: fetchWorkableJobs,
    career_page: (sources, config) => fetchCareerPageJobs(sources, config).then(r => {
        // Normalize the career page result shape to match other connectors
        return r.items.length > 0 || r.stats.length > 0
            ? r.stats.map((s, i) => ({
                feedUrl: s.url,
                sourceName: s.name,
                items: r.items.filter(j => j.sourceUrl === s.url),
                error: s.error,
            }))
            : [];
    }),
};

/**
 * Run all enabled connectors from config and merge results.
 *
 * @param {object} config - Full bot config.
 * @returns {Promise<ConnectorResult>}
 */
export async function runAllConnectors(config) {
    const jobs = [];
    const feedStats = [];
    let totalErrors = 0;

    // Build unified source list from feeds[] + sources[]
    const allSources = buildSourceList(config);
    const grouped = groupByType(allSources);

    for (const [type, sources] of grouped) {
        const connector = CONNECTOR_MAP[type];
        if (!connector) {
            logger.warn(`[Connectors] Unknown source type "${type}", skipping ${sources.length} sources`);
            continue;
        }

        logger.info(`[Connectors] Running ${type} connector on ${sources.length} sources`);

        try {
            const results = await connector(sources, config);

            for (const result of results) {
                feedStats.push({
                    type,
                    url: result.feedUrl,
                    name: result.sourceName,
                    count: result.items.length,
                    error: result.error || null,
                });

                if (result.error) {
                    totalErrors++;
                } else {
                    for (const job of result.items) {
                        jobs.push(job);
                    }
                }
            }
        } catch (err) {
            logger.error(`[Connectors] ${type} connector crashed: ${err.message}`);
            totalErrors++;
            feedStats.push({
                type,
                url: `connector:${type}`,
                name: type,
                count: 0,
                error: err.message,
            });
        }
    }

    const sourceTypeSummary = [...grouped.entries()]
        .map(([type, srcs]) => `${type}:${srcs.length}`)
        .join(', ');

    logger.info(
        `[Connectors] Harvest complete | ` +
        `Sources: ${allSources.length} (${sourceTypeSummary}) | ` +
        `Jobs: ${jobs.length} | ` +
        `Errors: ${totalErrors}`
    );

    return {
        jobs,
        feedStats,
        totalItems: jobs.length,
        totalErrors,
    };
}
