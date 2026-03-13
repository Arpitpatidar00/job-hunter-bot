/**
 * @module connectors/base
 * @description Shared connector utilities — fetch with timeout, rate limiting,
 * source validation, and consistent stat building.
 *
 * Every connector imports from this module to ensure consistent behavior
 * across RSS, Greenhouse, Lever, Ashby, Workable, etc.
 */

import logger from "../core/logger.js";

// ── Per-Source Job Limit ────────────────────────────────────────────────────

/**
 * Maximum number of jobs to process from any single source per crawl.
 * Prevents flood from large ATS boards (some companies have 500+ listings).
 */
export const MAX_JOBS_PER_SOURCE = 50;

/**
 * Cap the number of items returned by a connector to prevent job floods.
 * @param {Array} items - Fetched items
 * @param {number} [max] - Override limit
 * @returns {Array} Capped items
 */
export function applySourceLimit(items, max = MAX_JOBS_PER_SOURCE) {
  if (!items || items.length <= max) return items;
  logger.info(`[SourceLimit] Capping ${items.length} items to ${max}`);
  return items.slice(0, max);
}

// ── ATS Cursor System (Fix 1) ──────────────────────────────────────────────

/** Maximum number of IDs to store in cursor (prevents KV value bloat) */
const MAX_CURSOR_IDS = 500;

/**
 * Load previously-seen job IDs for an ATS source from KV.
 * @param {KVNamespace|null} kv
 * @param {string} connectorType - e.g. 'greenhouse', 'lever'
 * @param {string} slug - Company slug
 * @returns {Promise<Set<string>>} Set of previously-seen IDs
 */
export async function loadAtsCursor(kv, connectorType, slug) {
  if (!kv) return new Set();
  try {
    const key = `cursor:${connectorType}:${slug}`;
    const raw = await kv.get(key);
    if (!raw) return new Set();
    const ids = JSON.parse(raw);
    return new Set(Array.isArray(ids) ? ids : []);
  } catch (err) {
    logger.warn(`[AtsCursor] Failed to load cursor for ${connectorType}:${slug}: ${err.message}`);
    return new Set();
  }
}

/**
 * Save seen job IDs for an ATS source to KV.
 * @param {KVNamespace|null} kv
 * @param {string} connectorType
 * @param {string} slug
 * @param {Set<string>} seenIds - All IDs seen (old + new)
 */
export async function saveAtsCursor(kv, connectorType, slug, seenIds) {
  if (!kv) return;
  try {
    const key = `cursor:${connectorType}:${slug}`;
    // Keep only most recent MAX_CURSOR_IDS to prevent KV bloat
    const idsArray = [...seenIds].slice(-MAX_CURSOR_IDS);
    await kv.put(key, JSON.stringify(idsArray), { expirationTtl: 604800 }); // 7 day TTL
  } catch (err) {
    logger.warn(`[AtsCursor] Failed to save cursor for ${connectorType}:${slug}: ${err.message}`);
  }
}

/**
 * Filter items to only include those not previously seen by the cursor.
 * Returns { newItems, cursorSkipped } for metrics.
 * @param {object[]} items - Normalized job items (must have .id field)
 * @param {Set<string>} cursorIds - Previously-seen IDs
 * @returns {{ newItems: object[], cursorSkipped: number }}
 */
export function filterByAtsCursor(items, cursorIds) {
  if (cursorIds.size === 0) return { newItems: items, cursorSkipped: 0 };
  const newItems = [];
  let cursorSkipped = 0;
  for (const item of items) {
    if (cursorIds.has(item.id)) {
      cursorSkipped++;
    } else {
      newItems.push(item);
    }
  }
  return { newItems, cursorSkipped };
}

/** Optional KV namespace for persistent rate limiting across invocations */
let _kvBinding = null;

export function setRateLimitKV(kv) {
  _kvBinding = kv;
}

const MIN_DOMAIN_INTERVAL_MS = 2000;
const RATE_LIMIT_TTL = 300; // 5 minutes TTL for rate limit keys
export const DEFAULT_TIMEOUT_MS = 10000; // 10s default fetch timeout

