/**
 * @module discovery/infrastructureMonitor
 * @description Internet infrastructure-based company discovery.
 * Discovers companies via Certificate Transparency logs, Newly Registered Domains (NRD),
 * reverse DNS enrichment, and cloud metadata signals.
 *
 * This is a CRITICAL discovery vector - it captures companies that haven't been
 * indexed by search engines yet but are actively building web infrastructure.
 *
 * Vectors:
 *   1. Certificate Transparency (crt.sh) — monitor new SSL certs for career/jobs subdomains
 *   2. NRD feeds — detect newly registered domains containing hiring keywords
 *   3. Reverse DNS enrichment — enrich known IPs with additional hostnames
 *   4. Cloud metadata — detect companies deploying on cloud platforms
 */

import { fetchWithTimeout } from '../connectors/base.js';
import { registerDiscoveredSource } from '../db/index.js';
import { registerDomain } from './careerDetector.js';
import { detectAtsSources } from './sourceDiscovery.js';
import logger from '../core/logger.js';

// ── Certificate Transparency via crt.sh ─────────────────────────────────────

/**
 * crt.sh search patterns for career-related subdomains.
 * These wildcard patterns catch companies setting up career pages.
 */
const CT_SEARCH_PATTERNS = [
    '%careers%',
    '%jobs%',
    '%hiring%',
    '%apply%',
    '%talent%',
    '%recruit%',
    '%work.%',
    '%join.%',
];

/**
 * Query crt.sh for recently issued certificates matching career patterns.
 * Returns discovered domains with career-related subdomains.
 *
 * @param {object} options
 * @param {number} [options.maxPatterns=3] - Max patterns to search per cycle
 * @param {number} [options.maxResults=50] - Max results per pattern
 * @param {KVNamespace} [options.kv] - KV for tracking queried patterns
 * @returns {Promise<string[]>} List of discovered domains
 */
async function queryCertTransparency(options = {}) {
    const { maxPatterns = 3, maxResults = 50, kv } = options;
    const discoveredDomains = new Set();

    // Rotate through patterns each cycle
    const patternOffset = kv
        ? parseInt(await kv.get('ct_pattern_offset') || '0', 10)
        : 0;
    const selectedPatterns = CT_SEARCH_PATTERNS.slice(
        patternOffset % CT_SEARCH_PATTERNS.length,
        (patternOffset % CT_SEARCH_PATTERNS.length) + maxPatterns
    );

    for (const pattern of selectedPatterns) {
        try {
            const url = `https://crt.sh/?q=${encodeURIComponent(pattern)}&output=json&exclude=expired`;
            const res = await fetchWithTimeout(url, {
                headers: { Accept: 'application/json' },
            }, 15000, 1);

            if (!res.ok) {
                logger.warn(`[InfraMonitor] crt.sh returned ${res.status} for pattern "${pattern}"`);
                continue;
            }

            const certs = await res.json();
            if (!Array.isArray(certs)) continue;

            // Extract unique domains from recent certificates (limit scope)
            const recent = certs.slice(0, maxResults);
            for (const cert of recent) {
                const commonName = cert.common_name || '';
                const nameValue = cert.name_value || '';

                // Extract base domains from cert names
                const names = [commonName, ...nameValue.split('\n')].filter(Boolean);
                for (const name of names) {
                    const domain = extractBaseDomain(name);
                    if (domain && !isSkippedDomain(domain)) {
                        discoveredDomains.add(domain);
                    }
                }
            }

            logger.info(`[InfraMonitor] crt.sh "${pattern}": ${discoveredDomains.size} domains so far`);
        } catch (err) {
            logger.warn(`[InfraMonitor] crt.sh query failed for "${pattern}": ${err.message}`);
        }
    }

    // Update pattern offset for rotation
    if (kv) {
        try {
            await kv.put('ct_pattern_offset', String(patternOffset + maxPatterns), {
                expirationTtl: 86400 * 30,
            });
        } catch { /* non-critical */ }
    }

    return [...discoveredDomains];
}

// ── Newly Registered Domains (NRD) ──────────────────────────────────────────

/**
 * Keywords that indicate a domain is likely a tech company career page.
 */
const NRD_CAREER_KEYWORDS = [
    'careers', 'jobs', 'hiring', 'talent', 'recruit', 'apply',
    'work', 'team', 'openings', 'engineering', 'devjobs',
];

