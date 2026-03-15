/**
 * @module discovery/ecosystemDiscovery
 * @description Developer ecosystem-based company discovery.
 * Finds companies through developer ecosystem signals — GitHub organizations,
 * npm publishers, PyPI maintainers, DockerHub organizations.
 *
 * Strategy: Companies that maintain popular open source projects are usually
 * hiring. Extract domains from ecosystem profiles and probe for career pages.
 *
 * Vectors:
 *   1. GitHub Organizations — orgs with active repos likely have job boards
 *   2. npm Publishers — companies publishing packages are tech companies
 *   3. PyPI Maintainers — Python package maintainers with company affiliations
 *   4. DockerHub Organizations — companies with Docker images are infrastructure companies
 */

import { fetchWithTimeout } from '../connectors/base.js';
import { registerDiscoveredSource } from '../db/index.js';
import { registerDomain } from './careerDetector.js';
import { detectAtsSources } from './sourceDiscovery.js';
import logger from '../core/logger.js';

// ── GitHub Organization Discovery ───────────────────────────────────────────

/**
 * Seed search queries for finding tech company GitHub orgs.
 */
const GITHUB_ORG_QUERIES = [
    'type:org followers:>100 created:>2023-01-01',
    'type:org repos:>10 language:typescript',
    'type:org repos:>10 language:python',
    'type:org repos:>5 language:go',
    'type:org repos:>5 language:rust',
];

/**
 * Discover company domains through GitHub organization profiles.
 * GitHub orgs often have company websites in their profile.
 *
 * @param {KVNamespace} [kv] - KV for state tracking
 * @param {number} [maxOrgs=30] - Max orgs to process
 * @returns {Promise<Array<{domain: string, source: string}>>}
 */
async function discoverFromGitHub(kv, maxOrgs = 30) {
    const discoveries = [];

    // Rotate queries across cycles
    const queryIdx = kv ? parseInt(await kv.get('gh_query_idx') || '0', 10) : 0;
    const query = GITHUB_ORG_QUERIES[queryIdx % GITHUB_ORG_QUERIES.length];

    try {
        // Use GitHub search API (unauthenticated — 10 req/min)
        const url = `https://api.github.com/search/users?q=${encodeURIComponent(query)}&per_page=${maxOrgs}&sort=followers`;
        const res = await fetchWithTimeout(url, {
            headers: {
                Accept: 'application/vnd.github.v3+json',
                'User-Agent': 'JobHunterBot/5.1',
            },
        }, 10000, 1);

        if (!res.ok) {
            logger.warn(`[EcoDiscovery] GitHub search returned ${res.status}`);
            return discoveries;
        }

        const data = await res.json();
        const items = data.items || [];

        for (const org of items.slice(0, maxOrgs)) {
            // Fetch org profile to get blog/website URL
            try {
                const orgRes = await fetchWithTimeout(
                    `https://api.github.com/orgs/${org.login}`,
                    {
                        headers: {
                            Accept: 'application/vnd.github.v3+json',
                            'User-Agent': 'JobHunterBot/5.1',
                        },
                    },
                    8000, 1
                );

                if (orgRes.ok) {
                    const orgData = await orgRes.json();
                    const blogUrl = orgData.blog || '';
                    const website = orgData.html_url || '';

                    if (blogUrl) {
                        try {
                            const domain = new URL(blogUrl).hostname.replace(/^www\./, '');
                            discoveries.push({ domain, source: `github:${org.login}` });
                        } catch { /* invalid URL */ }
                    }
                }
            } catch {
                // Rate limited or network error — continue
            }
        }

        // Update query rotation
        if (kv) {
            try {
                await kv.put('gh_query_idx', String(queryIdx + 1), { expirationTtl: 86400 * 30 });
            } catch { /* non-critical */ }
        }
    } catch (err) {
        logger.warn(`[EcoDiscovery] GitHub discovery failed: ${err.message}`);
    }

    return discoveries;
}

