/**
 * @module discovery/apiDiscovery
 * @description Hidden job API discovery scanner.
 * Detects undocumented or semi-public job APIs on company websites by probing
 * common API endpoint patterns. Many companies use SPA frameworks (Next.js,
 * Nuxt, etc.) that expose JSON job data via internal API routes.
 *
 * Probed patterns:
 *   - /_next/data/...  (Next.js data routes)
 *   - /api/jobs        (Generic REST APIs)
 *   - /api/v1/jobs     (Versioned APIs)
 *   - /graphql         (GraphQL endpoints)
 *   - /wp-json/...     (WordPress REST APIs)
 *   - /feed/jobs       (Atom/RSS job feeds)
 */

import { fetchWithTimeout, rateLimitDomain } from '../connectors/base.js';
import { registerDiscoveredSource } from '../db/index.js';
import { detectAtsSources } from './sourceDiscovery.js';
import logger from '../core/logger.js';

// ── API Endpoint Patterns ───────────────────────────────────────────────────

/**
 * Common API paths that expose job listings.
 * Each pattern includes a validator to check if the response contains jobs.
 */
const API_PATTERNS = [
    {
        name: 'next_data_careers',
        buildUrl: (domain) => `https://${domain}/_next/data/careers.json`,
        validate: (data) => hasJobData(data),
        sourceType: 'career_page',
    },
    {
        name: 'api_jobs',
        buildUrl: (domain) => `https://${domain}/api/jobs`,
        validate: (data) => hasJobData(data),
        sourceType: 'career_page',
    },
    {
        name: 'api_v1_jobs',
        buildUrl: (domain) => `https://${domain}/api/v1/jobs`,
        validate: (data) => hasJobData(data),
        sourceType: 'career_page',
    },
    {
        name: 'api_v2_jobs',
        buildUrl: (domain) => `https://${domain}/api/v2/jobs`,
        validate: (data) => hasJobData(data),
        sourceType: 'career_page',
    },
    {
        name: 'api_careers',
        buildUrl: (domain) => `https://${domain}/api/careers`,
        validate: (data) => hasJobData(data),
        sourceType: 'career_page',
    },
    {
        name: 'api_positions',
        buildUrl: (domain) => `https://${domain}/api/positions`,
        validate: (data) => hasJobData(data),
        sourceType: 'career_page',
    },
    {
        name: 'api_openings',
        buildUrl: (domain) => `https://${domain}/api/openings`,
        validate: (data) => hasJobData(data),
        sourceType: 'career_page',
    },
    {
        name: 'wp_json_jobs',
        buildUrl: (domain) => `https://${domain}/wp-json/wp/v2/job-listings`,
        validate: (data) => Array.isArray(data) && data.length > 0,
        sourceType: 'career_page',
    },
    {
        name: 'wp_json_job_listing',
        buildUrl: (domain) => `https://${domain}/wp-json/wp/v2/job_listing`,
        validate: (data) => Array.isArray(data) && data.length > 0,
        sourceType: 'career_page',
    },
    {
        name: 'careers_json',
        buildUrl: (domain) => `https://${domain}/careers.json`,
        validate: (data) => hasJobData(data),
        sourceType: 'career_page',
    },
    {
        name: 'jobs_json',
        buildUrl: (domain) => `https://${domain}/jobs.json`,
        validate: (data) => hasJobData(data),
        sourceType: 'career_page',
    },
    {
        name: 'feed_jobs',
        buildUrl: (domain) => `https://${domain}/feed/jobs`,
        validate: null, // Will check for XML/RSS content
        sourceType: 'rss',
        isRss: true,
    },
    {
        name: 'jobs_rss',
        buildUrl: (domain) => `https://${domain}/jobs/feed`,
        validate: null,
        sourceType: 'rss',
        isRss: true,
    },
    {
        name: 'careers_rss',
        buildUrl: (domain) => `https://${domain}/careers/feed`,
        validate: null,
        sourceType: 'rss',
        isRss: true,
    },
];

/**
 * GraphQL query to detect job listings.
 */
const GRAPHQL_JOB_QUERY = {
    query: `{ jobs { id title } }`,
    operationName: null,
    variables: {},
};

// ── Validators ──────────────────────────────────────────────────────────────

/**
 * Check if a JSON response contains job-like data.
 */
function hasJobData(data) {
    if (!data) return false;

    // Direct array of jobs
    if (Array.isArray(data) && data.length > 0) {
        return data.some(item =>
            item.title || item.name || item.position || item.role
        );
    }

    // Nested in common wrapper keys
    const jobKeys = ['jobs', 'positions', 'openings', 'postings', 'results',
        'data', 'items', 'listings', 'vacancies', 'careers'];
    for (const key of jobKeys) {
        if (data[key] && Array.isArray(data[key]) && data[key].length > 0) {
            return true;
        }
    }

    // Check for job-like structure
    if (data.total && data.total > 0) return true;
    if (data.count && data.count > 0) return true;
    if (data.totalCount && data.totalCount > 0) return true;

    return false;
}

/**
 * Check if text content is an RSS/Atom feed.
 */
function isRssFeed(text) {
    if (!text) return false;
    const lower = text.slice(0, 500).toLowerCase();
    return lower.includes('<rss') || lower.includes('<feed') || lower.includes('<channel');
}

