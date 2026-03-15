/**
 * @module discovery/vcPortfolioDiscovery
 * @description VC portfolio job aggregator discovery.
 *
 * Major VC firms (YC, a16z, Sequoia, etc.) maintain portfolio pages
 * or job aggregators that list jobs across ALL their portfolio companies.
 * A single VC portfolio page can expose 100s of companies and 1000s of jobs.
 *
 * This module:
 *   1. Fetches known VC portfolio job pages
 *   2. Extracts company names and domains from the pages
 *   3. Detects ATS sources from apply/job URLs found
 *   4. Queues new company domains for career page probing
 *
 * This is one of the highest-leverage discovery vectors — each VC endpoint
 * can yield 50-200 new sources in a single fetch.
 */

import { fetchWithTimeout, rateLimitDomain } from '../connectors/base.js';
import { detectAtsSources } from './sourceDiscovery.js';
import { registerDomain } from './careerDetector.js';
import { registerDiscoveredSource, batchRegisterDiscoveredSources } from '../db/index.js';
import logger from '../core/logger.js';

// ── VC Portfolio Endpoints ──────────────────────────────────────────────────

/**
 * Known VC portfolio job pages. Each entry defines:
 *   - name: VC firm name
 *   - url: Portfolio jobs/companies page URL
 *   - type: 'json' or 'html' — how to parse the response
 *   - extractor: Function to extract company info from the response
 */
const VC_PORTFOLIOS = [
    {
        name: 'Y Combinator (Work at a Startup)',
        url: 'https://www.workatastartup.com/companies',
        type: 'html',
        extractUrls: extractUrlsFromHtml,
    },
    {
        name: 'a16z Portfolio',
        url: 'https://a16z.com/portfolio/',
        type: 'html',
        extractUrls: extractUrlsFromHtml,
    },
    {
        name: 'Sequoia Portfolio',
        url: 'https://www.sequoiacap.com/our-companies/',
        type: 'html',
        extractUrls: extractUrlsFromHtml,
    },
    {
        name: 'Greylock Portfolio',
        url: 'https://greylock.com/portfolio/',
        type: 'html',
        extractUrls: extractUrlsFromHtml,
    },
    {
        name: 'Accel Portfolio',
        url: 'https://www.accel.com/portfolio',
        type: 'html',
        extractUrls: extractUrlsFromHtml,
    },
    {
        name: 'Index Ventures Portfolio',
        url: 'https://www.indexventures.com/portfolio/',
        type: 'html',
        extractUrls: extractUrlsFromHtml,
    },
    {
        name: 'Benchmark Portfolio',
        url: 'https://www.benchmark.com/portfolio/',
        type: 'html',
        extractUrls: extractUrlsFromHtml,
    },
    {
        name: 'NEA Portfolio',
        url: 'https://www.nea.com/portfolio',
        type: 'html',
        extractUrls: extractUrlsFromHtml,
    },
    {
        name: 'Bessemer Portfolio',
        url: 'https://www.bvp.com/portfolio',
        type: 'html',
        extractUrls: extractUrlsFromHtml,
    },
    {
        name: 'Lightspeed Portfolio',
        url: 'https://lsvp.com/portfolio/',
        type: 'html',
        extractUrls: extractUrlsFromHtml,
    },
    {
        name: 'First Round Portfolio',
        url: 'https://firstround.com/companies/',
        type: 'html',
        extractUrls: extractUrlsFromHtml,
    },
    {
        name: 'General Catalyst Portfolio',
        url: 'https://www.generalcatalyst.com/portfolio',
        type: 'html',
        extractUrls: extractUrlsFromHtml,
    },
];

/** Domains to skip (VC sites themselves, social media, etc.) */
const SKIP_DOMAINS = new Set([
    'linkedin.com', 'twitter.com', 'x.com', 'facebook.com',
    'instagram.com', 'youtube.com', 'medium.com', 'github.com',
    'google.com', 'apple.com', 'amazon.com', 'microsoft.com',
    'wikipedia.org', 'crunchbase.com', 'techcrunch.com',
    // VC sites themselves
    'a16z.com', 'sequoiacap.com', 'greylock.com', 'accel.com',
    'indexventures.com', 'benchmark.com', 'nea.com', 'bvp.com',
    'lsvp.com', 'firstround.com', 'generalcatalyst.com',
    'workatastartup.com', 'ycombinator.com',
]);

// ── URL Extractors ──────────────────────────────────────────────────────────

/**
 * Extract all external URLs from HTML content.
 * Focuses on links that point to company websites (not internal VC pages).
 */
