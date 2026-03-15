/**
 * @module searchExpander
 * @description Search-based job source expansion — the outer growth layer.
 *
 * Periodically runs niche-specific search queries using a multi-backend
 * search chain (Bing → Brave → static fallback) to discover new company
 * domains. Discovered domains are piped through:
 *   1. ATS pattern detection → auto-register ATS sources
 *   2. Career page detection → queue for probing
 *
 * FIX v2: Replaced DuckDuckGo-only backend (blocked after 1-2 days) with:
 *   - Bing HTML scraping (more lenient to automated requests)
 *   - Brave search scraping (secondary backend)
 *   - Static fallback list of high-value ATS boards (always runs if all backends fail)
 *   - CAPTCHA / rate-limit detection: checks html length + known signals
 *   - All errors are LOGGED (not swallowed) and discovery stats saved to KV
 */

import { fetchWithTimeout } from "../connectors/base.js";
import { detectAtsSources } from "./sourceDiscovery.js";
import { registerDomain } from "./careerDetector.js";
import { registerDiscoveredSource } from "../db/index.js";
import logger from "../core/logger.js";

// ── Search Backends ─────────────────────────────────────────────────────────

/**
 * Ordered list of search backends. Each is tried in sequence until one succeeds.
 * FIX: DuckDuckGo removed (rate-limits after 1-2 days, returns CAPTCHA silently).
 */
const SEARCH_BACKENDS = [
  {
    name: "bing",
    buildUrl: (q) =>
      `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20&setlang=en`,
    extractUrls: extractBingResultUrls,
  },
  {
    name: "brave",
    buildUrl: (q) =>
      `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`,
    extractUrls: extractGenericResultUrls,
  },
  {
    name: "google_cse",
    buildUrl: (q, env) => {
      // Uses Google Custom Search Engine API if keys are configured
      const apiKey = env?.GOOGLE_CSE_API_KEY || "";
      const cseId = env?.GOOGLE_CSE_ID || "";
      if (!apiKey || !cseId) return null;
      return `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&q=${encodeURIComponent(q)}&num=10`;
    },
    extractUrls: extractGoogleCseUrls,
    isJson: true,
    name: "yahoo",
    buildUrl: (q) =>
      `https://search.yahoo.com/search?p=${encodeURIComponent(q)}&n=20`,
    extractUrls: extractGenericResultUrls,
  },
];

/** KV key for tracking discovery run stats (read by daily report). */
const DISCOVERY_STATS_KEY = "discovery:last_run_stats";

/** KV key for tracking last successful discovery timestamp. */
const DISCOVERY_SUCCESS_KEY = "discovery:last_success_timestamp";

/** Estimated max KV writes per day on free tier. */
const FREE_TIER_DAILY_KV_WRITES = 1000;

/** Max KV writes this module should consume per expansion run. */
const MAX_KV_WRITES_PER_RUN = 3;

/** Cache TTL for search query results — 24 hours. */
const SEARCH_CACHE_TTL = 24 * 60 * 60;

// ── Search Query Cache (Fix 5) ───────────────────────────────────────────────

/**
 * Hash a query string to a short cache key.
 * @param {string} query
 * @returns {string}
 */
function hashQuery(query) {
  let h = 0x811c9dc5;
  const normalized = query.toLowerCase().trim();
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * Search with KV-backed 24h cache to avoid repeated identical API calls.
 * Fix 5: Prevents unnecessary search engine queries for the same terms.
 *
 * @param {string} query
 * @param {KVNamespace} [kv]
 * @returns {Promise<string[]>} URLs from search results.
 */
async function searchWithCache(query, kv, env) {
  const cacheKey = `search:cache:${hashQuery(query)}`;

  // Try cache first
  if (kv) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached) {
        const urls = JSON.parse(cached);
        logger.info(
          `[SearchExpander] Cache HIT for "${query}" (${urls.length} URLs)`,
        );
        return urls;
      }
    } catch {
      // Cache miss or parse error — proceed with live search
    }
  }

  // Cache miss — perform live search
  const urls = await searchMultiBackend(query, env);

  // Store result in cache (only if we got results)
  if (kv && urls.length > 0) {
    try {
      await kvPutWithRetry(kv, cacheKey, JSON.stringify(urls), {
        expirationTtl: SEARCH_CACHE_TTL,
      });
    } catch (err) {
      // Non-critical — cache write failure doesn't affect functionality
      logger.warn(
        `[SearchExpander] Cache write failed for "${query}": ${err.message}`,
      );
    }
  }

  return urls;
}