// ── Main Scanner ────────────────────────────────────────────────────────────

/**
 * Probe a single domain for hidden job APIs.
 *
 * @param {string} domain
 * @param {Set<string>} knownSourceUrls
 * @returns {Promise<Array<{url: string, type: string, pattern: string}>>}
 */
async function probeDomainApis(domain, knownSourceUrls) {
    const discovered = [];

    // Probe standard API patterns
    for (const pattern of API_PATTERNS) {
        const url = pattern.buildUrl(domain);
        if (knownSourceUrls.has(url)) continue;

        try {
            await rateLimitDomain(url, 1000);

            const headers = pattern.isRss
                ? { Accept: 'application/xml,text/xml,application/rss+xml' }
                : { Accept: 'application/json' };

            const res = await fetchWithTimeout(url, { headers }, 6000, 1);

            if (!res.ok) continue;

            if (pattern.isRss) {
                const text = await res.text();
                if (isRssFeed(text)) {
                    discovered.push({
                        url,
                        type: 'rss',
                        pattern: pattern.name,
                        name: `${domain} Jobs Feed`,
                    });
                    logger.info(`[ApiDiscovery] Found RSS job feed: ${url}`);
                    break; // One RSS feed per domain is enough
                }
            } else {
                const data = await res.json();
                if (pattern.validate(data)) {
                    discovered.push({
                        url,
                        type: pattern.sourceType,
                        pattern: pattern.name,
                        name: `${domain} Jobs API`,
                    });
                    logger.info(`[ApiDiscovery] Found hidden job API: ${url} (${pattern.name})`);
                    break; // One API per domain is enough
                }
            }
        } catch {
            // Network error or parse error — continue to next pattern
        }
    }

    // Probe GraphQL endpoint
    if (discovered.length === 0) {
        try {
            const gqlUrl = `https://${domain}/graphql`;
            await rateLimitDomain(gqlUrl, 1000);

            const res = await fetchWithTimeout(gqlUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify(GRAPHQL_JOB_QUERY),
            }, 6000, 1);

            if (res.ok) {
                const data = await res.json();
                if (data?.data?.jobs && Array.isArray(data.data.jobs) && data.data.jobs.length > 0) {
                    discovered.push({
                        url: gqlUrl,
                        type: 'career_page',
                        pattern: 'graphql',
                        name: `${domain} GraphQL Jobs`,
                    });
                    logger.info(`[ApiDiscovery] Found GraphQL job endpoint: ${gqlUrl}`);
                }
            }
        } catch {
            // GraphQL not available — that's fine
        }
    }

    return discovered;
}

// ── Main Export ─────────────────────────────────────────────────────────────

/**
 * Run API discovery scan on pending domains.
 * Probes domains from the domain_registry for hidden job APIs.
 *
 * @param {D1Database} db - D1 database handle
 * @param {Set<string>} knownSourceUrls - Already registered source URLs
 * @param {KVNamespace} [kv] - KV for state tracking
 * @param {object} [options]
 * @param {number} [options.maxDomains=10] - Max domains to probe per cycle
 * @returns {Promise<{ newSources: number, domainsProbed: number, vectorStats: object }>}
 */
export async function runApiDiscovery(db, knownSourceUrls, kv = null, options = {}) {
    const { maxDomains = 10 } = options;

    let totalNewSources = 0;
    let domainsProbed = 0;
    const vectorStats = {};

    // Get domains that have career pages but no ATS source registered
    let domains = [];
    try {
        const result = await db.prepare(
            `SELECT domain FROM domain_registry
             WHERE status IN ('active', 'probed')
               AND career_url IS NOT NULL
             ORDER BY last_probed_at ASC
             LIMIT ?`
        ).bind(maxDomains).all();
        domains = (result.results || []).map(r => r.domain);
    } catch (err) {
        logger.warn(`[ApiDiscovery] Failed to fetch domains: ${err.message}`);
    }

    // Also include domains that were probed but have no source yet
    if (domains.length < maxDomains) {
        try {
            const extraResult = await db.prepare(
                `SELECT dr.domain FROM domain_registry dr
                 LEFT JOIN source_registry sr ON sr.domain = dr.domain
                 WHERE dr.status = 'probed' AND sr.url IS NULL
                 LIMIT ?`
            ).bind(maxDomains - domains.length).all();
            const extraDomains = (extraResult.results || []).map(r => r.domain);
            domains.push(...extraDomains);
        } catch { /* non-critical */ }
    }

    for (const domain of domains) {
        try {
            const discovered = await probeDomainApis(domain, knownSourceUrls);
            domainsProbed++;

            for (const { url, type, pattern, name } of discovered) {
                await registerDiscoveredSource(db, {
                    url,
                    type,
                    name,
                    enabled: true,
                    discovery_origin: `api_discovery:${pattern}`,
                });
                totalNewSources++;
                knownSourceUrls.add(url);
            }

            vectorStats[domain] = { apis_found: discovered.length };
        } catch (err) {
            vectorStats[domain] = { error: err.message };
        }
    }

    logger.info(`[ApiDiscovery] Probed ${domainsProbed} domains, found ${totalNewSources} API sources`);

    return { newSources: totalNewSources, domainsProbed, vectorStats };
}
