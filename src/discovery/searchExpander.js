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
];

/** KV key for tracking discovery run stats (read by daily report). */
const DISCOVERY_STATS_KEY = "discovery:last_run_stats";

/** KV key for tracking last successful discovery timestamp. */
const DISCOVERY_SUCCESS_KEY = "discovery:last_success_timestamp";

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
) {
  let totalNewAts = 0;
  let totalNewDomains = 0;

  // ── Discovery stats tracking (FIX: errors are logged, not swallowed) ────
  const stats = {
    attempted: 0,
    discovered: 0,
    failed: 0,
    errors: [],
    timestamp: new Date().toISOString(),
  };

  // ── Query selection: random subset capped at maxSearches ─────────────────
  const shuffled = [...queries].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, maxSearches);

  for (const query of selected) {
    stats.attempted++;
    try {
      const urls = await searchMultiBackend(query);

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
        await registerDomain(db, domain, sourceUrl);
        totalNewDomains++;
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
        logger.info(`[SearchExpander] Static fallback registered: ${src.name}`);
      } catch (err) {
        logger.warn(
          `[SearchExpander] Failed to register fallback ${src.url}: ${err.message}`,
        );
      }
    }
  }

  // ── Persist discovery stats to KV for report ─────────────────────────────
  if (kv) {
    try {
      await kv.put(DISCOVERY_STATS_KEY, JSON.stringify(stats), {
        expirationTtl: 60 * 60 * 48, // 48h TTL
      });

      // Update last success timestamp if any sources were discovered
      if (stats.discovered > 0) {
        await kv.put(DISCOVERY_SUCCESS_KEY, new Date().toISOString(), {
          expirationTtl: 60 * 60 * 24 * 7, // 7 days
        });
      }
    } catch (err) {
      logger.warn(
        `[SearchExpander] Failed to write discovery stats to KV: ${err.message}`,
      );
    }
  }

  if (totalNewAts > 0 || totalNewDomains > 0) {
    logger.info(
      `[SearchExpander] Expansion complete: ${totalNewAts} ATS sources, ${totalNewDomains} domains queued`,
    );
  }

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
async function searchMultiBackend(query) {
  for (const backend of SEARCH_BACKENDS) {
    try {
      const url = backend.buildUrl(query);
      const res = await fetchWithTimeout(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate",
            DNT: "1",
          },
        },
        12_000,
      );

      if (!res.ok) {
        logger.warn(
          `[SearchExpander] ${backend.name} returned HTTP ${res.status} — trying next backend`,
        );
        continue;
      }

      const html = await res.text();

      // ── CAPTCHA / rate-limit detection ────────────────────────────────
      if (
        html.length < 500 ||
        html.toLowerCase().includes("captcha") ||
        html.toLowerCase().includes("unusual traffic") ||
        html.toLowerCase().includes("access denied") ||
        html.toLowerCase().includes("rate limit")
      ) {
        logger.warn(
          `[SearchExpander] ${backend.name} appears rate-limited or blocked (html=${html.length} chars) — trying next backend`,
        );
        continue;
      }

      const urls = backend.extractUrls(html);

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
 * Generic URL extractor — works with Brave and similar search engines.
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
      url.includes("google.com")
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
