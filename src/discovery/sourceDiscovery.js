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
 *   - jobs.breezy.hr/{company}         → type: 'breezy'
 *   - careers.smartrecruiters.com/{co} → type: 'smartrecruiters'
 *   - {company}.recruitee.com          → type: 'recruitee'
 *   - app.rippling.com/jobs/{company}  → type: 'rippling'
 *   - {company}.pinpointhq.com         → type: 'pinpoint'
 *   - careers.teamtailor.com/{company} → type: 'teamtailor'
 *   - app.dover.com/jobs/{company}     → type: 'dover'
 *   - {company}.freshteam.com          → type: 'freshteam'
 *   - jobs.jobvite.com/{company}       → type: 'jobvite'
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
        // Ashby public job boards — two hostnames in use
        hostname: /jobs\.ashbyhq\.com/i,
        type: 'ashby',
        extractSlug: (pathname) => {
            const parts = pathname.split('/').filter(Boolean);
            return parts[0] || null;
        },
        buildUrl: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    },
    {
        // Ashby alternate vanity URL: {company}.ashbyhq.com
        hostname: /\.ashbyhq\.com$/i,
        type: 'ashby',
        extractSlug: (_pathname, hostname) => {
            // Extract company slug from subdomain: company.ashbyhq.com → company
            const sub = hostname.replace(/\.ashbyhq\.com$/i, '');
            return sub && sub !== 'api' && sub !== 'jobs' ? sub : null;
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
    {
        // Breezy HR: jobs.breezy.hr/{company}/positions
        hostname: /jobs\.breezy\.hr/i,
        type: 'breezy',
        extractSlug: (pathname) => {
            const parts = pathname.split('/').filter(Boolean);
            return parts[0] || null;
        },
        buildUrl: (slug) => `https://breezy.hr/api/v3/company/${slug}/positions?type=published`,
    },
    {
        // Breezy vanity: {company}.breezy.hr
        hostname: /\.breezy\.hr$/i,
        type: 'breezy',
        extractSlug: (_pathname, hostname) => {
            const sub = hostname.replace(/\.breezy\.hr$/i, '');
            return sub && sub !== 'jobs' ? sub : null;
        },
        buildUrl: (slug) => `https://breezy.hr/api/v3/company/${slug}/positions?type=published`,
    },
    {
        // SmartRecruiters: careers.smartrecruiters.com/{company}
        hostname: /careers\.smartrecruiters\.com/i,
        type: 'smartrecruiters',
        extractSlug: (pathname) => {
            const parts = pathname.split('/').filter(Boolean);
            return parts[0] || null;
        },
        buildUrl: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings`,
    },
    {
        // Recruitee: {company}.recruitee.com/o
        hostname: /\.recruitee\.com$/i,
        type: 'recruitee',
        extractSlug: (_pathname, hostname) => {
            const sub = hostname.replace(/\.recruitee\.com$/i, '');
            return sub || null;
        },
        buildUrl: (slug) => `https://${slug}.recruitee.com/api/offers`,
    },
    {
        // Rippling ATS: app.rippling.com/jobs/{company}
        hostname: /app\.rippling\.com/i,
        type: 'rippling',
        extractSlug: (pathname) => {
            // /jobs/{company} or /job-board/{company}
            const parts = pathname.split('/').filter(Boolean);
            if (parts[0] === 'jobs' || parts[0] === 'job-board') return parts[1] || null;
            return null;
        },
        buildUrl: (slug) => `https://app.rippling.com/api/recruiting/job-board/${slug}/jobs`,
    },
    {
        // Pinpoint: {company}.pinpointhq.com
        hostname: /\.pinpointhq\.com$/i,
        type: 'pinpoint',
        extractSlug: (_pathname, hostname) => {
            const sub = hostname.replace(/\.pinpointhq\.com$/i, '');
            return sub && sub !== 'app' ? sub : null;
        },
        buildUrl: (slug) => `https://api.pinpointhq.com/apiv2/v1/jobs?company_slug=${slug}`,
    },
    {
        // Teamtailor: careers.teamtailor.com/{company} or {company}.teamtailor.com
        hostname: /\.teamtailor\.com$/i,
        type: 'teamtailor',
        extractSlug: (pathname, hostname) => {
            if (/careers\.teamtailor\.com/i.test(hostname)) {
                const parts = pathname.split('/').filter(Boolean);
                return parts[0] || null;
            }
            const sub = hostname.replace(/\.teamtailor\.com$/i, '');
            return sub && sub !== 'careers' ? sub : null;
        },
        buildUrl: (slug) => `https://api.teamtailor.com/v1/jobs?filter[company_slug]=${slug}`,
    },
    {
        // Dover: app.dover.com/jobs/{company}
        hostname: /app\.dover\.com/i,
        type: 'dover',
        extractSlug: (pathname) => {
            const parts = pathname.split('/').filter(Boolean);
            if (parts[0] === 'jobs') return parts[1] || null;
            return null;
        },
        buildUrl: (slug) => `https://app.dover.com/api/v1/job-board/${slug}/jobs`,
    },
    {
        // Freshteam: {company}.freshteam.com/jobs
        hostname: /\.freshteam\.com$/i,
        type: 'freshteam',
        extractSlug: (_pathname, hostname) => {
            const sub = hostname.replace(/\.freshteam\.com$/i, '');
            return sub || null;
        },
        buildUrl: (slug) => `https://${slug}.freshteam.com/api/open_positions`,
    },
    {
        // Jobvite: jobs.jobvite.com/{company}
        hostname: /jobs\.jobvite\.com/i,
        type: 'jobvite',
        extractSlug: (pathname) => {
            const parts = pathname.split('/').filter(Boolean);
            return parts[0] || null;
        },
        buildUrl: (slug) => `https://api.jobvite.com/api/v2/job?sc=${slug}`,
    },
];

/** Domains to skip (job boards, social media, etc.) */
const SKIP_DOMAINS = new Set([
    // Major generic job boards
    'linkedin.com', 'indeed.com', 'glassdoor.com', 'monster.com',
    'ziprecruiter.com', 'angel.co', 'wellfound.com', 'dice.com',
    'careerbuilder.com', 'simplyhired.com', 'builtin.com',
    'getro.com', 'hiring.cafe', 'joinus.world',
    // Social / search / generic
    'google.com', 'youtube.com', 'facebook.com', 'twitter.com',
    'x.com', 'tiktok.com', 'instagram.com', 'threads.net',
    'github.com', 'stackoverflow.com', 'reddit.com', 'medium.com',
    'wikipedia.org', 'notion.so', 'substack.com', 'hashnode.com',
    // ATS platforms already handled by pattern detection — skip raw domain
    'boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com',
    'apply.workable.com', 'jobs.breezy.hr', 'app.breezy.hr',
    'careers.smartrecruiters.com', 'jobs.workable.com',
    'app.rippling.com', 'app.dover.com', 'jobs.jobvite.com',
    // Remote/niche job boards (indexed as RSS feeds, not career domains)
    'weworkremotely.com', 'remoteok.com', 'remoteok.io',
    'jobscollider.com', 'himalayas.app', 'jobspresso.co',
    '4dayweek.io', 'smartremotejobs.com', 'landing.jobs',
    'cryptojobslist.com', 'cryptocurrencyjobs.co', 'hireweb3.io',
    'fossjobs.net', 'hasjob.co', 'remoteworkhub.com',
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

            // Pass hostname as second arg so subdomain-based patterns (Ashby vanity,
            // Breezy vanity, Recruitee) can extract the company slug from the hostname.
            const slug = pattern.extractSlug(parsed.pathname, parsed.hostname);
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
            // Pass hostname so subdomain-based patterns can extract slug from it
            const slug = pattern.extractSlug(parsed.pathname, parsed.hostname);
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

// ── Social / Community Sources ────────────────────────────────────────────────

/**
 * Return a fixed list of community-based RSS sources (Reddit job threads).
 * These are seeded once and do not require URL-pattern detection.
 *
 * @returns {object[]} Source entries compatible with source_registry.
 */
export function detectSocialSources() {
    return [
        {
            url: 'https://www.reddit.com/r/forhire/.rss',
            type: 'rss',
            name: 'Reddit r/forhire',
            enabled: true,
            discovery_origin: 'social-seed',
        },
        {
            url: 'https://www.reddit.com/r/remotework/search.rss?q=hiring&sort=new',
            type: 'rss',
            name: 'Reddit r/remotework Hiring',
            enabled: true,
            discovery_origin: 'social-seed',
        },
        {
            url: 'https://www.reddit.com/r/cscareerquestions/search.rss?q=hiring+OR+%5Bhiring%5D&sort=new',
            type: 'rss',
            name: 'Reddit r/cscareerquestions Hiring',
            enabled: true,
            discovery_origin: 'social-seed',
        },
    ];
}