/**
 * Tech company domain patterns — TLDs and keywords that suggest tech companies.
 */
const TECH_DOMAIN_PATTERNS = [
    /\.(io|ai|dev|app|tech|cloud|software|digital|co)$/i,
    /(labs|hq|inc|dev|tech|ai|cloud|data|cyber|net|sys)/i,
];

/**
 * Scan NRD feeds for domains containing hiring-related keywords.
 * Uses publicly available NRD lists (WHOIS data providers).
 *
 * @param {object} options
 * @param {KVNamespace} [options.kv] - KV for tracking processed dates
 * @param {number} [options.maxDomains=100] - Max domains to return
 * @returns {Promise<string[]>}
 */
async function scanNewlyRegisteredDomains(options = {}) {
    const { kv, maxDomains = 100 } = options;
    const discoveredDomains = [];

    // Use the NRD aggregation endpoint (free tier)
    const today = new Date().toISOString().split('T')[0];
    const lastProcessed = kv ? await kv.get('nrd_last_date') : null;

    if (lastProcessed === today) {
        logger.info('[InfraMonitor] NRD already processed for today, skipping');
        return discoveredDomains;
    }

    try {
        // Query RDAP/WHOIS aggregation for newly registered tech domains
        // Using nrd-list endpoint with date parameter
        const url = `https://newly-registered-domains.abuseipdb.com/api.php?date=${today}`;
        const res = await fetchWithTimeout(url, {
            headers: { Accept: 'text/plain' },
        }, 15000, 1);

        if (res.ok) {
            const text = await res.text();
            const domains = text.split('\n').filter(Boolean);

            for (const domain of domains) {
                const trimmed = domain.trim().toLowerCase();
                if (!trimmed || trimmed.startsWith('#')) continue;

                // Filter for tech-related domains
                const isTechDomain = TECH_DOMAIN_PATTERNS.some(p => p.test(trimmed));
                const hasCareerKeyword = NRD_CAREER_KEYWORDS.some(k => trimmed.includes(k));

                if (isTechDomain || hasCareerKeyword) {
                    discoveredDomains.push(trimmed);
                    if (discoveredDomains.length >= maxDomains) break;
                }
            }
        }
    } catch (err) {
        logger.warn(`[InfraMonitor] NRD scan failed: ${err.message}`);
    }

    // Fallback: scan crt.sh for certificates issued today to new domains
    if (discoveredDomains.length === 0) {
        try {
            const url = `https://crt.sh/?q=%25.io&output=json&exclude=expired`;
            const res = await fetchWithTimeout(url, {
                headers: { Accept: 'application/json' },
            }, 15000, 1);

            if (res.ok) {
                const certs = await res.json();
                if (Array.isArray(certs)) {
                    for (const cert of certs.slice(0, maxDomains * 2)) {
                        const domain = extractBaseDomain(cert.common_name || '');
                        if (domain && !isSkippedDomain(domain)) {
                            discoveredDomains.push(domain);
                            if (discoveredDomains.length >= maxDomains) break;
                        }
                    }
                }
            }
        } catch (err) {
            logger.warn(`[InfraMonitor] NRD crt.sh fallback failed: ${err.message}`);
        }
    }

    if (kv) {
        try {
            await kv.put('nrd_last_date', today, { expirationTtl: 86400 * 7 });
        } catch { /* non-critical */ }
    }

    logger.info(`[InfraMonitor] NRD scan: ${discoveredDomains.length} tech domains found`);
    return discoveredDomains;
}

// ── Reverse DNS Enrichment ──────────────────────────────────────────────────

/**
 * Enrich known company domains with additional subdomains via DNS lookups.
 * Checks for common career-related subdomains on known company domains.
 *
 * @param {string[]} domains - Known company domains to enrich
 * @param {number} [maxProbes=20] - Max domains to probe
 * @returns {Promise<Array<{domain: string, careerUrl: string}>>}
 */
