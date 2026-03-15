/**
 * @module discovery/datasetIngestor
 * @description Startup dataset ingestion engine.
 * Parses structured company datasets from YC startups, Product Hunt,
 * SaaS directories, and tech company registries to discover new sources.
 *
 * These are high-value, batch discovery vectors that run daily and yield
 * dozens to hundreds of new domains per cycle.
 *
 * Vectors:
 *   1. YC Company Directory — All YC startups (active + alumni)
 *   2. Product Hunt listings — Recently launched tech products
 *   3. SaaS/Tech Directories — Curated company lists
 *   4. Crunchbase-style data — Funded startup data
 */

import { fetchWithTimeout } from '../connectors/base.js';
import { registerDiscoveredSource } from '../db/index.js';
import { registerDomain } from './careerDetector.js';
import { detectAtsSources } from './sourceDiscovery.js';
import logger from '../core/logger.js';

// ── YC Company Directory ────────────────────────────────────────────────────

/**
 * Y Combinator company directory endpoints.
 * YC maintains a public API for their company directory.
 */
const YC_API_URL = 'https://yc-oss.github.io/api/batches/all.json';

/**
 * Alternate YC data sources.
 */
const YC_SOURCES = [
    'https://api.ycombinator.com/v0.1/companies?page=1&per_page=100',
    'https://yc-oss.github.io/api/companies/all.json',
];

/**
 * Ingest YC company directory data.
 * Extracts company domains and registers them for career page probing.
 *
 * @param {KVNamespace} [kv] - KV for last-ingested tracking
 * @param {number} [maxCompanies=100] - Max companies to process
 * @returns {Promise<Array<{domain: string, company: string, source: string}>>}
 */
async function ingestYCCompanies(kv, maxCompanies = 100) {
    const discoveries = [];

    // Check last ingestion timestamp
    const lastIngest = kv ? await kv.get('dataset_yc_last') : null;
    const now = Date.now();
    if (lastIngest && (now - parseInt(lastIngest, 10)) < 86400000) {
        logger.info('[DatasetIngestor] YC already ingested today, skipping');
        return discoveries;
    }

    // Try primary YC API
    for (const apiUrl of YC_SOURCES) {
        try {
            const res = await fetchWithTimeout(apiUrl, {
                headers: { Accept: 'application/json' },
            }, 15000, 1);

            if (!res.ok) continue;

            const data = await res.json();
            const companies = Array.isArray(data) ? data : (data.companies || data.results || []);

            // Process companies, extract domains
            for (const company of companies.slice(0, maxCompanies)) {
                const website = company.website || company.url || company.one_liner_url || '';
                if (!website) continue;

                try {
                    const domain = new URL(website).hostname.replace(/^www\./, '');
                    if (domain && domain.includes('.') && !isGenericDomain(domain)) {
                        discoveries.push({
                            domain,
                            company: company.name || company.company || domain,
                            source: 'yc_directory',
                        });
                    }
                } catch { /* invalid URL */ }
            }

            if (discoveries.length > 0) break; // Successfully got data from one source
        } catch (err) {
            logger.warn(`[DatasetIngestor] YC API failed (${apiUrl}): ${err.message}`);
        }
    }

    // Update last ingestion timestamp
    if (kv && discoveries.length > 0) {
        try {
            await kv.put('dataset_yc_last', String(now), { expirationTtl: 86400 * 7 });
        } catch { /* non-critical */ }
    }

    logger.info(`[DatasetIngestor] YC directory: ${discoveries.length} companies found`);
    return discoveries;
}

// ── Product Hunt Discovery ──────────────────────────────────────────────────

/**
 * Product Hunt recently launched products.
 * Uses the public RSS/Atom feed and website scraping.
 */
const PH_FEED_URL = 'https://www.producthunt.com/feed';

/**
 * Product Hunt topic pages with tech companies.
 */
const PH_TOPIC_URLS = [
    'https://www.producthunt.com/topics/developer-tools',
    'https://www.producthunt.com/topics/saas',
    'https://www.producthunt.com/topics/artificial-intelligence',
    'https://www.producthunt.com/topics/productivity',
    'https://www.producthunt.com/topics/hiring-and-recruiting',
];

/**
 * Ingest Product Hunt data for tech company domains.
 *
 * @param {KVNamespace} [kv] - KV for tracking
 * @param {number} [maxProducts=50] - Max products to process
 * @returns {Promise<Array<{domain: string, company: string, source: string}>>}
 */
