/**
 * @module discovery/webMining
 * @description Big Data Web Mining discovery vector.
 * Ingests large web datasets to find schema.org/JobPosting structured data
 * and extract company career page URLs at scale.
 *
 * Vectors:
 *   1. Common Crawl Index API — search CC index for pages with JobPosting schema
 *   2. SEO dataset parsing — extract career pages from sitemap indexes
 *   3. Web Archive snapshots — discover historic career pages from Wayback Machine
 */

import { fetchWithTimeout } from '../connectors/base.js';
import { registerDiscoveredSource } from '../db/index.js';
import { registerDomain } from './careerDetector.js';
import { detectAtsSources } from './sourceDiscovery.js';
import logger from '../core/logger.js';

// ── Common Crawl Index API ──────────────────────────────────────────────────

/**
 * Common Crawl index API base URL.
 * CC maintains searchable indexes of all crawled URLs.
 */
const CC_INDEX_BASE = 'https://index.commoncrawl.org';

/**
 * Search queries for Common Crawl index — target pages with job postings schema.
 */
const CC_SEARCH_QUERIES = [
    '*.greenhouse.io/*/jobs/*',
    '*.lever.co/*',
    '*/careers',
    '*/jobs',
    '*/job-openings',
    '*/open-positions',
];

/**
 * Query Common Crawl index for URLs matching career/job patterns.
 * Uses the CC Index API which returns matching URLs from crawled web data.
 *
 * @param {KVNamespace} [kv] - KV for tracking which indexes were queried
 * @param {number} [maxResults=50] - Max results per query
 * @returns {Promise<string[]>} Discovered domains
 */
async function queryCommonCrawlIndex(kv, maxResults = 50) {
    const discoveredDomains = new Set();

    // Get the latest CC index collection
    let latestIndex = 'CC-MAIN-2025-13'; // Fallback to a known index
    try {
        const collRes = await fetchWithTimeout(
            `${CC_INDEX_BASE}/collinfo.json`,
            { headers: { Accept: 'application/json' } },
            10000, 1
        );
        if (collRes.ok) {
            const collections = await collRes.json();
            if (Array.isArray(collections) && collections.length > 0) {
                latestIndex = collections[0].id || latestIndex;
            }
        }
    } catch {
        // Use fallback index
    }

    // Rotate through search queries
    const queryOffset = kv ? parseInt(await kv.get('cc_query_offset') || '0', 10) : 0;
    const query = CC_SEARCH_QUERIES[queryOffset % CC_SEARCH_QUERIES.length];

    try {
        const searchUrl = `${CC_INDEX_BASE}/${latestIndex}-index?url=${encodeURIComponent(query)}&output=json&limit=${maxResults}`;
        const res = await fetchWithTimeout(searchUrl, {
            headers: { Accept: 'application/json' },
        }, 20000, 1);

        if (res.ok) {
            const text = await res.text();
            // CC index returns NDJSON (one JSON object per line)
            const lines = text.trim().split('\n');
            for (const line of lines) {
                try {
                    const record = JSON.parse(line);
                    const url = record.url || '';
                    if (url) {
                        const domain = extractDomainFromUrl(url);
                        if (domain && !isGenericDomain(domain)) {
                            discoveredDomains.add(domain);
                        }
                    }
                } catch {
                    // Skip malformed JSON lines
                }
            }
        }

        logger.info(`[WebMining] Common Crawl "${query}": ${discoveredDomains.size} domains`);
    } catch (err) {
        logger.warn(`[WebMining] Common Crawl query failed: ${err.message}`);
    }

    if (kv) {
        try {
            await kv.put('cc_query_offset', String(queryOffset + 1), { expirationTtl: 86400 * 30 });
        } catch { /* non-critical */ }
    }

    return [...discoveredDomains];
}

// ── SEO Sitemap Mining ──────────────────────────────────────────────────────

/**
 * Tech company domains known to have sitemaps with career page data.
 * We parse their sitemaps to find job listing URLs.
 */
const SITEMAP_TARGETS = [
    'https://boards.greenhouse.io/sitemap.xml',
    'https://jobs.lever.co/sitemap.xml',
    'https://wellfound.com/sitemap.xml',
    'https://builtin.com/sitemap.xml',
    'https://remoteok.com/sitemap.xml',
    'https://weworkremotely.com/sitemap.xml',
];

/**
 * Extract company domains from job board sitemaps.
 * These sitemaps contain URLs to individual company career pages.
 *
 * @param {KVNamespace} [kv] - KV for rotation tracking
 * @param {number} [maxDomains=50] - Max domains to extract
 * @returns {Promise<string[]>} Discovered domains
 */
