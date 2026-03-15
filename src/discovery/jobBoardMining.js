/**
 * @module discovery/jobBoardMining
 * @description Job board mining discovery vector.
 * Extracts company domains from aggregated job board listings (Indeed, LinkedIn,
 * Wellfound/AngelList) and traces them back to company career pages.
 *
 * Strategy: Job board → apply link → company domain → career page → source registry.
 * This captures companies that post on job boards but aren't yet in our source registry.
 *
 * Vectors:
 *   1. Indeed company pages
 *   2. Wellfound (AngelList) startup listings
 *   3. LinkedIn job search (public pages)
 *   4. BuiltIn tech company listings
 */

import { fetchWithTimeout } from '../connectors/base.js';
import { registerDiscoveredSource } from '../db/index.js';
import { registerDomain } from './careerDetector.js';
import { detectAtsSources } from './sourceDiscovery.js';
import logger from '../core/logger.js';

// ── Wellfound (AngelList) Discovery ─────────────────────────────────────────

/**
 * Wellfound startup listing URLs to scrape for company domains.
 */
const WELLFOUND_PAGES = [
    'https://wellfound.com/role/r/software-engineer',
    'https://wellfound.com/role/r/backend-engineer',
    'https://wellfound.com/role/r/frontend-engineer',
    'https://wellfound.com/role/r/full-stack-engineer',
    'https://wellfound.com/role/r/devops-engineer',
    'https://wellfound.com/role/r/data-engineer',
    'https://wellfound.com/role/r/machine-learning-engineer',
    'https://wellfound.com/role/r/mobile-developer',
    'https://wellfound.com/role/r/product-manager',
    'https://wellfound.com/role/r/engineering-manager',
];

/**
 * Scrape Wellfound role pages for company links.
 *
 * @param {KVNamespace} [kv] - KV for tracking
 * @param {number} [maxPages=2] - Max pages to scrape per cycle
 * @returns {Promise<string[]>} Discovered domains
 */
async function mineWellfound(kv, maxPages = 2) {
    const domains = new Set();

    const pageIdx = kv ? parseInt(await kv.get('wf_page_idx') || '0', 10) : 0;
    const pages = WELLFOUND_PAGES.slice(
        pageIdx % WELLFOUND_PAGES.length,
        (pageIdx % WELLFOUND_PAGES.length) + maxPages
    );

    for (const pageUrl of pages) {
        try {
            const res = await fetchWithTimeout(pageUrl, {
                headers: {
                    Accept: 'text/html',
                    'User-Agent': 'Mozilla/5.0 (compatible; JobHunterBot/5.1)',
                },
            }, 10000, 1);

            if (!res.ok) continue;

            const html = await res.text();

            // Extract company profile URLs
            const companyRegex = /href="\/company\/([^"/?]+)"/gi;
            let match;
            const companySlugsSeen = new Set();
            while ((match = companyRegex.exec(html)) !== null) {
                const slug = match[1];
                if (companySlugsSeen.has(slug)) continue;
                companySlugsSeen.add(slug);

                // Fetch company profile to get website
                try {
                    const compRes = await fetchWithTimeout(
                        `https://wellfound.com/company/${slug}`,
                        {
                            headers: {
                                Accept: 'text/html',
                                'User-Agent': 'Mozilla/5.0 (compatible; JobHunterBot/5.1)',
                            },
                        },
                        8000, 1
                    );

                    if (compRes.ok) {
                        const compHtml = await compRes.text();
                        // Look for company website URL
                        const urlMatch = compHtml.match(/href="(https?:\/\/(?!wellfound|angel)[^"]+)"[^>]*rel="noopener"/);
                        if (urlMatch) {
                            try {
                                const domain = new URL(urlMatch[1]).hostname.replace(/^www\./, '');
                                domains.add(domain);
                            } catch { /* invalid URL */ }
                        }
                    }
                } catch { /* network error */ }

                if (domains.size >= 20) break;
            }
        } catch (err) {
            logger.warn(`[JobBoardMining] Wellfound scrape failed: ${err.message}`);
        }
    }

    if (kv) {
        try {
            await kv.put('wf_page_idx', String(pageIdx + maxPages), { expirationTtl: 86400 * 30 });
        } catch { /* non-critical */ }
    }

    return [...domains];
}

