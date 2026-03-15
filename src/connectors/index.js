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

import { fetchRssFeeds } from "./rss.js";
import { fetchGreenhouseJobs } from "./greenhouse.js";
import { fetchLeverJobs } from "./lever.js";
import { fetchAshbyJobs } from "./ashby.js";
import { fetchWorkableJobs } from "./workable.js";
import { fetchCareerPageJobs } from "./careerPage.js";
import { fetchSmartRecruitersJobs } from "./smartrecruiters.js";
import { fetchTeamtailorJobs } from "./teamtailor.js";
import { fetchRecruiteeJobs } from "./recruitee.js";
import { fetchWorkdayJobs } from "./workday.js";
import { fetchBreezyJobs } from "./breezy.js";
import { fetchRipplingJobs } from "./rippling.js";
import { fetchPinpointJobs } from "./pinpoint.js";
import { fetchDoverJobs } from "./dover.js";
import { fetchFreshteamJobs } from "./freshteam.js";
import { fetchJobviteJobs } from "./jobvite.js";
import { buildSourceList, groupByType, setRateLimitKV } from "./base.js";
import logger from "../core/logger.js";

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
  rss: (sources, config, kv) => {
    // RSS connector expects { url, name } shape
    // FIX: pass kv so per-source pubDate cursor can be read/written
    const rssSources = sources.map((s) => ({
      url: s.url,
      name: s.name,
      id: s.id || s.url,
    }));
    return fetchRssFeeds(rssSources, config, kv);
  },
  greenhouse: (sources, config, kv) => fetchGreenhouseJobs(sources, config, kv),
  lever: (sources, config, kv) => fetchLeverJobs(sources, config, kv),
  ashby: (sources, config, kv) => fetchAshbyJobs(sources, config, kv),
  workable: (sources, config, kv) => fetchWorkableJobs(sources, config, kv),
  smartrecruiters: (sources, config, kv) => fetchSmartRecruitersJobs(sources, config, kv),
  teamtailor: (sources, config, kv) => fetchTeamtailorJobs(sources, config, kv),
  recruitee: (sources, config, kv) => fetchRecruiteeJobs(sources, config, kv),
  workday: (sources, config, kv) => fetchWorkdayJobs(sources, config, kv),
  breezy: (sources, config, kv) => fetchBreezyJobs(sources, config, kv),
  rippling: (sources, config, kv) => fetchRipplingJobs(sources, config, kv),
  pinpoint: (sources, config, kv) => fetchPinpointJobs(sources, config, kv),
  dover: (sources, config, kv) => fetchDoverJobs(sources, config, kv),
  freshteam: (sources, config, kv) => fetchFreshteamJobs(sources, config, kv),
  jobvite: (sources, config, kv) => fetchJobviteJobs(sources, config, kv),
  career_page: (sources, config) =>
    fetchCareerPageJobs(sources, config).then((r) => {
      // Normalize the career page result shape to match other connectors
      return r.items.length > 0 || r.stats.length > 0
        ? r.stats.map((s, i) => ({
          feedUrl: s.url,
          sourceName: s.name,
          items: r.items.filter((j) => j.sourceUrl === s.url),
          error: s.error,
        }))
        : [];
    }),
};

/**
 * Run all enabled connectors from config and merge results.
 *
 * @param {object} config - Full bot config.
 * @param {KVNamespace|null} [kv] - Optional KV namespace for RSS cursor-based dedup and rate limiting.
 * @returns {Promise<ConnectorResult>}
 */
export async function runAllConnectors(config, kv = null) {
  // Initialize KV for rate limiter if provided
  if (kv) {
    setRateLimitKV(kv);
  }

  const jobs = [];
  const feedStats = [];
  let totalErrors = 0;

  // Build unified source list from feeds[] + sources[]
  const allSources = buildSourceList(config);
  const grouped = groupByType(allSources);

  for (const [type, sources] of grouped) {
    const connector = CONNECTOR_MAP[type];
    if (!connector) {
      logger.warn(
        `[Connectors] Unknown source type "${type}", skipping ${sources.length} sources`,
      );
      continue;
    }

    logger.info(
      `[Connectors] Running ${type} connector on ${sources.length} sources`,
    );

    try {
      const CHUNK_SIZE = 10;
      for (let i = 0; i < sources.length; i += CHUNK_SIZE) {
        const chunk = sources.slice(i, i + CHUNK_SIZE);
        const results = await connector(chunk, config, kv);

        for (const result of results) {
          feedStats.push({
            type,
            url: result.feedUrl,
            name: result.sourceName,
            count: result.items.length,
            durationMs: result.durationMs || 0,
            success: !result.error,
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

        // Delay between chunks to prevent 429s and burst fetch limits
        if (i + CHUNK_SIZE < sources.length) {
          await new Promise((r) => setTimeout(r, 1000));
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
        durationMs: 0,
        success: false,
        error: err.message,
      });
    }
  }

  const sourceTypeSummary = [...grouped.entries()]
    .map(([type, srcs]) => `${type}:${srcs.length}`)
    .join(", ");

  logger.info(
    `[Connectors] Harvest complete | ` +
    `Sources: ${allSources.length} (${sourceTypeSummary}) | ` +
    `Jobs: ${jobs.length} | ` +
    `Errors: ${totalErrors}`,
  );

  return {
    jobs,
    feedStats,
    totalItems: jobs.length,
    totalErrors,
  };
}