async function ingestProductHunt(kv, maxProducts = 50) {
    const discoveries = [];

    const lastIngest = kv ? await kv.get('dataset_ph_last') : null;
    const now = Date.now();
    if (lastIngest && (now - parseInt(lastIngest, 10)) < 86400000) {
        return discoveries;
    }

    // Try the RSS feed first
    try {
        const res = await fetchWithTimeout(PH_FEED_URL, {
            headers: { Accept: 'application/rss+xml,application/xml,text/xml' },
        }, 10000, 1);

        if (res.ok) {
            const xml = await res.text();

            // Extract URLs from RSS feed items
            const linkRegex = /<link>(https?:\/\/www\.producthunt\.com\/posts\/[^<]+)<\/link>/gi;
            let match;
            const postUrls = [];
            while ((match = linkRegex.exec(xml)) !== null && postUrls.length < maxProducts) {
                postUrls.push(match[1]);
            }

            // Also extract any external URLs mentioned in descriptions
            const extUrlRegex = /(?:href="|url="|link>)(https?:\/\/(?!producthunt\.com)[^"<\s]+)/gi;
            while ((match = extUrlRegex.exec(xml)) !== null) {
                try {
                    const domain = new URL(match[1]).hostname.replace(/^www\./, '');
                    if (domain && domain.includes('.') && !isGenericDomain(domain)) {
                        discoveries.push({
                            domain,
                            company: domain.split('.')[0],
                            source: 'product_hunt',
                        });
                    }
                } catch { /* invalid URL */ }
            }
        }
    } catch (err) {
        logger.warn(`[DatasetIngestor] Product Hunt RSS failed: ${err.message}`);
    }

    // Try topic pages as fallback
    if (discoveries.length < 10) {
        const topicIdx = kv ? parseInt(await kv.get('ph_topic_idx') || '0', 10) : 0;
        const topicUrl = PH_TOPIC_URLS[topicIdx % PH_TOPIC_URLS.length];

        try {
            const res = await fetchWithTimeout(topicUrl, {
                headers: {
                    Accept: 'text/html',
                    'User-Agent': 'Mozilla/5.0 (compatible; JobHunterBot/5.1)',
                },
            }, 10000, 1);

            if (res.ok) {
                const html = await res.text();
                // Extract product website URLs from the page
                const websiteRegex = /href="(https?:\/\/(?!producthunt\.com|twitter\.com|x\.com|facebook\.com)[^"]+)"[^>]*target="_blank"/gi;
                let match;
                while ((match = websiteRegex.exec(html)) !== null && discoveries.length < maxProducts) {
                    try {
                        const domain = new URL(match[1]).hostname.replace(/^www\./, '');
                        if (!isGenericDomain(domain)) {
                            discoveries.push({
                                domain,
                                company: domain.split('.')[0],
                                source: 'product_hunt_topic',
                            });
                        }
                    } catch { /* invalid URL */ }
                }
            }
        } catch { /* network error */ }

        if (kv) {
            try {
                await kv.put('ph_topic_idx', String(topicIdx + 1), { expirationTtl: 86400 * 30 });
            } catch { /* non-critical */ }
        }
    }

    if (kv && discoveries.length > 0) {
        try {
            await kv.put('dataset_ph_last', String(now), { expirationTtl: 86400 * 7 });
        } catch { /* non-critical */ }
    }

    logger.info(`[DatasetIngestor] Product Hunt: ${discoveries.length} companies found`);
    return discoveries;
}

// ── SaaS / Tech Directories ────────────────────────────────────────────────

/**
 * Known SaaS directories and tech company lists.
 */
const SAAS_DIRECTORIES = [
    {
        name: 'g2_saas',
        url: 'https://www.g2.com/categories/project-management',
        extractor: extractG2Domains,
    },
    {
        name: 'alternativeto',
        url: 'https://alternativeto.net/category/developer-tools/',
        extractor: extractGenericDomains,
    },
    {
        name: 'stackshare',
        url: 'https://stackshare.io/tools/trending',
        extractor: extractGenericDomains,
    },
];

/**
 * Extract company domains from G2 pages.
 */
async function extractG2Domains(html) {
    const domains = [];
    // G2 product links pattern
    const linkRegex = /href="\/products\/([^/"]+)\/reviews"/gi;
    let match;
    while ((match = linkRegex.exec(html)) !== null && domains.length < 30) {
        // Convert G2 slug back to a probable domain
        const slug = match[1].replace(/-/g, '');
        domains.push(`${slug}.com`); // Best guess — will be validated by career probing
    }
    return domains;
}

/**
 * Extract external domains from any directory page.
 */
