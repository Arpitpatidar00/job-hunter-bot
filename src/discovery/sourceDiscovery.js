/**
 * @module sourceDiscovery
 * @description Lightweight source discovery layer.
 * Detects ATS platform domains from job URLs encountered during ingestion
 * and auto-registers them as new sources in the D1 source_registry.
 *
 * This enables organic growth of job coverage without manual configuration.
 *
 * Supported detections:
 *   - boards.greenhouse.io/{company}   → type: 'greenhouse'
 *   - jobs.lever.co/{company}          → type: 'lever'
 *   - jobs.ashbyhq.com/{company}       → type: 'ashby'
 *   - apply.workable.com/{company}     → type: 'workable'
 */

import logger from '../core/logger.js';

/**
 * ATS domain patterns for auto-detection.
 * Each pattern maps a hostname regex to { type, slugExtractor, urlBuilder }.
 */
const ATS_PATTERNS = [
    {
        hostname: /boards\.greenhouse\.io/i,
        type: 'greenhouse',
        extractSlug: (pathname) => {
            // /slug or /embed/job_board/... → slug
            const parts = pathname.split('/').filter(Boolean);
            return parts[0] || null;
        },
        buildUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    },
    {
        hostname: /jobs\.lever\.co/i,
        type: 'lever',
        extractSlug: (pathname) => {
            const parts = pathname.split('/').filter(Boolean);
            return parts[0] || null;
        },
        buildUrl: (slug) => `https://api.lever.co/v0/postings/${slug}`,
    },
    {
        hostname: /jobs\.ashbyhq\.com/i,
        type: 'ashby',
        extractSlug: (pathname) => {
            const parts = pathname.split('/').filter(Boolean);
            return parts[0] || null;
        },
        buildUrl: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    },
    {
        hostname: /apply\.workable\.com/i,
        type: 'workable',
        extractSlug: (pathname) => {
            // /company-slug/j/SHORTCODE/ → company-slug
            const parts = pathname.split('/').filter(Boolean);
            // Skip 'api' paths
            if (parts[0] === 'api') return null;
            return parts[0] || null;
        },
        buildUrl: (slug) => `https://apply.workable.com/api/v3/accounts/${slug}/jobs`,
    },
];

/** Domains to skip (job boards, social media, etc.) */
const SKIP_DOMAINS = new Set([
    'linkedin.com', 'indeed.com', 'glassdoor.com', 'monster.com',
    'ziprecruiter.com', 'angel.co', 'wellfound.com', 'dice.com',
    'google.com', 'youtube.com', 'facebook.com', 'twitter.com',
    'github.com', 'stackoverflow.com', 'reddit.com', 'medium.com',
    'boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com',
    'apply.workable.com', 'weworkremotely.com', 'remoteok.com',
    'remoteok.io', 'jobscollider.com', 'himalayas.app',
]);

/**
 * Analyze a batch of job URLs and detect any ATS platforms.
 * Also returns candidate company domains for career page probing.
 *
 * @param {string[]} jobUrls - URLs from ingested jobs.
 * @param {Set<string>} knownSourceUrls - Already registered source URLs.
 * @returns {{ sources: object[], domains: Array<{domain: string, sourceUrl: string}> }}
 */
export function detectAtsSources(jobUrls, knownSourceUrls = new Set()) {
    const discovered = new Map(); // dedup by generated URL
    const candidateDomains = new Map(); // dedup by domain

    for (const rawUrl of jobUrls) {
        if (!rawUrl) continue;

        let parsed;
        try {
            parsed = new URL(rawUrl);
        } catch {
            continue;
        }

        let matchedAts = false;

        for (const pattern of ATS_PATTERNS) {
            if (!pattern.hostname.test(parsed.hostname)) continue;

            const slug = pattern.extractSlug(parsed.pathname);
            if (!slug) continue;

            const sourceUrl = pattern.buildUrl(slug);
            matchedAts = true;

            // Skip if already known or already discovered in this batch
            if (knownSourceUrls.has(sourceUrl)) continue;
            if (discovered.has(sourceUrl)) continue;

            discovered.set(sourceUrl, {
                url: sourceUrl,
                type: pattern.type,
                name: capitalizeSlug(slug),
                enabled: true,
                discovery_origin: 'auto-detected',
            });

            logger.info(`[Discovery] Detected new ${pattern.type} source: ${slug} → ${sourceUrl}`);
        }

        // If no ATS matched, extract domain for career page probing
        if (!matchedAts) {
            const domain = parsed.hostname.replace(/^www\./, '');
            if (!SKIP_DOMAINS.has(domain) && !candidateDomains.has(domain)) {
                candidateDomains.set(domain, { domain, sourceUrl: rawUrl });
            }
        }
    }

    // For backward compatibility, return sources array directly
    // Callers that need domains can use detectAtsSourcesWithDomains()
    return [...discovered.values()];
}

/**
 * Extended version that also returns candidate domains.
 * Used by the self-expanding pipeline.
 *
 * @param {string[]} jobUrls
 * @param {Set<string>} knownSourceUrls
 * @returns {{ sources: object[], domains: Array<{domain: string, sourceUrl: string}> }}
 */
export function detectAtsSourcesWithDomains(jobUrls, knownSourceUrls = new Set()) {
    const discovered = new Map();
    const candidateDomains = new Map();

    for (const rawUrl of jobUrls) {
        if (!rawUrl) continue;

        let parsed;
        try {
            parsed = new URL(rawUrl);
        } catch {
            continue;
        }

        let matchedAts = false;

        for (const pattern of ATS_PATTERNS) {
            if (!pattern.hostname.test(parsed.hostname)) continue;
            const slug = pattern.extractSlug(parsed.pathname);
            if (!slug) continue;
            const sourceUrl = pattern.buildUrl(slug);
            matchedAts = true;

            if (knownSourceUrls.has(sourceUrl) || discovered.has(sourceUrl)) continue;
            discovered.set(sourceUrl, {
                url: sourceUrl,
                type: pattern.type,
                name: capitalizeSlug(slug),
                enabled: true,
                discovery_origin: 'auto-detected',
            });
            logger.info(`[Discovery] Detected new ${pattern.type} source: ${slug} → ${sourceUrl}`);
        }

        if (!matchedAts) {
            const domain = parsed.hostname.replace(/^www\./, '');
            if (!SKIP_DOMAINS.has(domain) && !candidateDomains.has(domain)) {
                candidateDomains.set(domain, { domain, sourceUrl: rawUrl });
            }
        }
    }

    return {
        sources: [...discovered.values()],
        domains: [...candidateDomains.values()],
    };
}

/**
 * Capitalize a slug into a human-readable name.
 * @param {string} slug
 * @returns {string}
 */
function capitalizeSlug(slug) {
    return slug
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}