// ── Indeed Company Pages ────────────────────────────────────────────────────

/**
 * Indeed search queries focused on tech companies.
 */
const INDEED_QUERIES = [
    'software engineer startup',
    'backend developer remote',
    'full stack developer',
    'devops engineer cloud',
    'data scientist ml',
    'product manager saas',
    'frontend developer react',
    'platform engineer',
];

/**
 * Extract company domains from Indeed search results.
 *
 * @param {KVNamespace} [kv] - KV for tracking
 * @param {number} [maxResults=20] - Max results to extract
 * @returns {Promise<string[]>} Discovered domains
 */
async function mineIndeed(kv, maxResults = 20) {
    const domains = new Set();

    const queryIdx = kv ? parseInt(await kv.get('indeed_q_idx') || '0', 10) : 0;
    const query = INDEED_QUERIES[queryIdx % INDEED_QUERIES.length];

    try {
        const url = `https://www.indeed.com/jobs?q=${encodeURIComponent(query)}&sort=date&fromage=7`;
        const res = await fetchWithTimeout(url, {
            headers: {
                Accept: 'text/html',
                'User-Agent': 'Mozilla/5.0 (compatible; JobHunterBot/5.1)',
            },
        }, 10000, 1);

        if (!res.ok) {
            logger.warn(`[JobBoardMining] Indeed returned ${res.status}`);
            return [...domains];
        }

        const html = await res.text();

        // Extract company names and links from Indeed results
        // Indeed templates embed company URLs in data attributes and links
        const companyLinkRegex = /href="(https?:\/\/(?!www\.indeed)[^"]+)"[^>]*data-tn-element="companyName"/gi;
        let match;
        while ((match = companyLinkRegex.exec(html)) !== null && domains.size < maxResults) {
            try {
                const domain = new URL(match[1]).hostname.replace(/^www\./, '');
                domains.add(domain);
            } catch { /* invalid URL */ }
        }

        // Also look for apply redirect URLs
        const applyRegex = /data-jk="[^"]*"[^>]*data-hiring-event="[^"]*"[^>]*href="(\/applystart[^"]+)"/gi;
        while ((match = applyRegex.exec(html)) !== null && domains.size < maxResults) {
            // These are Indeed internal links — would need to follow redirects to get company domain
            // Skipping for now since it requires extra requests
        }
    } catch (err) {
        logger.warn(`[JobBoardMining] Indeed mining failed: ${err.message}`);
    }

    if (kv) {
        try {
            await kv.put('indeed_q_idx', String(queryIdx + 1), { expirationTtl: 86400 * 30 });
        } catch { /* non-critical */ }
    }

    return [...domains];
}

// ── BuiltIn Tech Companies ──────────────────────────────────────────────────

/**
 * BuiltIn.com tech company listing pages.
 */
const BUILTIN_PAGES = [
    'https://builtin.com/companies/type/private',
    'https://builtin.com/companies/type/startup',
    'https://builtin.com/jobs/engineering',
    'https://builtin.com/jobs/dev-engineering',
    'https://builtin.com/jobs/data-analytics',
];

/**
 * Extract company domains from BuiltIn.com listings.
 *
 * @param {KVNamespace} [kv] - KV for tracking
 * @returns {Promise<string[]>} Discovered domains
 */