async function extractGenericDomains(html) {
    const domains = new Set();
    const urlRegex = /href="(https?:\/\/(?!(?:g2|alternativeto|stackshare|google|facebook|twitter|linkedin|github)\.com)[^"]+)"[^>]*(?:target="_blank"|rel="noopener")/gi;
    let match;
    while ((match = urlRegex.exec(html)) !== null && domains.size < 30) {
        try {
            const domain = new URL(match[1]).hostname.replace(/^www\./, '');
            if (domain.includes('.') && !isGenericDomain(domain)) {
                domains.add(domain);
            }
        } catch { /* invalid URL */ }
    }
    return [...domains];
}

/**
 * Ingest SaaS directory data.
 *
 * @param {KVNamespace} [kv] - KV for tracking
 * @returns {Promise<Array<{domain: string, company: string, source: string}>>}
 */
async function ingestSaasDirectories(kv) {
    const discoveries = [];

    const dirIdx = kv ? parseInt(await kv.get('saas_dir_idx') || '0', 10) : 0;
    const dir = SAAS_DIRECTORIES[dirIdx % SAAS_DIRECTORIES.length];

    try {
        const res = await fetchWithTimeout(dir.url, {
            headers: {
                Accept: 'text/html',
                'User-Agent': 'Mozilla/5.0 (compatible; JobHunterBot/5.1)',
            },
        }, 10000, 1);

        if (res.ok) {
            const html = await res.text();
            const domains = await dir.extractor(html);
            for (const domain of domains) {
                discoveries.push({
                    domain,
                    company: domain.split('.')[0],
                    source: dir.name,
                });
            }
        }
    } catch (err) {
        logger.warn(`[DatasetIngestor] SaaS directory ${dir.name} failed: ${err.message}`);
    }

    if (kv) {
        try {
            await kv.put('saas_dir_idx', String(dirIdx + 1), { expirationTtl: 86400 * 30 });
        } catch { /* non-critical */ }
    }

    return discoveries;
}

// ── Funding / VC Datasets ───────────────────────────────────────────────────

/**
 * Known funding announcement feeds (RSS/Atom).
 */
const FUNDING_FEEDS = [
    'https://techcrunch.com/category/fundraising/feed/',
    'https://news.crunchbase.com/feed/',
    'https://sifted.eu/feed',
];

/**
 * Ingest recent funding announcements to find newly funded companies.
 *
 * @param {KVNamespace} [kv] - KV for tracking
 * @returns {Promise<Array<{domain: string, company: string, source: string}>>}
 */
async function ingestFundingAnnouncements(kv) {
    const discoveries = [];

    const feedIdx = kv ? parseInt(await kv.get('funding_feed_idx') || '0', 10) : 0;
    const feedUrl = FUNDING_FEEDS[feedIdx % FUNDING_FEEDS.length];

    try {
        const res = await fetchWithTimeout(feedUrl, {
            headers: { Accept: 'application/rss+xml,application/xml,text/xml' },
        }, 10000, 1);

        if (res.ok) {
            const xml = await res.text();
            // Extract URLs from articles about funding
            const linkRegex = /<link>(https?:\/\/[^<]+)<\/link>/gi;
            let match;
            const articleUrls = [];
            while ((match = linkRegex.exec(xml)) !== null && articleUrls.length < 20) {
                articleUrls.push(match[1]);
            }

            // Fetch articles and extract mentioned company domains
            for (const articleUrl of articleUrls.slice(0, 5)) {
                try {
                    const artRes = await fetchWithTimeout(articleUrl, {
                        headers: {
                            Accept: 'text/html',
                            'User-Agent': 'Mozilla/5.0 (compatible; JobHunterBot/5.1)',
                        },
                    }, 8000, 1);

                    if (artRes.ok) {
                        const html = await artRes.text();
                        // Look for company website links in funding articles
                        const extRegex = /href="(https?:\/\/(?!techcrunch|crunchbase|sifted|twitter|linkedin|facebook)[^"]+)"[^>]*(?:target="_blank"|rel="noopener")/gi;
                        while ((match = extRegex.exec(html)) !== null && discoveries.length < 30) {
                            try {
                                const domain = new URL(match[1]).hostname.replace(/^www\./, '');
                                if (!isGenericDomain(domain)) {
                                    discoveries.push({
                                        domain,
                                        company: domain.split('.')[0],
                                        source: 'funding_announcement',
                                    });
                                }
                            } catch { /* invalid URL */ }
                        }
                    }
                } catch { /* network error */ }
            }
        }
    } catch (err) {
        logger.warn(`[DatasetIngestor] Funding feed ingestion failed: ${err.message}`);
    }

    if (kv) {
        try {
            await kv.put('funding_feed_idx', String(feedIdx + 1), { expirationTtl: 86400 * 30 });
        } catch { /* non-critical */ }
    }

    return discoveries;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const GENERIC_DOMAINS = new Set([
    'google.com', 'facebook.com', 'twitter.com', 'x.com',
    'linkedin.com', 'github.com', 'youtube.com', 'instagram.com',
    'medium.com', 'reddit.com', 'wikipedia.org', 'amazon.com',
    'apple.com', 'microsoft.com', 'stackexchange.com', 'stackoverflow.com',
    'wordpress.org', 'wordpress.com', 'w3.org', 'schema.org',
    'producthunt.com', 'crunchbase.com', 'techcrunch.com',
    'indeed.com', 'glassdoor.com', 'angellist.com', 'wellfound.com',
    'sifted.eu', 'thenextweb.com',
]);