function extractUrlsFromHtml(html) {
    const urls = [];
    const hrefRegex = /href=["'](https?:\/\/[^"'<>\s]+)["']/gi;
    let match;

    while ((match = hrefRegex.exec(html)) !== null) {
        const url = match[1];
        try {
            const parsed = new URL(url);
            const domain = parsed.hostname.replace(/^www\./, '');
            if (!SKIP_DOMAINS.has(domain)) {
                urls.push(url);
            }
        } catch {
            // Invalid URL, skip
        }
    }

    return [...new Set(urls)];
}

/**
 * Extract unique company domains from a list of URLs.
 */
function extractDomains(urls, maxDomains = 50) {
    const seen = new Set();
    const results = [];

    for (const url of urls) {
        if (results.length >= maxDomains) break;
        try {
            const parsed = new URL(url);
            const domain = parsed.hostname.replace(/^www\./, '');
            if (!SKIP_DOMAINS.has(domain) && !seen.has(domain)) {
                seen.add(domain);
                results.push({ domain, sourceUrl: url });
            }
        } catch {
            continue;
        }
    }

    return results;
}

// ── Main Discovery Function ─────────────────────────────────────────────────

/**
 * Run VC portfolio discovery cycle.
 * Fetches 1-2 VC portfolio pages per cycle (to stay within subrequest limits),
 * extracts company URLs, detects ATS sources, and queues domains.
 *
 * @param {D1Database} db
 * @param {Set<string>} knownSourceUrls - Already registered source URLs.
 * @param {KVNamespace} [kv] - Optional KV for tracking which VCs were last crawled.
 * @param {number} [maxPortfolios=2] - Max VC pages to fetch per cycle.
 * @returns {Promise<{ newAtsSources: number, newDomains: number, portfoliosFetched: number }>}
 */
export async function runVcPortfolioDiscovery(db, knownSourceUrls, kv = null, maxPortfolios = 2) {
    let totalNewAts = 0;
    let totalNewDomains = 0;
    let fetched = 0;

    // Round-robin: pick VCs that haven't been crawled recently
    const selected = await selectPortfolios(kv, maxPortfolios);

    for (const portfolio of selected) {
        try {
            await rateLimitDomain(portfolio.url, 3000);

            const res = await fetchWithTimeout(portfolio.url, {
                headers: {
                    Accept: 'text/html,application/xhtml+xml',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                },
            }, 15_000, 1);

            if (!res.ok) {
                logger.warn(`[VcDiscovery] ${portfolio.name} returned HTTP ${res.status}`);
                continue;
            }

            const html = await res.text();
            const urls = portfolio.extractUrls(html);

            if (urls.length === 0) {
                logger.info(`[VcDiscovery] ${portfolio.name}: 0 URLs extracted`);
                continue;
            }

            // 1. Detect ATS sources from URLs
            const atsSources = detectAtsSources(urls, knownSourceUrls);
            if (atsSources.length > 0) {
                await batchRegisterDiscoveredSources(db, atsSources);
                for (const src of atsSources) {
                    knownSourceUrls.add(src.url);
                }
                totalNewAts += atsSources.length;
            }

            // 2. Extract domains for career page probing
            const domains = extractDomains(urls);
            for (const { domain, sourceUrl } of domains) {
                await registerDomain(db, domain, sourceUrl, 'vc_portfolio');
                totalNewDomains++;
            }

            fetched++;

            // Mark as crawled
            if (kv) {
                try {
                    await kv.put(`vc_crawled:${hashString(portfolio.url)}`, new Date().toISOString(), {
                        expirationTtl: 3 * 24 * 60 * 60, // 3 days
                    });
                } catch { /* non-critical */ }
            }

            logger.info(
                `[VcDiscovery] ${portfolio.name}: ${urls.length} URLs, ${atsSources.length} ATS sources, ${domains.length} domains`
            );

            // Polite delay
            await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
            logger.warn(`[VcDiscovery] ${portfolio.name} failed: ${err.message}`);
        }
    }

    logger.info(
        `[VcDiscovery] Cycle complete: portfolios=${fetched}, ats=${totalNewAts}, domains=${totalNewDomains}`
    );

    return { newAtsSources: totalNewAts, newDomains: totalNewDomains, portfoliosFetched: fetched };
}

/**
 * Select which portfolios to crawl this cycle.
 * Picks ones that haven't been crawled in the last 3 days.
 */
async function selectPortfolios(kv, maxPortfolios) {
    const uncrawled = [];

    for (const portfolio of VC_PORTFOLIOS) {
        if (kv) {
            try {
                const lastCrawled = await kv.get(`vc_crawled:${hashString(portfolio.url)}`);
                if (lastCrawled) continue; // Skip recently crawled
            } catch { /* assume uncrawled */ }
        }
        uncrawled.push(portfolio);
    }

    // If all have been crawled recently, just pick random ones
    const pool = uncrawled.length > 0 ? uncrawled : VC_PORTFOLIOS;
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, maxPortfolios);
}

/**
 * Simple hash for KV keys.
 */
function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16);
}