// ── npm Publisher Discovery ─────────────────────────────────────────────────

/**
 * npm search terms for finding company packages.
 */
const NPM_SEARCH_TERMS = [
    'sdk', 'cli', 'client', 'api', 'platform',
    'framework', 'toolkit', 'plugin', 'integration',
];

/**
 * Discover company domains from npm package publishers.
 * Companies maintaining public npm packages likely have websites with careers pages.
 *
 * @param {KVNamespace} [kv] - KV for state tracking
 * @param {number} [maxPackages=30] - Max packages to scan
 * @returns {Promise<Array<{domain: string, source: string}>>}
 */
async function discoverFromNpm(kv, maxPackages = 30) {
    const discoveries = [];

    const termIdx = kv ? parseInt(await kv.get('npm_term_idx') || '0', 10) : 0;
    const term = NPM_SEARCH_TERMS[termIdx % NPM_SEARCH_TERMS.length];

    try {
        const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(term)}&size=${maxPackages}&quality=0.5&popularity=0.5`;
        const res = await fetchWithTimeout(url, {
            headers: { Accept: 'application/json' },
        }, 10000, 1);

        if (!res.ok) {
            logger.warn(`[EcoDiscovery] npm search returned ${res.status}`);
            return discoveries;
        }

        const data = await res.json();
        const objects = data.objects || [];

        for (const obj of objects) {
            const pkg = obj.package || {};
            // Extract homepage URL from package metadata
            const homepage = pkg.links?.homepage || pkg.links?.repository || '';
            if (homepage) {
                try {
                    const domain = new URL(homepage).hostname.replace(/^www\./, '');
                    // Skip npm/github/generic domains
                    if (!domain.includes('npmjs.') && !domain.includes('github.') && domain.includes('.')) {
                        discoveries.push({ domain, source: `npm:${pkg.name}` });
                    }
                } catch { /* invalid URL */ }
            }

            // Also check publisher email domain
            const email = pkg.publisher?.email || '';
            if (email && email.includes('@')) {
                const emailDomain = email.split('@')[1];
                if (emailDomain && !emailDomain.includes('gmail') && !emailDomain.includes('hotmail') && !emailDomain.includes('yahoo')) {
                    discoveries.push({ domain: emailDomain, source: `npm:${pkg.name}:email` });
                }
            }
        }

        if (kv) {
            try {
                await kv.put('npm_term_idx', String(termIdx + 1), { expirationTtl: 86400 * 30 });
            } catch { /* non-critical */ }
        }
    } catch (err) {
        logger.warn(`[EcoDiscovery] npm discovery failed: ${err.message}`);
    }

    return discoveries;
}

// ── PyPI Discovery ──────────────────────────────────────────────────────────

/**
 * Discover company domains from PyPI package metadata.
 *
 * @param {KVNamespace} [kv] - KV for state tracking
 * @param {number} [maxPackages=20] - Max packages to scan
 * @returns {Promise<Array<{domain: string, source: string}>>}
 */
async function discoverFromPyPI(kv, maxPackages = 20) {
    const discoveries = [];

    try {
        // PyPI has a simple API for recent updates
        const url = 'https://pypi.org/simple/';
        // Use the XML-RPC API for recent changes
        const rssUrl = 'https://pypi.org/rss/updates.xml';
        const res = await fetchWithTimeout(rssUrl, {
            headers: { Accept: 'application/xml,text/xml' },
        }, 10000, 1);

        if (!res.ok) return discoveries;

        const xml = await res.text();
        // Extract package names from RSS feed
        const nameRegex = /<title>([^<]+)\s+\d+\.\d+/g;
        const packageNames = [];
        let match;
        while ((match = nameRegex.exec(xml)) !== null && packageNames.length < maxPackages) {
            packageNames.push(match[1].trim());
        }

        // Fetch metadata for each package to find company domains
        for (const name of packageNames.slice(0, 10)) {
            try {
                const pkgRes = await fetchWithTimeout(
                    `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
                    { headers: { Accept: 'application/json' } },
                    8000, 1
                );

                if (pkgRes.ok) {
                    const pkgData = await pkgRes.json();
                    const info = pkgData.info || {};

                    // Extract domain from project URLs
                    const projectUrls = info.project_urls || {};
                    const homepage = info.home_page || projectUrls.Homepage || projectUrls.Source || '';
                    if (homepage) {
                        try {
                            const domain = new URL(homepage).hostname.replace(/^www\./, '');
                            if (!domain.includes('github.') && !domain.includes('pypi.') && domain.includes('.')) {
                                discoveries.push({ domain, source: `pypi:${name}` });
                            }
                        } catch { /* invalid URL */ }
                    }

                    // Check author email
                    const email = info.author_email || '';
                    if (email && email.includes('@')) {
                        const emailDomain = email.split('@')[1];
                        if (emailDomain && !isFreemailDomain(emailDomain)) {
                            discoveries.push({ domain: emailDomain, source: `pypi:${name}:email` });
                        }
                    }
                }
            } catch { /* network error — continue */ }
        }
    } catch (err) {
        logger.warn(`[EcoDiscovery] PyPI discovery failed: ${err.message}`);
    }

    return discoveries;
}