function isGenericDomain(domain) {
    return GENERIC_DOMAINS.has(domain) || domain.length < 4;
}

// ── Main Export ─────────────────────────────────────────────────────────────

/**
 * Run dataset ingestion cycle.
 * Processes startup datasets, product launches, and funding announcements.
 *
 * Should run daily (not on every cycle) due to the batch nature of datasets.
 *
 * @param {D1Database} db - D1 database handle
 * @param {Set<string>} knownSourceUrls - Already registered source URLs
 * @param {KVNamespace} [kv] - KV for state tracking
 * @param {object} [options]
 * @param {boolean} [options.enableYC=true]
 * @param {boolean} [options.enableProductHunt=true]
 * @param {boolean} [options.enableSaasDirectories=true]
 * @param {boolean} [options.enableFunding=true]
 * @returns {Promise<{ newDomains: number, newSources: number, vectorStats: object }>}
 */
export async function runDatasetIngestion(db, knownSourceUrls, kv = null, options = {}) {
    const {
        enableYC = true,
        enableProductHunt = true,
        enableSaasDirectories = true,
        enableFunding = true,
    } = options;

    let totalNewDomains = 0;
    let totalNewSources = 0;
    const vectorStats = {};
    const seenDomains = new Set();
    const allDiscoveries = [];

    // 1. YC Companies
    if (enableYC) {
        try {
            const ycResults = await ingestYCCompanies(kv, 100);
            allDiscoveries.push(...ycResults);
            vectorStats.yc = { found: ycResults.length };
        } catch (err) {
            vectorStats.yc = { error: err.message };
        }
    }

    // 2. Product Hunt
    if (enableProductHunt) {
        try {
            const phResults = await ingestProductHunt(kv, 50);
            allDiscoveries.push(...phResults);
            vectorStats.product_hunt = { found: phResults.length };
        } catch (err) {
            vectorStats.product_hunt = { error: err.message };
        }
    }

    // 3. SaaS Directories
    if (enableSaasDirectories) {
        try {
            const saasResults = await ingestSaasDirectories(kv);
            allDiscoveries.push(...saasResults);
            vectorStats.saas_directories = { found: saasResults.length };
        } catch (err) {
            vectorStats.saas_directories = { error: err.message };
        }
    }

    // 4. Funding Announcements
    if (enableFunding) {
        try {
            const fundingResults = await ingestFundingAnnouncements(kv);
            allDiscoveries.push(...fundingResults);
            vectorStats.funding = { found: fundingResults.length };
        } catch (err) {
            vectorStats.funding = { error: err.message };
        }
    }

    // Deduplicate and register all domains
    for (const { domain, company, source } of allDiscoveries) {
        if (seenDomains.has(domain)) continue;
        seenDomains.add(domain);

        try {
            // Check for ATS sources
            const probeUrls = [
                `https://${domain}/careers`,
                `https://${domain}/jobs`,
                `https://careers.${domain}`,
            ];
            const atsSources = detectAtsSources(probeUrls, knownSourceUrls);
            for (const atsSource of atsSources) {
                await registerDiscoveredSource(db, {
                    ...atsSource,
                    name: company || atsSource.name,
                    discovery_origin: `dataset:${source}`,
                });
                totalNewSources++;
                knownSourceUrls.add(atsSource.url);
            }

            // Register domain for career page probing
            await registerDomain(db, domain, null, 'dataset');
            totalNewDomains++;
        } catch {
            // Skip registration errors
        }
    }

    logger.info(`[DatasetIngestor] Ingestion complete: ${totalNewDomains} domains, ${totalNewSources} sources from ${allDiscoveries.length} dataset entries`);

    return { newDomains: totalNewDomains, newSources: totalNewSources, vectorStats };
}
