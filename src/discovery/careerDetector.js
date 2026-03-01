/**
 * @module careerDetector
 * @description Probes company domains for career pages and validates
 * that they contain parseable job listings.
 *
 * When a new company domain is discovered from job URLs, this module:
 * 1. Tests common career URL paths (/careers, /jobs, etc.)
 * 2. Checks for JSON-LD JobPosting schema
 * 3. Checks for job-like links
 * 4. If valid → registers it as a 'career_page' source in source_registry
 *
 * Rate-limited to avoid hammering unknown domains.
 */

import { fetchWithTimeout, rateLimitDomain } from '../connectors/base.js';
import { registerDiscoveredSource } from '../db/index.js';
import logger from '../core/logger.js';

/** Common career page path suffixes to probe. */
const CAREER_PATHS = [
    '/careers',
    '/jobs',
    '/work-with-us',
    '/open-positions',
    '/join-us',
    '/career',
    '/job-openings',
];

/**
 * Probe a batch of domains for career pages and register valid ones.
 *
 * @param {D1Database} db - D1 database handle.
 * @param {string[]} domains - Domains to probe (e.g., ['stripe.com', 'vercel.com']).
 * @param {number} [maxProbes=5] - Max domains to probe per cycle (rate limit).
 * @returns {Promise<object[]>} Successfully registered career page sources.
 */
export async function probeDomainsForCareers(db, domains, maxProbes = 5) {
    const registered = [];
    let probed = 0;

    for (const domain of domains) {
        if (probed >= maxProbes) break;

        try {
            const result = await probeSingleDomain(domain);
            probed++;

            if (result) {
                // Register as a career_page source
                const source = {
                    url: result.careerUrl,
                    type: 'career_page',
                    name: domainToName(domain),
                    enabled: true,
                    discovery_origin: 'career-probe',
                };

                await registerDiscoveredSource(db, source);
                registered.push(source);

                // Update domain registry
                await updateDomainStatus(db, domain, {
                    status: 'active',
                    careerUrl: result.careerUrl,
                    hasJsonLd: result.hasJsonLd,
                    hasJobLinks: result.hasJobLinks,
                    jobCount: result.jobCount,
                });

                logger.info(`[CareerDetector] ✅ Found career page: ${domain} → ${result.careerUrl} (${result.jobCount} jobs)`);
            } else {
                // Mark domain as dead (no career page found)
                await updateDomainStatus(db, domain, { status: 'dead' });
                logger.info(`[CareerDetector] ❌ No career page found: ${domain}`);
            }
        } catch (err) {
            logger.warn(`[CareerDetector] Error probing ${domain}: ${err.message}`);
            await updateDomainStatus(db, domain, { status: 'dead' });
        }
    }

    return registered;
}

/**
 * Probe a single domain for a career page.
 *
 * @param {string} domain
 * @returns {Promise<{careerUrl: string, hasJsonLd: boolean, hasJobLinks: boolean, jobCount: number} | null>}
 */
async function probeSingleDomain(domain) {
    for (const path of CAREER_PATHS) {
        const url = `https://${domain}${path}`;

        try {
            await rateLimitDomain(url, 3000);

            const res = await fetchWithTimeout(url, {
                headers: {
                    'Accept': 'text/html',
                    'User-Agent': 'JobHunterBot/5.1 (+https://github.com/job-hunter-bot)',
                },
                redirect: 'follow',
            }, 10_000);

            if (!res.ok) continue;

            const html = await res.text();

            // Check for JobPosting JSON-LD
            const hasJsonLd = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?JobPosting[\s\S]*?<\/script>/i.test(html);

            // Check for job-like links
            const jobLinkCount = countJobLinks(html);

            if (hasJsonLd || jobLinkCount >= 3) {
                return {
                    careerUrl: res.url || url, // Follow redirects
                    hasJsonLd,
                    hasJobLinks: jobLinkCount > 0,
                    jobCount: hasJsonLd ? countJsonLdPostings(html) : jobLinkCount,
                };
            }
        } catch {
            // Timeout or network error, try next path
            continue;
        }
    }

    return null; // No career page found
}

/**
 * Count job-like links in HTML.
 * @param {string} html
 * @returns {number}
 */
function countJobLinks(html) {
    const patterns = [
        /href\s*=\s*["'][^"']*\/jobs?\//gi,
        /href\s*=\s*["'][^"']*\/careers?\//gi,
        /href\s*=\s*["'][^"']*\/positions?\//gi,
        /href\s*=\s*["'][^"']*\/openings?\//gi,
        /href\s*=\s*["'][^"']*\/apply\//gi,
        /href\s*=\s*["'][^"']*job[_-]?id/gi,
    ];

    let count = 0;
    for (const p of patterns) {
        const matches = html.match(p);
        if (matches) count += matches.length;
    }

    return count;
}

/**
 * Count JobPosting entries in JSON-LD blocks.
 * @param {string} html
 * @returns {number}
 */
function countJsonLdPostings(html) {
    const matches = html.match(/["']@type["']\s*:\s*["']JobPosting["']/gi);
    return matches ? matches.length : 0;
}

// ── Domain helpers ──────────────────────────────────────────────────────────

/**
 * Convert a domain to a friendly company name.
 * @param {string} domain
 * @returns {string}
 */
function domainToName(domain) {
    return domain
        .replace(/^www\./, '')
        .split('.')[0]
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Update a domain's status in the domain_registry.
 *
 * @param {D1Database} db
 * @param {string} domain
 * @param {object} update
 */
async function updateDomainStatus(db, domain, update) {
    try {
        await db.prepare(
            `UPDATE domain_registry
             SET status = ?, career_url = ?, has_json_ld = ?, has_job_links = ?,
                 job_count = ?, last_probed_at = CURRENT_TIMESTAMP
             WHERE domain = ?`
        ).bind(
            update.status || 'probed',
            update.careerUrl || null,
            update.hasJsonLd ? 1 : 0,
            update.hasJobLinks ? 1 : 0,
            update.jobCount || 0,
            domain
        ).run();
    } catch (err) {
        logger.warn(`[CareerDetector] Failed to update domain ${domain}: ${err.message}`);
    }
}

/**
 * Register a new domain for probing.
 *
 * @param {D1Database} db
 * @param {string} domain
 * @param {string} sourceJobUrl - The job URL that led to discovering this domain.
 */
export async function registerDomain(db, domain, sourceJobUrl) {
    try {
        await db.prepare(
            `INSERT OR IGNORE INTO domain_registry (domain, source_job_url)
             VALUES (?, ?)`
        ).bind(domain, sourceJobUrl).run();
    } catch (err) {
        logger.warn(`[CareerDetector] Failed to register domain ${domain}: ${err.message}`);
    }
}

/**
 * Get pending domains from the registry.
 *
 * @param {D1Database} db
 * @param {number} [limit=10]
 * @returns {Promise<string[]>}
 */
export async function getPendingDomains(db, limit = 10) {
    try {
        const result = await db.prepare(
            `SELECT domain FROM domain_registry WHERE status = 'pending' LIMIT ?`
        ).bind(limit).all();
        return result.success ? result.results.map(r => r.domain) : [];
    } catch (err) {
        logger.warn(`[CareerDetector] Failed to get pending domains: ${err.message}`);
        return [];
    }
}
