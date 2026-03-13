/**
 * @module connectors/lever
 * @description Lever ATS connector.
 * Fetches jobs from the public Lever postings API and normalizes them
 * into the canonical RawJob schema.
 *
 * API: GET https://api.lever.co/v0/postings/{company}?mode=json
 * Docs: https://github.com/lever/postings-api
 */

import { fetchWithTimeout, rateLimitDomain, applySourceLimit, loadAtsCursor, saveAtsCursor, filterByAtsCursor } from "./base.js";
import { normalizeJob } from "../core/schema.js";
import { sanitizeText, pLimit } from "../core/utils.js";
import logger from "../core/logger.js";

/** Max concurrent Lever API requests. */
const CONCURRENCY = 3;

/**
 * Extract company slug from a Lever URL or plain string.
 * Supports:
 *   - https://api.lever.co/v0/postings/{slug}
 *   - https://jobs.lever.co/{slug}
 *   - Plain slug
 *
 * @param {string} urlOrSlug
 * @returns {string}
 */
function extractSlug(urlOrSlug) {
  try {
    const url = new URL(urlOrSlug);
    let pathname = url.pathname;
    if (pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    const parts = pathname.split("/").filter(Boolean);
    // /v0/postings/{slug} → slug at index 2
    const postingsIdx = parts.indexOf("postings");
    if (postingsIdx >= 0 && parts[postingsIdx + 1])
      return parts[postingsIdx + 1];
    // /slug → slug at index 0
    if (parts.length > 0) return parts[parts.length - 1];
  } catch {
    // Plain slug
  }
  // Remove ?mode=json if it was passed generically without URL wrapper
  return urlOrSlug.split("?")[0];
}

/**
 * Build the API URL for a Lever company.
 * @param {string} slug
 * @returns {string}
 */
function buildApiUrl(slug) {
  return `https://api.lever.co/v0/postings/${slug}?mode=json`;
}

/**
 * Normalize a single Lever posting into a RawJob.
 *
 * Lever JSON shape:
 * {
 *   id, text, descriptionPlain, description,
 *   categories: { commitment, department, location, team },
 *   hostedUrl, createdAt, lists: [{ text, content }]
 * }
 */
function normalizeLeverJob(posting, source) {
  const categories = [];
  if (posting.categories) {
    if (posting.categories.department)
      categories.push(posting.categories.department);
    if (posting.categories.commitment)
      categories.push(posting.categories.commitment);
    if (posting.categories.location)
      categories.push(posting.categories.location);
    if (posting.categories.team) categories.push(posting.categories.team);
  }

  // Build content from descriptionPlain + lists
  let content = posting.descriptionPlain || posting.description || "";
  if (posting.lists && Array.isArray(posting.lists)) {
    for (const list of posting.lists) {
      if (list.text) content += ` ${list.text}`;
      if (list.content) content += ` ${list.content}`;
    }
  }

  return normalizeJob(
    {
      id: `lever-${posting.id}`,
      title: posting.text || "",
      content: sanitizeText(content),
      link: posting.hostedUrl || "",
      pubDate: posting.createdAt
        ? new Date(posting.createdAt).toISOString()
        : "",
      isoDate: posting.createdAt
        ? new Date(posting.createdAt).toISOString()
        : "",
      categories,
      company: source.name || "",
    },
    {
      url: source.url,
      name: source.name || "Lever",
      type: "lever",
    },
  );
}

/**
 * Fetch jobs from a single Lever company.
 *
 * @param {object} source  - { url, name }
 * @param {object} config
 * @returns {Promise<{ feedUrl: string, sourceName: string, items: RawJob[], error?: string }>}
 */
async function fetchSingleBoard(source, config, kv) {
  const slug = extractSlug(source.url);
  const apiUrl = buildApiUrl(slug);

  try {
    await rateLimitDomain(apiUrl);
    const res = await fetchWithTimeout(apiUrl);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    // Lever returns an array directly
    const postings = Array.isArray(data) ? data : [];

    const allItems = applySourceLimit(postings.map((p) => normalizeLeverJob(p, source)));

    // ATS cursor: filter out previously seen jobs
    const cursorIds = await loadAtsCursor(kv, 'lever', slug);
    const { newItems, cursorSkipped } = filterByAtsCursor(allItems, cursorIds);

    // Only update cursor if new items were found (saves KV write)
    if (newItems.length > 0) {
      for (const item of allItems) cursorIds.add(item.id);
      await saveAtsCursor(kv, 'lever', slug, cursorIds);
    }

    logger.info(`[Lever] ${source.name}: ${newItems.length} new / ${cursorSkipped} cursor-skipped / ${allItems.length} total`);

    return {
      feedUrl: source.url,
      sourceName: source.name || slug,
      items: newItems,
      cursorSkipped,
    };
  } catch (err) {
    const msg = err.name === "AbortError" ? "Timeout" : err.message;
    logger.warn(`[Lever] ${source.name || slug} failed: ${msg}`);
    return {
      feedUrl: source.url,
      sourceName: source.name || slug,
      items: [],
      error: msg,
    };
  }
}

/**
 * Fetch jobs from all Lever sources.
 *
 * @param {object[]} sources
 * @param {object} config
 * @returns {Promise<Array<{ feedUrl: string, sourceName: string, items: RawJob[], error?: string }>>}
 */
export async function fetchLeverJobs(sources, config, kv) {
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