async function mineSitemaps(kv, maxDomains = 50) {
    const domains = new Set();

    const sitemapIdx = kv ? parseInt(await kv.get('sitemap_idx') || '0', 10) : 0;
    const sitemapUrl = SITEMAP_TARGETS[sitemapIdx % SITEMAP_TARGETS.length];

    try {
        const res = await fetchWithTimeout(sitemapUrl, {
            headers: { Accept: 'application/xml,text/xml' },
        }, 15000, 1);

        if (res.ok) {
            const xml = await res.text();

            // Extract URLs from sitemap
            const urlRegex = /<loc>(https?:\/\/[^<]+)<\/loc>/gi;
            let match;
            while ((match = urlRegex.exec(xml)) !== null && domains.size < maxDomains) {
                const url = match[1];
                try {
                    const parsedUrl = new URL(url);
                    const hostname = parsedUrl.hostname;

                    // For job board sitemaps, extract company slug from URL path
                    if (hostname.includes('greenhouse.io') || hostname.includes('lever.co')) {
                        // These are ATS URLs — extract company slugs
                        const parts = parsedUrl.pathname.split('/').filter(Boolean);
                        if (parts.length > 0) {
                            // The slug itself represents a company, register it
                            // We'll let sourceDiscovery handle the ATS detection
                            domains.add(url); // Store full URL for ATS detection
                        }
                    } else {
                        const domain = hostname.replace(/^www\./, '');
                        if (!isGenericDomain(domain)) {
                            domains.add(domain);
                        }
                    }
                } catch { /* invalid URL */ }
            }
        }
    } catch (err) {
        logger.warn(`[WebMining] Sitemap mining failed for ${sitemapUrl}: ${err.message}`);
    }

    if (kv) {
        try {
            await kv.put('sitemap_idx', String(sitemapIdx + 1), { expirationTtl: 86400 * 30 });
        } catch { /* non-critical */ }
    }

    logger.info(`[WebMining] Sitemap mining: ${domains.size} entries from ${sitemapUrl}`);
    return [...domains];
}

// ── Web Archive Discovery ───────────────────────────────────────────────────

/**
 * Use the Wayback Machine CDX API to find historical career pages.
 * Domains that had career pages in the past likely still do.
 *
 * @param {KVNamespace} [kv] - KV for tracking
 * @param {number} [maxResults=30] - Max results
 * @returns {Promise<string[]>} Discovered domains
 */