export async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = 2,
) {
  // Validate URL
  try {
    const parsed = new URL(url);
    if (!parsed.protocol.startsWith("http")) {
      throw new Error(`Invalid URL protocol: ${parsed.protocol}`);
    }
  } catch (err) {
    throw new Error(`Invalid URL "${url}": ${err.message}`);
  }

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "User-Agent": "JobHunterBot/5.1 (+https://github.com/job-hunter-bot)",
          Accept: "application/json",
          ...options.headers,
        },
      });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt) + Math.random() * 500;
        // Avoid logging full logger.warn since logger is not imported everywhere?
        // Ah, logger is imported at the top of base.js.
        logger.warn(
          `[Fetch] Attempt ${attempt + 1} failed for ${url} (${err.message || err.toString() || "unknown error"}). Retrying in ${Math.round(delay)}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Rate Limiting per Domain ─────────────────────────────────────────────────

/**
 * In-memory tracker for per-domain request timestamps.
 * Primary storage - fast and doesn't count toward KV limits.
 * KV is only used as fallback for cold starts.
 */
const _domainTimestamps = new Map();

/**
 * Wait if needed to respect the per-domain rate limit.
 * OPTIMIZATION: Uses in-memory Map as primary storage.
 * KV is only used for cold start recovery, not on every request.
 *
 * @param {string} url - The URL being fetched (domain extracted automatically).
 * @param {number} [minIntervalMs=2000]
 */
export async function rateLimitDomain(
  url,
  minIntervalMs = MIN_DOMAIN_INTERVAL_MS,
) {
  let domain;
  try {
    domain = new URL(url).hostname;
  } catch {
    return; // invalid URL, skip rate limiting
  }

  const now = Date.now();
  let lastTs = 0;

  // Primary: Check in-memory Map first (fast, no KV cost)
  lastTs = _domainTimestamps.get(domain) || 0;

  // Only check KV if in-memory is empty (cold start)
  if (lastTs === 0 && _kvBinding) {
    try {
      const kvKey = `ratelimit:${domain}`;
      const cached = await _kvBinding.get(kvKey);
      if (cached) {
        lastTs = parseInt(cached, 10);
        // Populate in-memory for next time
        _domainTimestamps.set(domain, lastTs);
      }
    } catch (e) {
      // Ignore KV errors, use in-memory only
    }
  }

  const elapsed = now - lastTs;

  if (elapsed < minIntervalMs) {
    const waitMs = minIntervalMs - elapsed;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const newTs = Date.now();

  // Always write to in-memory (fast)
  // Fix 13: LRU eviction — cap at 100 domains to prevent unbounded growth
  if (_domainTimestamps.size >= 100) {
    // Maps iterate in insertion order — first key is the oldest
    const oldestKey = _domainTimestamps.keys().next().value;
    _domainTimestamps.delete(oldestKey);
  }
  _domainTimestamps.set(domain, newTs);

  // OPTIMIZATION: Only write to KV occasionally (every 10th request per domain)
  // This reduces KV writes from ~960/day to ~96/day
  if (_kvBinding && Math.random() < 0.1) {
    try {
      await _kvBinding.put(`ratelimit:${domain}`, String(newTs), {
        expirationTtl: RATE_LIMIT_TTL,
      });
    } catch (e) {
      // Ignore KV errors, in-memory is sufficient
    }
  }
}

// ── Source Validation ────────────────────────────────────────────────────────

/**
 * Filter and validate sources for a specific connector type.
 *
 * @param {object[]} sources - All sources from config.
 * @param {string} type - The connector type to filter for (e.g., 'greenhouse').
 * @returns {object[]} Valid, enabled sources for this type.
 */
export function validateConnectorSources(sources, type) {
  return (sources || []).filter((s) => {
    if (s.type !== type) return false;
    if (s.enabled === false) return false;
    if (!s.url) {
      logger.warn(
        `[${type}] Source missing URL, skipping: ${s.name || "unnamed"}`,
      );
      return false;
    }
    return true;
  });
}

// ── Stat Builder ─────────────────────────────────────────────────────────────

/**
 * Build a consistent feedStats entry for observability.
 *
 * @param {object} source - Source config object `{ type, url, name }`.
 * @param {object[]} items - Normalized RawJob items.
 * @param {string|null} error - Error message or null on success.
 * @param {number} durationMs - Time taken in ms.
 * @returns {object}
 */
export function buildFeedStat(source, items, error, durationMs) {
  return {
    type: source.type,
    url: source.url,
    name: source.name || "Unknown",
    count: items.length,
    durationMs,
    success: !error,
    error: error || null,
  };
}

// ── Source List Builder ──────────────────────────────────────────────────────

/**
 * Merge `config.feeds` (legacy RSS strings/objects) with `config.sources`
 * (new multi-type array) into a single unified source list.
 *
 * @param {object} config - Full bot config.
 * @returns {object[]} Unified source list with `{ type, url, name, enabled }`.
 */
export function buildSourceList(config) {
  const sources = [];
  const seenUrls = new Set();

  // 1. Convert legacy feeds[] to source objects
  for (const entry of config.feeds || []) {
    let rawUrl = typeof entry === "string" ? entry : entry.url;
    const url = rawUrl ? decodeURIComponent(rawUrl) : rawUrl;

    let rawName =
      typeof entry === "string"
        ? hostnameLabel(url)
        : entry.name || hostnameLabel(url);
    const name = rawName ? decodeURIComponent(rawName) : rawName;

    if (url && !seenUrls.has(url)) {
      seenUrls.add(url);
      sources.push({
        type: "rss",
        url,
        name,
        enabled: true,
        etag: entry.etag,
        lastModified: entry.lastModified,
      });
    }
  }

  // 2. Merge explicit sources[] (new format)
  for (const s of config.sources || []) {
    if (s.url) {
      const url = decodeURIComponent(s.url);
      const name = decodeURIComponent(s.name || hostnameLabel(url));
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        sources.push({
          type: s.type || "rss",
          url: url,
          name: name,
          enabled: s.enabled !== false,
          metadata: s.metadata || {},
          etag: s.etag,
          lastModified: s.lastModified,
        });
      }
    }
  }

  return sources.filter((s) => s.enabled !== false);
}

/**
 * Group sources by connector type.
 *
 * @param {object[]} sources
 * @returns {Map<string, object[]>}
 */
export function groupByType(sources) {
  const groups = new Map();
  for (const s of sources) {
    const type = s.type || "rss";
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(s);
  }
  return groups;
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Derive a human-readable label from a URL hostname.
 * @param {string} url
 * @returns {string}
 */
function hostnameLabel(url) {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, "").split(".")[0];
  } catch {
    return url;
  }
}