async function mineBuiltIn(kv) {
    const domains = new Set();

    const pageIdx = kv ? parseInt(await kv.get('builtin_idx') || '0', 10) : 0;
    const pageUrl = BUILTIN_PAGES[pageIdx % BUILTIN_PAGES.length];

    try {
        const res = await fetchWithTimeout(pageUrl, {
            headers: {
                Accept: 'text/html',
                'User-Agent': 'Mozilla/5.0 (compatible; JobHunterBot/5.1)',
            },
        }, 10000, 1);

        if (!res.ok) return [...domains];

        const html = await res.text();

        // Extract company profile links
        const profileRegex = /href="\/company\/([^"]+)"/gi;
        let match;
        const slugs = new Set();
        while ((match = profileRegex.exec(html)) !== null && slugs.size < 30) {
            slugs.add(match[1]);
        }

        // For each company slug, try to find their website
        for (const slug of slugs) {
            try {
                const compRes = await fetchWithTimeout(
                    `https://builtin.com/company/${slug}`,
                    {
                        headers: {
                            Accept: 'text/html',
                            'User-Agent': 'Mozilla/5.0 (compatible; JobHunterBot/5.1)',
                        },
                    },
                    8000, 1
                );

                if (compRes.ok) {
                    const compHtml = await compRes.text();
                    const websiteMatch = compHtml.match(/href="(https?:\/\/(?!builtin\.com)[^"]+)"[^>]*(?:website|visit|company-link)/i);
                    if (websiteMatch) {
                        try {
                            const domain = new URL(websiteMatch[1]).hostname.replace(/^www\./, '');
                            domains.add(domain);
                        } catch { /* invalid URL */ }
                    }
                }
            } catch { /* network error */ }

            if (domains.size >= 20) break;
        }
    } catch (err) {
        logger.warn(`[JobBoardMining] BuiltIn mining failed: ${err.message}`);
    }

    if (kv) {
        try {
            await kv.put('builtin_idx', String(pageIdx + 1), { expirationTtl: 86400 * 30 });
        } catch { /* non-critical */ }
    }

    return [...domains];
}

// ── Main Export ─────────────────────────────────────────────────────────────

/**
 * Run job board mining discovery cycle.
 *
 * @param {D1Database} db - D1 database handle
 * @param {Set<string>} knownSourceUrls - Already registered source URLs
 * @param {KVNamespace} [kv] - KV for state tracking
 * @param {object} [options]
 * @param {boolean} [options.enableWellfound=true]
 * @param {boolean} [options.enableIndeed=true]
 * @param {boolean} [options.enableBuiltIn=true]
 * @returns {Promise<{ newDomains: number, newSources: number, vectorStats: object }>}
 */
export async function runJobBoardMining(db, knownSourceUrls, kv = null, options = {}) {
    const {
        enableWellfound = true,
        enableIndeed = true,
        enableBuiltIn = true,
    } = options;

    let totalNewDomains = 0;
    let totalNewSources = 0;
    const vectorStats = {};
    const seenDomains = new Set();

    // Mine Wellfound
    if (enableWellfound) {
        try {
            const wfDomains = await mineWellfound(kv, 2);
            vectorStats.wellfound = { found: wfDomains.length };
            for (const domain of wfDomains) {
                if (!seenDomains.has(domain)) {
                    seenDomains.add(domain);
                    await registerMiningDomain(db, domain, knownSourceUrls, 'wellfound');
                    totalNewDomains++;
                }
            }
        } catch (err) {
            vectorStats.wellfound = { error: err.message };
        }
    }

    // Mine Indeed
    if (enableIndeed) {
        try {
            const indeedDomains = await mineIndeed(kv, 20);
            vectorStats.indeed = { found: indeedDomains.length };
            for (const domain of indeedDomains) {
                if (!seenDomains.has(domain)) {
                    seenDomains.add(domain);
                    await registerMiningDomain(db, domain, knownSourceUrls, 'indeed');
                    totalNewDomains++;
                }
            }
        } catch (err) {
            vectorStats.indeed = { error: err.message };
        }
    }

    // Mine BuiltIn
    if (enableBuiltIn) {
        try {
            const builtInDomains = await mineBuiltIn(kv);
            vectorStats.builtin = { found: builtInDomains.length };
            for (const domain of builtInDomains) {
                if (!seenDomains.has(domain)) {
                    seenDomains.add(domain);
                    await registerMiningDomain(db, domain, knownSourceUrls, 'builtin');
                    totalNewDomains++;
                }
            }
        } catch (err) {
            vectorStats.builtin = { error: err.message };
        }
    }

    logger.info(`[JobBoardMining] Mining complete: ${totalNewDomains} domains, ${totalNewSources} sources`);

    return { newDomains: totalNewDomains, newSources: totalNewSources, vectorStats };
}

/**
 * Register a domain found via job board mining.
 */
async function registerMiningDomain(db, domain, knownSourceUrls, origin) {
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
                discovery_origin: `job_board:${origin}`,
            });
        }
        await registerDomain(db, domain, null, 'job_board');
    } catch {
        // Skip registration errors
    }
}
