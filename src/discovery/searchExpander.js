/**
 * @module searchExpander
 * @description Search-based job source expansion — the outer growth layer.
 *
 * Periodically runs niche-specific search queries using DuckDuckGo HTML
 * to discover new company domains. Discovered domains are piped through:
 *   1. ATS pattern detection → auto-register ATS sources
 *   2. Career page detection → queue for probing
 *
 * This module uses DuckDuckGo's HTML search (no API key needed).
 * Rate-limited to stay within free-tier bounds.
 */

import { fetchWithTimeout } from '../connectors/base.js';
import { detectAtsSources } from './sourceDiscovery.js';
import { registerDomain } from './careerDetector.js';
import { registerDiscoveredSource } from '../db/index.js';
import logger from '../core/logger.js';

/**
 * Run search-based expansion for a list of queries.
 *
 * @param {D1Database} db
 * @param {string[]} queries - Search queries to run.
 * @param {Set<string>} knownSourceUrls - Already registered source URLs.
 * @param {number} [maxSearches=3] - Max queries per cycle.
 * @param {number} [maxDomainsPerSearch=10] - Max domains to extract per search.
 * @returns {Promise<{ newAtsSources: number, newDomains: number }>}
 */
export async function runSearchExpansion(db, queries, knownSourceUrls, maxSearches = 3, maxDomainsPerSearch = 10) {
    let totalNewAts = 0;
    let totalNewDomains = 0;

    // Pick a random subset of queries each cycle to spread coverage
    const shuffled = [...queries].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, maxSearches);

    for (const query of selected) {
        try {
            const urls = await searchDuckDuckGo(query);
            if (!urls.length) continue;

            // 1. Check for ATS patterns in search results
            const atsSources = detectAtsSources(urls, knownSourceUrls);
            for (const src of atsSources) {
                await registerDiscoveredSource(db, src);
                knownSourceUrls.add(src.url);
                totalNewAts++;
            }

            // 2. Extract unique domains and queue for career page detection
            const domains = extractDomains(urls, maxDomainsPerSearch);
            for (const { domain, sourceUrl } of domains) {
                await registerDomain(db, domain, sourceUrl);
                totalNewDomains++;
            }

            logger.info(`[SearchExpander] Query "${query}": ${urls.length} URLs, ${atsSources.length} ATS, ${domains.length} domains`);

        } catch (err) {
            logger.warn(`[SearchExpander] Failed query "${query}": ${err.message}`);
        }

        // Rate limit between searches
        await sleep(2000);
    }

    if (totalNewAts > 0 || totalNewDomains > 0) {
        logger.info(`[SearchExpander] Expansion complete: ${totalNewAts} ATS sources, ${totalNewDomains} domains queued`);
    }

    return { newAtsSources: totalNewAts, newDomains: totalNewDomains };
}

// ── DuckDuckGo HTML Search ──────────────────────────────────────────────────

/**
 * Search DuckDuckGo and extract result URLs.
 * Uses the HTML version (no API key needed).
 *
 * @param {string} query
 * @returns {Promise<string[]>} Extracted URLs from search results.
 */
async function searchDuckDuckGo(query) {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    try {
        const res = await fetchWithTimeout(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; JobHunterBot/5.1)',
                'Accept': 'text/html',
            },
        }, 10_000);

        if (!res.ok) {
            logger.warn(`[SearchExpander] DuckDuckGo returned ${res.status}`);
            return [];
        }

        const html = await res.text();
        return extractSearchResultUrls(html);

    } catch (err) {
        logger.warn(`[SearchExpander] DuckDuckGo search failed: ${err.message}`);
        return [];
    }
}

/**
 * Extract result URLs from DuckDuckGo HTML response.
 *
 * @param {string} html
 * @returns {string[]}
 */
function extractSearchResultUrls(html) {
    const urls = [];
    // DuckDuckGo HTML results use: <a rel="nofollow" class="result__a" href="...">
    const regex = /class\s*=\s*["']result__a["'][^>]*href\s*=\s*["']([^"']+)["']/gi;
    let match;

    while ((match = regex.exec(html)) !== null) {
        let url = match[1];

        // DuckDuckGo wraps URLs in redirect links, decode them
        if (url.includes('uddg=')) {
            try {
                const decoded = new URL(url);
                url = decodeURIComponent(decoded.searchParams.get('uddg') || url);
            } catch { /* use as-is */ }
        }

        // Skip DuckDuckGo internal/ad links
        if (url.includes('duckduckgo.com') || url.includes('ad.doubleclick')) continue;

        try {
            new URL(url); // Validate URL
            urls.push(url);
        } catch {
            // Invalid URL, skip
        }
    }

    return [...new Set(urls)]; // Dedup
}

// ── Domain Extraction ───────────────────────────────────────────────────────

/** Domains to skip (too big/generic to be useful sources). */
const SKIP_DOMAINS = new Set([
    'linkedin.com', 'indeed.com', 'glassdoor.com', 'monster.com',
    'ziprecruiter.com', 'angel.co', 'wellfound.com', 'dice.com',
    'google.com', 'youtube.com', 'facebook.com', 'twitter.com',
    'github.com', 'stackoverflow.com', 'reddit.com', 'medium.com',
    'wikipedia.org', 'amazon.com', 'apple.com', 'microsoft.com',
    'duckduckgo.com', 'bing.com', 'yahoo.com',
    'boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com',
    'apply.workable.com', // Already handled by ATS detection
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
            const domain = parsed.hostname.replace(/^www\./, '');

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
    return new Promise(resolve => setTimeout(resolve, ms));
}