// ── KV Write with Exponential Backoff ────────────────────────────────────────

/**
 * Write to KV with exponential backoff retry for 429 rate-limit errors.
 * Other errors are thrown immediately (no retry).
 *
 * @param {KVNamespace} kv
 * @param {string} key
 * @param {string} value
 * @param {object} [options] - KV put options (e.g. expirationTtl)
 * @param {number} [maxRetries=5]
 * @returns {Promise<void>}
 */
async function kvPutWithRetry(kv, key, value, options = {}, maxRetries = 5) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await kv.put(key, value, options);
      return; // Success
    } catch (err) {
      lastErr = err;
      const is429 =
        err.message?.includes("429") ||
        err.message?.toLowerCase().includes("rate limit") ||
        err.message?.toLowerCase().includes("too many requests");

      if (!is429 || attempt >= maxRetries) {
        // Non-retryable error or exhausted retries — throw immediately
        throw err;
      }

      // Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms + jitter
      const delay = Math.pow(2, attempt) * 100 + Math.random() * 100;
      logger.warn(
        `[SearchExpander] KV write rate-limited (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms...`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Run search-based expansion for a list of queries.
 *
 * @param {D1Database} db
 * @param {string[]} queries - Search queries to run.
 * @param {Set<string>} knownSourceUrls - Already registered source URLs.
 * @param {KVNamespace} [kv] - Optional KV for rate-limit state + stats tracking.
 * @param {number} [maxSearches=8] - Max queries per cycle (hard cap).
 * @param {number} [maxDomainsPerSearch=20] - Max domains to extract per search.
 * @returns {Promise<{ newAtsSources: number, newDomains: number }>}
 */
export async function runSearchExpansion(
  db,
  queries,
  knownSourceUrls,
  kv = null,
  maxSearches = 8,
  maxDomainsPerSearch = 20,
  env = null,
) {
  let totalNewAts = 0;
  let totalNewDomains = 0;

  // ── Discovery stats tracking (FIX: errors are logged, not swallowed) ────
  const stats = {
    attempted: 0,
    discovered: 0,
    failed: 0,
    domainsQueued: 0,
    fallbackRegistered: 0,
    kvWritesUsed: 0,
    errors: [],
    timestamp: new Date().toISOString(),
  };

  // ── Query selection: random subset capped at maxSearches ─────────────────
  const shuffled = [...queries].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, maxSearches);

  for (const query of selected) {
    stats.attempted++;
    try {
      // Fix 5: Use cached search results to avoid repeated API calls
      const urls = await searchWithCache(query, kv, env);

      if (!urls.length) {
        logger.info(`[SearchExpander] No results for query: "${query}"`);
        continue;
      }

      // 1. Check for ATS patterns in search results
      const atsSources = detectAtsSources(urls, knownSourceUrls);
      for (const src of atsSources) {
        await registerDiscoveredSource(db, src);
        knownSourceUrls.add(src.url);
        totalNewAts++;
        stats.discovered++;
      }

      // 2. Extract unique domains and queue for career page detection
      const domains = extractDomains(urls, maxDomainsPerSearch);
      for (const { domain, sourceUrl } of domains) {
        await registerDomain(db, domain, sourceUrl, "search");
        totalNewDomains++;
        stats.domainsQueued++;
      }

      logger.info(
        `[SearchExpander] Query "${query}": ${urls.length} URLs, ${atsSources.length} ATS, ${domains.length} domains`,
      );
    } catch (err) {
      // FIX: errors are LOGGED, not silently swallowed
      stats.failed++;
      stats.errors.push(err.message);
      logger.error(`[SearchExpander] Query "${query}" failed: ${err.message}`);
    }

    // Polite delay between searches
    await sleep(2000 + Math.random() * 1000);
  }

  // ── Always probe static fallback ATS boards (even if search backends failed) ──
  const fallbackSources = getStaticFallbackSources();
  for (const src of fallbackSources) {
    if (!knownSourceUrls.has(src.url)) {
      try {
        await registerDiscoveredSource(db, src);
        knownSourceUrls.add(src.url);
        totalNewAts++;
        stats.discovered++;
        stats.fallbackRegistered++;
        logger.info(`[SearchExpander] Static fallback registered: ${src.name}`);
      } catch (err) {
        logger.warn(
          `[SearchExpander] Failed to register fallback ${src.url}: ${err.message}`,
        );
      }
    }
  }

  // ── Persist discovery stats to KV (with retry + budget tracking) ───────────
  if (kv) {
    try {
      // Write 1: Discovery stats (always — this is critical for the daily report)
      await kvPutWithRetry(kv, DISCOVERY_STATS_KEY, JSON.stringify(stats), {
        expirationTtl: 60 * 60 * 48, // 48h TTL
      });
      stats.kvWritesUsed++;

      // Write 2: Last success timestamp (only if new sources were discovered)
      if (stats.discovered > 0) {
        await kvPutWithRetry(
          kv,
          DISCOVERY_SUCCESS_KEY,
          new Date().toISOString(),
          { expirationTtl: 60 * 60 * 24 * 7 }, // 7 days
        );
        stats.kvWritesUsed++;
      }

      logger.info(
        `[SearchExpander] KV persistence complete: ${stats.kvWritesUsed} writes used (budget: ${MAX_KV_WRITES_PER_RUN}/run)`,
      );
    } catch (err) {
      // After retry exhaustion, log but don't crash — DB writes already persisted the sources
      logger.error(
        `[SearchExpander] KV write failed after retries: ${err.message} — stats may be stale but sources are safe in DB`,
      );
      stats.errors.push(`KV write failed: ${err.message}`);
    }
  }

  // ── End-of-run summary log ────────────────────────────────────────────────
  logger.info(
    `[SearchExpander] Expansion complete: ` +
      `queries=${stats.attempted}, ` +
      `ats=${totalNewAts}, ` +
      `domains=${totalNewDomains}, ` +
      `fallbacks=${stats.fallbackRegistered}, ` +
      `failed=${stats.failed}, ` +
      `kvWrites=${stats.kvWritesUsed}`,
  );

  return { newAtsSources: totalNewAts, newDomains: totalNewDomains };
}

// ── Multi-Backend Search ────────────────────────────────────────────────────

/**
 * Try each search backend in order until one returns results.
 * Falls back gracefully without throwing.
 *
 * @param {string} query
 * @returns {Promise<string[]>} Extracted URLs from search results.
 */
async function searchMultiBackend(query, env) {
  for (const backend of SEARCH_BACKENDS) {
    try {
      const url = backend.buildUrl(query, env);
      if (!url) continue; // Backend not configured (e.g. missing API key)

      const headers = backend.isJson
        ? { Accept: "application/json", "User-Agent": "JobHunterBot/5.1" }
        : {
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate",
            DNT: "1",
          };

      const res = await fetchWithTimeout(url, { headers }, 12_000);

      if (!res.ok) {
        logger.warn(
          `[SearchExpander] ${backend.name} returned HTTP ${res.status} — trying next backend`,
        );
        continue;
      }

      const text = await res.text();

      // Skip CAPTCHA/rate-limit detection for JSON APIs
      if (!backend.isJson) {
        if (
          text.length < 500 ||
          text.toLowerCase().includes("captcha") ||
          text.toLowerCase().includes("unusual traffic") ||
          text.toLowerCase().includes("access denied") ||
          text.toLowerCase().includes("rate limit")
        ) {
          logger.warn(
            `[SearchExpander] ${backend.name} appears rate-limited or blocked (html=${text.length} chars) — trying next backend`,
          );
          continue;
        }
      }

      const urls = backend.extractUrls(text);

      if (urls.length === 0) {
        logger.warn(
          `[SearchExpander] ${backend.name} returned 0 URLs for "${query}" — trying next backend`,
        );
        continue;
      }

      logger.info(
        `[SearchExpander] ${backend.name} found ${urls.length} URLs for "${query}"`,
      );
      return urls;
    } catch (err) {
      logger.warn(
        `[SearchExpander] ${backend.name} error: ${err.message} — trying next backend`,
      );
      // Wait before trying the next backend to cool down IP block rates
      await sleep(2000 + Math.random() * 2000);
    }
  }

  logger.warn(
    `[SearchExpander] All search backends failed for "${query}" — returning empty`,
  );
  return [];
}

// ── URL Extractors ─────────────────────────────────────────────────────────

/**
 * Extract result URLs from Bing HTML response.
 * Bing wraps results in <cite> tags and <a class="tilk"> / <a class="sh_favicon"> elements.
 * @param {string} html
 * @returns {string[]}
 */
function extractBingResultUrls(html) {
  const urls = [];

  // Bing result links are typically <a class="tilk" href="..."> or <h2><a href="...">
  // Also found in <cite> elements as plain text URLs
  const hrefRegex = /<a[^>]+href=["']((https?:\/\/[^"'<>\s]+))["'][^>]*>/gi;
  let match;

  while ((match = hrefRegex.exec(html)) !== null) {
    const url = match[1];
    // Skip Bing-internal links
    if (
      url.includes("bing.com") ||
      url.includes("microsoft.com") ||
      url.includes("msn.com")
    )
      continue;
    if (url.includes("go.microsoft")) continue;
    try {
      new URL(url);
      urls.push(url);
    } catch {
      /* invalid URL */
    }
  }

  return [...new Set(urls)];
}

/**
 * Generic URL extractor — works with Brave, Yahoo, and similar search engines.
 * Extracts all external hrefs from anchor tags.
 * @param {string} html
 * @returns {string[]}
 */
function extractGenericResultUrls(html) {
  const urls = [];
  const hrefRegex = /href=["']((https?:\/\/[^"'<>\s#?]+))["']/gi;
  let match;

  while ((match = hrefRegex.exec(html)) !== null) {
    const url = match[1];
    // Skip search engine internal links
    if (
      url.includes("brave.com") ||
      url.includes("duckduckgo.com") ||
      url.includes("google.com") ||
      url.includes("yahoo.com")
    )
      continue;
    try {
      new URL(url);
      urls.push(url);
    } catch {
      /* invalid URL */
    }
  }

  return [...new Set(urls)];
}

/**
 * Extract URLs from Google Custom Search API JSON response.
 * @param {string} jsonText - Raw JSON response text
 * @returns {string[]}
 */
function extractGoogleCseUrls(jsonText) {
  const urls = [];
  try {
    const data = JSON.parse(jsonText);
    const items = data.items || [];
    for (const item of items) {
      if (item.link) {
        try {
          new URL(item.link);
          urls.push(item.link);
        } catch {
          /* invalid URL */
        }
      }
    }
  } catch {
    // JSON parse failed — return empty
  }
  return [...new Set(urls)];
}

// ── Static Fallback Sources ─────────────────────────────────────────────────

/**
 * Return a hardcoded list of high-value ATS board URLs.
 * These are probed on every discovery cycle regardless of search backend health.
 * Ensures the system always has fresh sources even when all search backends fail.
 *
 * @returns {object[]} Source entries compatible with source_registry.
 */
function getStaticFallbackSources() {
  return [
    // Greenhouse boards
    {
      url: "https://boards-api.greenhouse.io/v1/boards/vercel/jobs",
      type: "greenhouse",
      name: "Vercel",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://boards-api.greenhouse.io/v1/boards/stripe/jobs",
      type: "greenhouse",
      name: "Stripe",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://boards-api.greenhouse.io/v1/boards/hashicorp/jobs",
      type: "greenhouse",
      name: "HashiCorp",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://boards-api.greenhouse.io/v1/boards/discord/jobs",
      type: "greenhouse",
      name: "Discord",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://boards-api.greenhouse.io/v1/boards/figma/jobs",
      type: "greenhouse",
      name: "Figma",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://boards-api.greenhouse.io/v1/boards/netlify/jobs",
      type: "greenhouse",
      name: "Netlify",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    // Lever boards
    {
      url: "https://api.lever.co/v0/postings/linear",
      type: "lever",
      name: "Linear",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.lever.co/v0/postings/notion",
      type: "lever",
      name: "Notion",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.lever.co/v0/postings/airtable",
      type: "lever",
      name: "Airtable",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.lever.co/v0/postings/remote",
      type: "lever",
      name: "Remote",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.lever.co/v0/postings/descript",
      type: "lever",
      name: "Descript",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    // Ashby boards
    {
      url: "https://api.ashbyhq.com/posting-api/job-board/retool",
      type: "ashby",
      name: "Retool",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.ashbyhq.com/posting-api/job-board/supabase",
      type: "ashby",
      name: "Supabase",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.ashbyhq.com/posting-api/job-board/cal",
      type: "ashby",
      name: "Cal.com",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.ashbyhq.com/posting-api/job-board/clerk",
      type: "ashby",
      name: "Clerk",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.ashbyhq.com/posting-api/job-board/dub",
      type: "ashby",
      name: "Dub.co",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.ashbyhq.com/posting-api/job-board/plane",
      type: "ashby",
      name: "Plane",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    // Workable boards
    {
      url: "https://apply.workable.com/api/v3/accounts/browserbase/jobs",
      type: "workable",
      name: "Browserbase",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    // SmartRecruiters boards
    {
      url: "https://api.smartrecruiters.com/v1/companies/visa/postings",
      type: "smartrecruiters",
      name: "Visa",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.smartrecruiters.com/v1/companies/bosch/postings",
      type: "smartrecruiters",
      name: "Bosch",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.smartrecruiters.com/v1/companies/spotify/postings",
      type: "smartrecruiters",
      name: "Spotify",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    // Recruitee boards
    {
      url: "https://paradox.recruitee.com/api/offers",
      type: "recruitee",
      name: "Paradox",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    // Additional Greenhouse (high-value companies)
    {
      url: "https://boards-api.greenhouse.io/v1/boards/cloudflare/jobs",
      type: "greenhouse",
      name: "Cloudflare",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://boards-api.greenhouse.io/v1/boards/datadog/jobs",
      type: "greenhouse",
      name: "Datadog",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://boards-api.greenhouse.io/v1/boards/mongodb/jobs",
      type: "greenhouse",
      name: "MongoDB",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://boards-api.greenhouse.io/v1/boards/grafanalabs/jobs",
      type: "greenhouse",
      name: "Grafana Labs",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://boards-api.greenhouse.io/v1/boards/snyk/jobs",
      type: "greenhouse",
      name: "Snyk",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://boards-api.greenhouse.io/v1/boards/cockroachlabs/jobs",
      type: "greenhouse",
      name: "CockroachDB",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    // Additional Lever (high-value companies)
    {
      url: "https://api.lever.co/v0/postings/stripe",
      type: "lever",
      name: "Stripe",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.lever.co/v0/postings/deel",
      type: "lever",
      name: "Deel",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.lever.co/v0/postings/mercury",
      type: "lever",
      name: "Mercury",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.lever.co/v0/postings/webflow",
      type: "lever",
      name: "Webflow",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    // Additional Ashby (high-value companies)
    {
      url: "https://api.ashbyhq.com/posting-api/job-board/posthog",
      type: "ashby",
      name: "PostHog",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.ashbyhq.com/posting-api/job-board/resend",
      type: "ashby",
      name: "Resend",
      enabled: true,
      discovery_origin: "static_fallback",
    },
    {
      url: "https://api.ashbyhq.com/posting-api/job-board/linear",
      type: "ashby",
      name: "Linear",
      enabled: true,
      discovery_origin: "static_fallback",
    },
  ];
}

// ── Domain Extraction ───────────────────────────────────────────────────────

/** Domains to skip (too big/generic to be useful sources). */
const SKIP_DOMAINS = new Set([
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "monster.com",
  "ziprecruiter.com",
  "angel.co",
  "wellfound.com",
  "dice.com",
  "google.com",
  "youtube.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "github.com",
  "stackoverflow.com",
  "reddit.com",
  "medium.com",
  "wikipedia.org",
  "amazon.com",
  "apple.com",
  "microsoft.com",
  "duckduckgo.com",
  "bing.com",
  "yahoo.com",
  "brave.com",
  "boards.greenhouse.io",
  "jobs.lever.co",
  "jobs.ashbyhq.com",
  "apply.workable.com", // Already handled by ATS detection
]);

/**
 * Extract unique company domains from URLs (excluding known job boards/ATS).
 *
 * @param {string[]} urls
 * @param {number} maxDomains
 * @returns {Array<{domain: string, sourceUrl: string}>}
 */
function extractDomains(urls, maxDomains) {
  const seen = new Set();
  const results = [];

  for (const url of urls) {
    if (results.length >= maxDomains) break;

    try {
      const parsed = new URL(url);
      const domain = parsed.hostname.replace(/^www\./, "");

      if (SKIP_DOMAINS.has(domain)) continue;
      if (seen.has(domain)) continue;
      seen.add(domain);

      results.push({ domain, sourceUrl: url });
    } catch {
      continue;
    }
  }

  return results;
}

// ── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
