/**
 * @module connectors/ashby
 * @description Ashby ATS connector.
 * Fetches jobs from the public Ashby job board API and normalizes them
 * into the canonical RawJob schema.
 *
 * API: POST https://api.ashbyhq.com/posting-api/job-board/{company}
 * The Ashby API uses POST with no body to return the job board data.
 */

import { fetchWithTimeout, rateLimitDomain, applySourceLimit, loadAtsCursor, saveAtsCursor, filterByAtsCursor } from "./base.js";
import { normalizeJob } from "../core/schema.js";
import { sanitizeText, pLimit } from "../core/utils.js";
import logger from "../core/logger.js";

/** Max concurrent Ashby API requests. */
const CONCURRENCY = 3;

/**
 * Extract company slug from an Ashby URL or plain string.
 * Supports:
 *   - https://api.ashbyhq.com/posting-api/job-board/{slug}
 *   - https://jobs.ashbyhq.com/{slug}
 *   - Plain slug
 *
 * @param {string} urlOrSlug
 * @returns {string}
 */
function extractSlug(urlOrSlug) {
  try {
    const url = new URL(urlOrSlug);
    // Validate it's an HTTP URL
    if (!url.protocol.startsWith("http")) {
      logger.warn(`[Ashby] Non-HTTP URL: ${urlOrSlug}`);
      return urlOrSlug;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    // /posting-api/job-board/{slug} → last segment
    const boardIdx = parts.indexOf("job-board");
    if (boardIdx >= 0 && parts[boardIdx + 1]) return parts[boardIdx + 1];
    if (parts.length > 0) return parts[parts.length - 1];
  } catch {
    // Plain slug — validate it doesn't contain dangerous chars
    if (/[<>"';\s]/.test(urlOrSlug)) {
      logger.warn(`[Ashby] Invalid slug: ${urlOrSlug}`);
      return "";
    }
  }
  return urlOrSlug;
}

/**
 * Build the API URL for an Ashby company.
 * @param {string} slug
 * @returns {string}
 */
function buildApiUrl(slug) {
  return `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
}

/**
 * Normalize a single Ashby job into a RawJob.
 *
 * Ashby JSON shape:
 * {
 *   id, title, departmentName, locationName,
 *   publishedAt, descriptionHtml, descriptionPlain,
 *   jobUrl, employmentType, isRemote
 * }
 */
function normalizeAshbyJob(ashbyJob, source, slug) {
  const categories = [];
  if (ashbyJob.departmentName) categories.push(ashbyJob.departmentName);
  if (ashbyJob.locationName) categories.push(ashbyJob.locationName);
  if (ashbyJob.employmentType) categories.push(ashbyJob.employmentType);
  if (ashbyJob.isRemote) categories.push("Remote");

  const content =
    ashbyJob.descriptionPlain ||
    sanitizeText(ashbyJob.descriptionHtml || "") ||
    "";

  return normalizeJob(
    {
      id: `ashby-${ashbyJob.id}`,
      title: ashbyJob.title || "",
      content,
      link:
        ashbyJob.jobUrl || `https://jobs.ashbyhq.com/${slug}/${ashbyJob.id}`,
      pubDate: ashbyJob.publishedAt || "",
      isoDate: ashbyJob.publishedAt || "",
      categories,
      company: source.name || "",
    },
    {
      url: source.url,
      name: source.name || "Ashby",
      type: "ashby",
    },
  );
}

/**
 * Fetch jobs from a single Ashby company board.
 *
 * @param {object} source - { url, name }
 * @param {object} config
 * @returns {Promise<{ feedUrl: string, sourceName: string, items: RawJob[], error?: string }>}
 */
async function fetchSingleBoard(source, config, kv) {
  const slug = extractSlug(source.url);
  const apiUrl = buildApiUrl(slug);

  try {
    await rateLimitDomain(apiUrl);

    const payload = {
      operationName: "ApiJobBoardWithTeams",
      variables: {
        organizationHostedJobsPageName: slug,
      },
      query:
        "query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) { jobBoard: jobBoardWithTeams( organizationHostedJobsPageName: $organizationHostedJobsPageName ) { jobPostings { id title locationName isRemote employmentType departmentName publishedAt jobUrl descriptionHtml descriptionPlain } } }",
    };

    const res = await fetchWithTimeout(
      "https://api.ashbyhq.com/posting-api/graphql",
      {
        method: "POST",
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      },
    );

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    const ashbyJobs = data?.data?.jobBoard?.jobPostings || [];

    const allItems = applySourceLimit(ashbyJobs.map((j) => normalizeAshbyJob(j, source, slug)));

    // ATS cursor: filter out previously seen jobs
    const cursorIds = await loadAtsCursor(kv, 'ashby', slug);
    const { newItems, cursorSkipped } = filterByAtsCursor(allItems, cursorIds);

    for (const item of allItems) cursorIds.add(item.id);
    await saveAtsCursor(kv, 'ashby', slug, cursorIds);

    logger.info(`[Ashby] ${source.name}: ${newItems.length} new / ${cursorSkipped} cursor-skipped / ${allItems.length} total`);

    return {
      feedUrl: source.url,
      sourceName: source.name || slug,
      items: newItems,
      cursorSkipped,
    };
  } catch (err) {
    const msg = err.name === "AbortError" ? "Timeout" : err.message;
    logger.warn(`[Ashby] ${source.name || slug} failed: ${msg}`);
    return {
      feedUrl: source.url,
      sourceName: source.name || slug,
      items: [],
      error: msg,
    };
  }
}

/**
 * Fetch jobs from all Ashby sources.
 *
 * @param {object[]} sources
 * @param {object} config
 * @returns {Promise<Array<{ feedUrl: string, sourceName: string, items: RawJob[], error?: string }>>}
 */
export async function fetchAshbyJobs(sources, config, kv) {
  const limit = pLimit(CONCURRENCY);

  const promises = sources.map((source) =>
    limit(() => fetchSingleBoard(source, config, kv)),
  );

  const results = await Promise.allSettled(promises);

  return results.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    return {
      feedUrl: sources[i].url,
      sourceName: sources[i].name,
      items: [],
      error: result.reason?.message || "Unknown error",
    };
  });
}