// ── DockerHub Discovery ─────────────────────────────────────────────────────

/**
 * Discover company domains from DockerHub organization profiles.
 *
 * @param {KVNamespace} [kv] - KV for state tracking
 * @param {number} [maxOrgs=20] - Max organizations to scan
 * @returns {Promise<Array<{domain: string, source: string}>>}
 */
async function discoverFromDockerHub(kv, maxOrgs = 20) {
    const discoveries = [];

    try {
        // DockerHub search for popular org images
        const searchTerms = ['sdk', 'server', 'platform', 'api', 'database'];
        const termIdx = kv ? parseInt(await kv.get('docker_term_idx') || '0', 10) : 0;
        const term = searchTerms[termIdx % searchTerms.length];

        const url = `https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(term)}&page_size=${maxOrgs}&type=image`;
        const res = await fetchWithTimeout(url, {
            headers: { Accept: 'application/json' },
        }, 10000, 1);

        if (!res.ok) return discoveries;

        const data = await res.json();
        const results = data.results || [];

        for (const repo of results) {
            // Only look at official/org repos (have a namespace with /)
            const namespace = repo.repo_name?.split('/')[0];
            if (!namespace || namespace === 'library') continue;

            // Fetch namespace/org details
            try {
                const orgRes = await fetchWithTimeout(
                    `https://hub.docker.com/v2/orgs/${namespace}`,
                    { headers: { Accept: 'application/json' } },
                    8000, 1
                );

                if (orgRes.ok) {
                    const orgData = await orgRes.json();
                    const website = orgData.full_description || '';
                    // Try to extract a URL from the description
                    const urlMatch = website.match(/https?:\/\/[^\s)>"]+/);
                    if (urlMatch) {
                        try {
                            const domain = new URL(urlMatch[0]).hostname.replace(/^www\./, '');
                            if (!domain.includes('docker.') && !domain.includes('github.') && domain.includes('.')) {
                                discoveries.push({ domain, source: `docker:${namespace}` });
                            }
                        } catch { /* invalid URL */ }
                    }
                }
            } catch { /* network error */ }
        }

        if (kv) {
            try {
                await kv.put('docker_term_idx', String(termIdx + 1), { expirationTtl: 86400 * 30 });
            } catch { /* non-critical */ }
        }
    } catch (err) {
        logger.warn(`[EcoDiscovery] DockerHub discovery failed: ${err.message}`);
    }

    return discoveries;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const FREEMAIL_DOMAINS = new Set([
    'gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com',
    'yahoo.com', 'protonmail.com', 'icloud.com', 'aol.com',
    'mail.com', 'zoho.com', 'ymail.com', 'live.com',
]);

function isFreemailDomain(domain) {
    return FREEMAIL_DOMAINS.has(domain.toLowerCase());
}

// ── Main Export ─────────────────────────────────────────────────────────────

/**
 * Run ecosystem discovery cycle.
 * Discovers company domains through developer ecosystem signals.
 *
 * @param {D1Database} db - D1 database handle
 * @param {Set<string>} knownSourceUrls - Already registered source URLs
 * @param {KVNamespace} [kv] - KV for state tracking
 * @param {object} [options]
 * @param {boolean} [options.enableGitHub=true]
 * @param {boolean} [options.enableNpm=true]
 * @param {boolean} [options.enablePyPI=true]
 * @param {boolean} [options.enableDocker=true]
 * @param {number} [options.maxDomainsPerVector=20]
 * @returns {Promise<{ newDomains: number, newSources: number, vectorStats: object }>}
 */
export async function runEcosystemDiscovery(db, knownSourceUrls, kv = null, options = {}) {
    const {
        enableGitHub = true,
        enableNpm = true,
        enablePyPI = true,
        enableDocker = true,
        maxDomainsPerVector = 20,
    } = options;

    let totalNewDomains = 0;
    let totalNewSources = 0;
    const vectorStats = {};
    const seenDomains = new Set();

    // Collect domains from all enabled vectors
    const allDiscoveries = [];

    if (enableGitHub) {
        try {
            const ghResults = await discoverFromGitHub(kv, maxDomainsPerVector);
            allDiscoveries.push(...ghResults);
            vectorStats.github = { found: ghResults.length };
        } catch (err) {
            vectorStats.github = { error: err.message };
        }
    }

    if (enableNpm) {
        try {
            const npmResults = await discoverFromNpm(kv, maxDomainsPerVector);
            allDiscoveries.push(...npmResults);
            vectorStats.npm = { found: npmResults.length };
        } catch (err) {
            vectorStats.npm = { error: err.message };
        }
    }

    if (enablePyPI) {
        try {
            const pypiResults = await discoverFromPyPI(kv, maxDomainsPerVector);
            allDiscoveries.push(...pypiResults);
            vectorStats.pypi = { found: pypiResults.length };
        } catch (err) {
            vectorStats.pypi = { error: err.message };
        }
    }

    if (enableDocker) {
        try {
            const dockerResults = await discoverFromDockerHub(kv, maxDomainsPerVector);
            allDiscoveries.push(...dockerResults);
            vectorStats.docker = { found: dockerResults.length };
        } catch (err) {
            vectorStats.docker = { error: err.message };
        }
    }

    // Deduplicate and register domains
    for (const { domain, source } of allDiscoveries) {
        if (seenDomains.has(domain)) continue;
        seenDomains.add(domain);

        try {
            // Try ATS detection on common career URLs
            const probeUrls = [
                `https://${domain}/careers`,
                `https://${domain}/jobs`,
                `https://careers.${domain}`,
            ];
            const atsSources = detectAtsSources(probeUrls, knownSourceUrls);
            for (const atsSource of atsSources) {
                await registerDiscoveredSource(db, {
                    ...atsSource,
                    discovery_origin: `ecosystem:${source}`,
                });
                totalNewSources++;
            }

            // Register domain for career page probing
            await registerDomain(db, domain, null, 'ecosystem');
            totalNewDomains++;
        } catch {
            // Skip registration errors
        }
    }

    logger.info(`[EcoDiscovery] Ecosystem scan: ${totalNewDomains} domains, ${totalNewSources} ATS sources from ${allDiscoveries.length} ecosystem signals`);

    return { newDomains: totalNewDomains, newSources: totalNewSources, vectorStats };
}