async function enrichWithReverseDns(domains, maxProbes = 20) {
    const results = [];
    const careerSubdomains = ['careers', 'jobs', 'hiring', 'talent', 'work', 'apply', 'join'];

    const batch = domains.slice(0, maxProbes);
    for (const domain of batch) {
        for (const sub of careerSubdomains) {
            const probeDomain = `${sub}.${domain}`;
            try {
                const res = await fetchWithTimeout(`https://${probeDomain}`, {
                    method: 'HEAD',
                    redirect: 'follow',
                }, 5000, 1);

                if (res.ok || res.status === 301 || res.status === 302) {
                    results.push({
                        domain,
                        careerUrl: res.url || `https://${probeDomain}`,
                    });
                    break; // Found career subdomain, move to next domain
                }
            } catch {
                // DNS resolution failed or timeout — subdomain doesn't exist
                continue;
            }
        }
    }

    return results;
}

// ── Cloud Metadata Discovery ────────────────────────────────────────────────

/**
 * Detect companies deploying career infrastructure on cloud platforms.
 * Scans for known cloud deployment patterns (Vercel, Netlify, Cloudflare Pages).
 *
 * @param {KVNamespace} [kv] - KV for caching results
 * @returns {Promise<string[]>} Discovered domains
 */
async function scanCloudDeployments(kv) {
    const domains = [];

    // Scan crt.sh for certificates on cloud deployment platforms with career keywords
    const cloudPatterns = [
        '%careers%.vercel.app',
        '%jobs%.vercel.app',
        '%careers%.netlify.app',
        '%jobs%.netlify.app',
        '%careers%.pages.dev',
        '%jobs%.pages.dev',
    ];

    const patternIdx = kv ? parseInt(await kv.get('cloud_pattern_idx') || '0', 10) : 0;
    const pattern = cloudPatterns[patternIdx % cloudPatterns.length];

    try {
        const url = `https://crt.sh/?q=${encodeURIComponent(pattern)}&output=json&exclude=expired`;
        const res = await fetchWithTimeout(url, {
            headers: { Accept: 'application/json' },
        }, 15000, 1);

        if (res.ok) {
            const certs = await res.json();
            if (Array.isArray(certs)) {
                for (const cert of certs.slice(0, 30)) {
                    const name = cert.common_name || '';
                    if (name) domains.push(name);
                }
            }
        }
    } catch (err) {
        logger.warn(`[InfraMonitor] Cloud scan failed: ${err.message}`);
    }

    if (kv) {
        try {
            await kv.put('cloud_pattern_idx', String(patternIdx + 1), {
                expirationTtl: 86400 * 30,
            });
        } catch { /* non-critical */ }
    }

    return domains;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the base domain from a hostname/cert CN.
 */
function extractBaseDomain(name) {
    if (!name) return null;
    // Remove wildcard prefix
    let domain = name.replace(/^\*\./, '').toLowerCase().trim();
    // Must have at least one dot
    if (!domain.includes('.')) return null;
    // Extract registrable domain (last 2 parts for simple TLDs)
    const parts = domain.split('.');
    if (parts.length >= 2) {
        return parts.slice(-2).join('.');
    }
    return domain;
}

/** Common domains to skip. */
const SKIP_DOMAINS = new Set([
    'google.com', 'facebook.com', 'amazon.com', 'microsoft.com',
    'cloudflare.com', 'github.com', 'githubusercontent.com',
    'amazonaws.com', 'azurewebsites.net', 'herokuapp.com',
    'vercel.app', 'netlify.app', 'pages.dev',
    'linkedin.com', 'indeed.com', 'glassdoor.com',
    'letsencrypt.org', 'digicert.com', 'sectigo.com',
]);

function isSkippedDomain(domain) {
    return SKIP_DOMAINS.has(domain) || domain.length < 4;
}

// ── Main Export ─────────────────────────────────────────────────────────────

/**
 * Run infrastructure monitoring discovery cycle.
 * Combines all infrastructure signals to discover new company domains.
 *
 * @param {D1Database} db - D1 database handle
 * @param {Set<string>} knownSourceUrls - Already registered source URLs
 * @param {KVNamespace} [kv] - KV for state tracking
 * @param {object} [options]
 * @param {boolean} [options.enableCT=true] - Enable Certificate Transparency scanning
 * @param {boolean} [options.enableNRD=true] - Enable Newly Registered Domain scanning
 * @param {boolean} [options.enableReverseDns=false] - Enable reverse DNS enrichment (expensive)
 * @param {boolean} [options.enableCloud=true] - Enable cloud deployment scanning
 * @param {number} [options.maxDomainsPerVector=30] - Max domains per vector
 * @returns {Promise<{ newDomains: number, newSources: number, vectorStats: object }>}
 */
export async function runInfrastructureMonitoring(db, knownSourceUrls, kv = null, options = {}) {
    const {
        enableCT = true,
        enableNRD = true,
        enableReverseDns = false,
        enableCloud = true,
        maxDomainsPerVector = 30,
    } = options;

    let totalNewDomains = 0;
    let totalNewSources = 0;
    const vectorStats = {};

    // 1. Certificate Transparency
    if (enableCT) {
        try {
            const ctDomains = await queryCertTransparency({
                maxPatterns: 2,
                maxResults: maxDomainsPerVector,
                kv,
            });
            const registered = await registerInfraDomains(db, ctDomains, knownSourceUrls, 'cert_transparency');
            vectorStats.cert_transparency = { found: ctDomains.length, registered: registered };
            totalNewDomains += registered;
        } catch (err) {
            logger.warn(`[InfraMonitor] CT vector failed: ${err.message}`);
            vectorStats.cert_transparency = { error: err.message };
        }
    }

    // 2. Newly Registered Domains
    if (enableNRD) {
        try {
            const nrdDomains = await scanNewlyRegisteredDomains({
                kv,
                maxDomains: maxDomainsPerVector,
            });
            const registered = await registerInfraDomains(db, nrdDomains, knownSourceUrls, 'nrd');
            vectorStats.nrd = { found: nrdDomains.length, registered: registered };
            totalNewDomains += registered;
        } catch (err) {
            logger.warn(`[InfraMonitor] NRD vector failed: ${err.message}`);
            vectorStats.nrd = { error: err.message };
        }
    }

    // 3. Reverse DNS Enrichment (only run periodically - expensive)
    if (enableReverseDns) {
        try {
            // Get some known domains from the domain registry to enrich
            const knownDomains = await getKnownDomains(db, 20);
            const enriched = await enrichWithReverseDns(knownDomains, 10);
            for (const { domain, careerUrl } of enriched) {
                try {
                    await registerDomain(db, domain, careerUrl, 'infrastructure');
                    totalNewDomains++;
                } catch { /* skip duplicates */ }
            }
            vectorStats.reverse_dns = { probed: knownDomains.length, enriched: enriched.length };
        } catch (err) {
            logger.warn(`[InfraMonitor] Reverse DNS failed: ${err.message}`);
            vectorStats.reverse_dns = { error: err.message };
        }
    }

    // 4. Cloud Metadata Discovery
    if (enableCloud) {
        try {
            const cloudDomains = await scanCloudDeployments(kv);
            const registered = await registerInfraDomains(db, cloudDomains, knownSourceUrls, 'cloud_metadata');
            vectorStats.cloud_metadata = { found: cloudDomains.length, registered: registered };
            totalNewDomains += registered;
        } catch (err) {
            logger.warn(`[InfraMonitor] Cloud scan failed: ${err.message}`);
            vectorStats.cloud_metadata = { error: err.message };
        }
    }

    logger.info(`[InfraMonitor] Infrastructure scan complete: ${totalNewDomains} domains, ${totalNewSources} sources`);

    return { newDomains: totalNewDomains, newSources: totalNewSources, vectorStats };
}

/**
 * Register domains discovered via infrastructure monitoring.
 */
async function registerInfraDomains(db, domains, knownSourceUrls, origin) {
    let registered = 0;
    for (const domain of domains) {
        try {
            // Check for ATS sources on this domain
            const testUrls = [
                `https://${domain}/careers`,
                `https://${domain}/jobs`,
                `https://careers.${domain}`,
                `https://jobs.${domain}`,
            ];
            const atsSources = detectAtsSources(testUrls, knownSourceUrls);
            for (const source of atsSources) {
                await registerDiscoveredSource(db, {
                    ...source,
                    discovery_origin: `infra_${origin}`,
                });
                registered++;
            }

            // Register domain for career page probing
            await registerDomain(db, domain, null, 'infrastructure');
            registered++;
        } catch {
            // Skip registration errors
        }
    }
    return registered;
}

/**
 * Get known domains from the domain registry for enrichment.
 */
async function getKnownDomains(db, limit = 20) {
    try {
        const result = await db.prepare(
            `SELECT domain FROM domain_registry WHERE status = 'active' LIMIT ?`
        ).bind(limit).all();
        return (result.results || []).map(r => r.domain);
    } catch {
        return [];
    }
}