async function queryWebArchive(kv, maxResults = 30) {
    const domains = new Set();

    const searchTerms = [
        '*/careers*',
        '*/jobs*',
        '*/hiring*',
    ];
    const termIdx = kv ? parseInt(await kv.get('wa_term_idx') || '0', 10) : 0;
    const term = searchTerms[termIdx % searchTerms.length];

    try {
        // Wayback Machine CDX API — search for career page snapshots
        const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(term)}&output=json&limit=${maxResults}&fl=original&filter=statuscode:200&from=20240101`;
        const res = await fetchWithTimeout(url, {
            headers: { Accept: 'application/json' },
        }, 15000, 1);

        if (res.ok) {
            const data = await res.json();
            // CDX returns array of arrays, first row is headers
            if (Array.isArray(data)) {
                for (const row of data.slice(1)) { // Skip header row
                    const originalUrl = row[0];
                    if (originalUrl) {
                        const domain = extractDomainFromUrl(originalUrl);
                        if (domain && !isGenericDomain(domain)) {
                            domains.add(domain);
                        }
                    }
                }
            }
        }
    } catch (err) {
        logger.warn(`[WebMining] Web Archive query failed: ${err.message}`);
    }

    if (kv) {
        try {
            await kv.put('wa_term_idx', String(termIdx + 1), { expirationTtl: 86400 * 30 });
        } catch { /* non-critical */ }
    }

    logger.info(`[WebMining] Web Archive: ${domains.size} domains from "${term}"`);
    return [...domains];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractDomainFromUrl(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return null;
    }
}

const GENERIC_DOMAINS = new Set([
    'google.com', 'facebook.com', 'twitter.com', 'x.com',
    'linkedin.com', 'github.com', 'youtube.com', 'instagram.com',
    'medium.com', 'reddit.com', 'wikipedia.org', 'amazon.com',
    'apple.com', 'microsoft.com', 'indeed.com', 'glassdoor.com',
    'boards.greenhouse.io', 'jobs.lever.co', 'wellfound.com',
    'builtin.com', 'remoteok.com', 'weworkremotely.com',
    'web.archive.org', 'commoncrawl.org',
]);

function isGenericDomain(domain) {
    return GENERIC_DOMAINS.has(domain) || domain.length < 4;
}

// ── Main Export ─────────────────────────────────────────────────────────────

/**
 * Run big data web mining discovery cycle.
 * Processes Common Crawl index, sitemaps, and web archive data
 * to discover company career pages at scale.
 *
 * @param {D1Database} db - D1 database handle
 * @param {Set<string>} knownSourceUrls - Already registered source URLs
 * @param {KVNamespace} [kv] - KV for state tracking
 * @param {object} [options]
 * @param {boolean} [options.enableCommonCrawl=true]
 * @param {boolean} [options.enableSitemaps=true]
 * @param {boolean} [options.enableWebArchive=true]
 * @param {number} [options.maxDomainsPerVector=30]
 * @returns {Promise<{ newDomains: number, newSources: number, vectorStats: object }>}
 */
export async function runWebMining(db, knownSourceUrls, kv = null, options = {}) {
    const {
        enableCommonCrawl = true,
        enableSitemaps = true,
        enableWebArchive = true,
        maxDomainsPerVector = 30,
    } = options;

    let totalNewDomains = 0;
    let totalNewSources = 0;
    const vectorStats = {};
    const seenDomains = new Set();

    // 1. Common Crawl Index
    if (enableCommonCrawl) {
        try {
            const ccDomains = await queryCommonCrawlIndex(kv, maxDomainsPerVector);
            vectorStats.common_crawl = { found: ccDomains.length };
            for (const domain of ccDomains) {
                if (seenDomains.has(domain)) continue;
                seenDomains.add(domain);
                await registerWebMiningDomain(db, domain, knownSourceUrls, 'common_crawl');
                totalNewDomains++;
            }
        } catch (err) {
            vectorStats.common_crawl = { error: err.message };
        }
    }

    // 2. Sitemap Mining
    if (enableSitemaps) {
        try {
            const sitemapEntries = await mineSitemaps(kv, maxDomainsPerVector);
            vectorStats.sitemaps = { found: sitemapEntries.length };
            for (const entry of sitemapEntries) {
                // Entry might be a full URL (for ATS sitemaps) or a domain
                const domain = entry.startsWith('http') ? extractDomainFromUrl(entry) : entry;
                if (!domain || seenDomains.has(domain)) continue;
                seenDomains.add(domain);

                // Try ATS detection on the full URL if it's an ATS URL
                if (entry.startsWith('http')) {
                    const atsSources = detectAtsSources([entry], knownSourceUrls);
                    for (const source of atsSources) {
                        await registerDiscoveredSource(db, {
                            ...source,
                            discovery_origin: 'web_mining:sitemap',
                        });
                        totalNewSources++;
                        knownSourceUrls.add(source.url);
                    }
                }

                await registerDomain(db, domain, null, 'web_mining');
                totalNewDomains++;
            }
        } catch (err) {
            vectorStats.sitemaps = { error: err.message };
        }
    }

    // 3. Web Archive
    if (enableWebArchive) {
        try {
            const waDomains = await queryWebArchive(kv, maxDomainsPerVector);
            vectorStats.web_archive = { found: waDomains.length };
            for (const domain of waDomains) {
                if (seenDomains.has(domain)) continue;
                seenDomains.add(domain);
                await registerWebMiningDomain(db, domain, knownSourceUrls, 'web_archive');
                totalNewDomains++;
            }
        } catch (err) {
            vectorStats.web_archive = { error: err.message };
        }
    }

    logger.info(`[WebMining] Mining complete: ${totalNewDomains} domains, ${totalNewSources} sources`);

    return { newDomains: totalNewDomains, newSources: totalNewSources, vectorStats };
}

/**
 * Register domains found via web mining.
 */
async function registerWebMiningDomain(db, domain, knownSourceUrls, origin) {
    try {
        const probeUrls = [
            `https://${domain}/careers`,
            `https://${domain}/jobs`,
            `https://careers.${domain}`,
        ];
        const atsSources = detectAtsSources(probeUrls, knownSourceUrls);
        for (const source of atsSources) {
            await registerDiscoveredSource(db, {
                ...source,
                discovery_origin: `web_mining:${origin}`,
            });
        }
        await registerDomain(db, domain, null, 'web_mining');
    } catch {
        // Skip registration errors
    }
}
