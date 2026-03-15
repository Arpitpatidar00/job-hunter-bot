/**
 * @module discovery/atsEnumerator
 * @description Bulk ATS platform enumeration engine.
 *
 * Systematically probes company slugs across Greenhouse, Lever, Ashby, Workable,
 * and SmartRecruiters to discover job boards at scale. Each successful probe
 * auto-registers the source in the source_registry.
 *
 * This is the highest-ROI discovery vector — a single cycle can yield 50+ new sources.
 *
 * Strategy:
 *   1. Curated seed lists of known tech companies (YC, top startups, etc.)
 *   2. Probe each slug against all ATS APIs
 *   3. Register valid endpoints as new sources
 *   4. Track probed slugs in KV to avoid re-probing
 */

import { fetchWithTimeout, rateLimitDomain } from '../connectors/base.js';
import { registerDiscoveredSource } from '../db/index.js';
import logger from '../core/logger.js';

// ── ATS Probe Definitions ───────────────────────────────────────────────────

/**
 * Each ATS platform has a probe URL and a validator to check if the
 * endpoint returned valid job board data.
 */
const ATS_PROBES = [
    {
        type: 'greenhouse',
        buildUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
        validate: (data) => data && Array.isArray(data.jobs),
        buildSourceUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    },
    {
        type: 'lever',
        buildUrl: (slug) => `https://api.lever.co/v0/postings/${slug}`,
        validate: (data) => Array.isArray(data) && data.length > 0,
        buildSourceUrl: (slug) => `https://api.lever.co/v0/postings/${slug}`,
    },
    {
        type: 'ashby',
        buildUrl: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
        validate: (data) => data && (Array.isArray(data.jobs) || data.jobBoard),
        buildSourceUrl: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    },
    {
        type: 'workable',
        buildUrl: (slug) => `https://apply.workable.com/api/v3/accounts/${slug}/jobs`,
        validate: (data) => data && Array.isArray(data.results),
        buildSourceUrl: (slug) => `https://apply.workable.com/api/v3/accounts/${slug}/jobs`,
        method: 'POST',
        body: JSON.stringify({ query: '', location: [], department: [], remote: null }),
        contentType: 'application/json',
    },
    {
        type: 'smartrecruiters',
        buildUrl: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings`,
        validate: (data) => data && (Array.isArray(data.content) || Array.isArray(data.results)),
        buildSourceUrl: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings`,
    },
    {
        type: 'teamtailor',
        buildUrl: (slug) => `https://${slug}.teamtailor.com/jobs`,
        validate: (data, text) => text && (text.includes('JobPosting') || text.includes('teamtailor')),
        buildSourceUrl: (slug) => `https://api.teamtailor.com/v1/jobs?filter[company_slug]=${slug}`,
        isHtml: true,
    },
    {
        type: 'recruitee',
        buildUrl: (slug) => `https://${slug}.recruitee.com/api/offers`,
        validate: (data) => data && (Array.isArray(data.offers) || Array.isArray(data)),
        buildSourceUrl: (slug) => `https://${slug}.recruitee.com/api/offers`,
    },
    {
        type: 'workday',
        buildUrl: (slug) => `https://${slug}.wd5.myworkdayjobs.com/wday/cxs/${slug}/External_Career_Site/jobs`,
        validate: (data) => data && Array.isArray(data.jobPostings),
        buildSourceUrl: (slug) => `https://${slug}.wd5.myworkdayjobs.com/wday/cxs/${slug}/External_Career_Site/jobs`,
        method: 'POST',
        body: JSON.stringify({ appliedFacets: {}, limit: 5, offset: 0, searchText: '' }),
        contentType: 'application/json',
    },
    {
        type: 'breezy',
        buildUrl: (slug) => `https://${slug}.breezy.hr/json`,
        validate: (data) => Array.isArray(data) && data.length > 0,
        buildSourceUrl: (slug) => `https://${slug}.breezy.hr/json`,
    },
    {
        type: 'rippling',
        buildUrl: (slug) => `https://app.rippling.com/api/recruiting/job-board/${slug}/jobs`,
        validate: (data) => data && (Array.isArray(data) || Array.isArray(data.jobs)),
        buildSourceUrl: (slug) => `https://app.rippling.com/api/recruiting/job-board/${slug}/jobs`,
    },
    {
        type: 'pinpoint',
        buildUrl: (slug) => `https://${slug}.pinpointhq.com/postings.json`,
        validate: (data) => data && (Array.isArray(data) || Array.isArray(data.data)),
        buildSourceUrl: (slug) => `https://${slug}.pinpointhq.com/postings.json`,
    },
    {
        type: 'dover',
        buildUrl: (slug) => `https://app.dover.com/api/v1/job-board/${slug}/jobs`,
        validate: (data) => data && (Array.isArray(data) || Array.isArray(data.jobs)),
        buildSourceUrl: (slug) => `https://app.dover.com/api/v1/job-board/${slug}/jobs`,
    },
    {
        type: 'freshteam',
        buildUrl: (slug) => `https://${slug}.freshteam.com/api/job_postings`,
        validate: (data) => Array.isArray(data) && data.length > 0,
        buildSourceUrl: (slug) => `https://${slug}.freshteam.com/api/job_postings`,
    },
    {
        type: 'jobvite',
        buildUrl: (slug) => `https://jobs.jobvite.com/CompanyJobs/json/${slug}`,
        validate: (data) => data && (data.requisitions || Array.isArray(data)),
        buildSourceUrl: (slug) => `https://jobs.jobvite.com/CompanyJobs/json/${slug}`,
    },
];

// ── Company Slug Seed Lists ─────────────────────────────────────────────────

/**
 * High-value tech company slugs to probe across all ATS platforms.
 * These are known companies that likely use one of the major ATS platforms.
 * Slugs are lowercase, hyphenated versions of company names.
 */
const SEED_SLUGS = [
    // YC Top Companies
    'airbnb', 'stripe', 'dropbox', 'coinbase', 'instacart', 'doordash',
    'gusto', 'brex', 'flexport', 'faire', 'ginkgo-bioworks', 'zapier',
    'mux', 'algolia', 'readme', 'pagerduty', 'mixpanel', 'segment',
    'sendgrid', 'twilio', 'plaid', 'loom', 'replit', 'vercel', 'railway',
    'render', 'neon', 'supabase', 'cal-com', 'dub', 'resend', 'trigger',
    'inngest', 'convex', 'upstash', 'planetscale', 'turso', 'fly',
    // Infrastructure / DevTools
    'datadog', 'grafana-labs', 'hashicorp', 'elastic', 'confluent',
    'snyk', 'sentry', 'newrelic', 'pagerduty', 'circleci', 'buildkite',
    'pulumi', 'terraform', 'docker', 'vscode', 'jetbrains',
    'gitlab', 'atlassian', 'jira', 'bitbucket', 'sourcegraph',
    'linear', 'notion', 'airtable', 'coda', 'clickup', 'asana',
    'monday', 'smartsheet', 'basecamp', 'todoist',
    // AI / ML Companies  
    'openai', 'anthropic', 'hugging-face', 'stability-ai', 'cohere',
    'anyscale', 'weights-and-biases', 'wandb', 'labelbox', 'scale-ai',
    'jasper-ai', 'copy-ai', 'writesonic', 'grammarly', 'deepmind',
    'midjourney', 'runway', 'synthesia', 'descript', 'assemblyai',
    'deepgram', 'eleven-labs', 'replicate', 'modal', 'together-ai',
    'perplexity', 'glean', 'dust', 'langchain', 'pinecone',
    'weaviate', 'qdrant', 'chroma', 'zilliz', 'milvus',
    // Fintech
    'mercury', 'ramp', 'carta', 'deel', 'remote-com', 'oyster',
    'rippling', 'justworks', 'lattice', 'culture-amp', 'lever-co',
    'greenhouse-software', 'ashby', 'workable', 'gem', 'dover',
    'pilot', 'bench', 'wave', 'freshbooks', 'xero',
    // SaaS / B2B
    'hubspot', 'salesforce', 'intercom', 'zendesk', 'freshdesk',
    'drift', 'gong', 'chorus', 'salesloft', 'outreach',
    'apollo', 'clearbit', 'zoominfo', 'lusha', 'snov',
    'calendly', 'chili-piper', 'reclaim-ai', 'clockwise',
    'amplitude', 'posthog', 'heap', 'fullstory', 'hotjar',
    'contentful', 'sanity', 'strapi', 'prismic', 'storyblok',
    'auth0', 'okta', 'clerk', 'magic', 'privy',
    'cloudflare', 'netlify', 'fastly', 'akamai', 'bunny',
    // Databases  
    'mongodb', 'cockroachdb', 'timescale', 'fauna',
    'singlestore', 'materialize', 'redpanda', 'clickhouse',
    'dbt-labs', 'fivetran', 'airbyte', 'stitch', 'census',
    'hightouch', 'rudderstack', 'segment',
    // Security
    'crowdstrike', '1password', 'tailscale', 'nordvpn',
    'proton', 'bitwarden', 'dashlane', 'keeper',
    'lacework', 'orca-security', 'wiz', 'bridgecrew',
    // Design / Creative
    'figma', 'canva', 'miro', 'lottiefiles', 'spline',
    'rive', 'framer', 'webflow', 'bubble', 'retool',
    'appsmith', 'tooljet', 'budibase', 'n8n', 'temporal',
    // E-commerce
    'shopify', 'bigcommerce', 'woocommerce', 'medusa',
    'saleor', 'commercetools', 'boldcommerce', 'gorgias',
    'stamped', 'yotpo', 'klaviyo', 'attentive',
    // Communication
    'discord', 'slack', 'zoom', 'livekit', 'agora',
    'sendbird', 'stream', 'twilio', 'vonage', 'bandwidth',
    'postmark', 'mailgun', 'customer-io', 'braze',
    // Gaming / Entertainment
    'roblox', 'unity', 'epic-games', 'riot-games',
    'niantic', 'supercell', 'scopely', 'playtika',
    // Health / Biotech
    'flatiron-health', 'tempus', 'ro', 'hims',
    'cerebral', 'talkiatry', 'headway', 'alma',
    'sword-health', 'noom', 'calm', 'headspace',
];

/**
 * Additional slugs generated from common naming patterns.
 * These are variations companies often use on ATS platforms.
 */
function generateSlugVariations(slug) {
    const variations = [slug];
    // company-io → companyio
    if (slug.includes('-')) {
        variations.push(slug.replace(/-/g, ''));
    }
    // company → company-inc, company-co
    if (!slug.includes('-')) {
        variations.push(`${slug}-inc`);
        variations.push(`${slug}-co`);
    }
    return variations;
}

// ── KV tracking to avoid re-probing ─────────────────────────────────────────

const PROBED_PREFIX = 'ats_probed:';
const PROBED_TTL = 7 * 24 * 60 * 60; // 7 days — re-probe weekly

/**
 * Check if a slug has been probed recently.
 */
async function wasRecentlyProbed(kv, type, slug) {
    if (!kv) return false;
    try {
        const val = await kv.get(`${PROBED_PREFIX}${type}:${slug}`);
        return val !== null;
    } catch {
        return false;
    }
}

/**
 * Mark a slug as probed.
 */
async function markProbed(kv, type, slug, result) {
    if (!kv) return;
    try {
        await kv.put(`${PROBED_PREFIX}${type}:${slug}`, result, {
            expirationTtl: PROBED_TTL,
        });
    } catch {
        // Non-critical
    }
}

// ── Main Enumeration Function ───────────────────────────────────────────────

/**
 * Run a batch ATS enumeration cycle.
 * Probes a subset of seed slugs against all ATS platforms.
 *
 * @param {D1Database} db - D1 database handle.
 * @param {Set<string>} knownSourceUrls - Already registered source URLs.
 * @param {KVNamespace} [kv] - Optional KV for probe tracking.
 * @param {object} [options]
 * @param {number} [options.maxProbes=30] - Max total probes per cycle.
 * @param {number} [options.maxPlatforms=3] - Max platforms to probe per slug.
 * @returns {Promise<{ newSources: number, probed: number, errors: number }>}
 */
export async function runAtsEnumeration(db, knownSourceUrls, kv = null, options = {}) {
    const { maxProbes = 30, maxPlatforms = 3 } = options;

    let totalProbes = 0;
    let newSources = 0;
    let errors = 0;

    // Shuffle seed list and take a random subset each cycle
    const shuffled = [...SEED_SLUGS].sort(() => Math.random() - 0.5);
    const slugBatch = shuffled.slice(0, Math.ceil(maxProbes / maxPlatforms));

    // Also shuffle platforms so we don't always probe in the same order
    const platformOrder = [...ATS_PROBES].sort(() => Math.random() - 0.5).slice(0, maxPlatforms);

    for (const slug of slugBatch) {
        if (totalProbes >= maxProbes) break;

        for (const probe of platformOrder) {
            if (totalProbes >= maxProbes) break;

            const sourceUrl = probe.buildSourceUrl(slug);

            // Skip if already known
            if (knownSourceUrls.has(sourceUrl)) continue;

            // Skip if recently probed
            if (await wasRecentlyProbed(kv, probe.type, slug)) continue;

            totalProbes++;

            try {
                await rateLimitDomain(probe.buildUrl(slug), 1500);

                const fetchOptions = {
                    headers: { Accept: probe.isHtml ? 'text/html' : 'application/json' },
                };
                if (probe.method === 'POST') {
                    fetchOptions.method = 'POST';
                    fetchOptions.body = probe.body;
                    fetchOptions.headers['Content-Type'] = probe.contentType || 'application/json';
                }

                const res = await fetchWithTimeout(probe.buildUrl(slug), fetchOptions, 8000, 1);

                if (!res.ok) {
                    await markProbed(kv, probe.type, slug, 'miss');
                    continue;
                }

                let isValid = false;
                if (probe.isHtml) {
                    const text = await res.text();
                    isValid = probe.validate(null, text);
                } else {
                    const data = await res.json();
                    isValid = probe.validate(data);
                }

                if (isValid) {
                    // Valid job board found!
                    const capitalizedName = slug
                        .split('-')
                        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                        .join(' ');

                    await registerDiscoveredSource(db, {
                        url: sourceUrl,
                        type: probe.type,
                        name: capitalizedName,
                        enabled: true,
                        discovery_origin: 'ats-enumeration',
                        ats_platform: probe.type,
                    });

                    knownSourceUrls.add(sourceUrl);
                    newSources++;
                    await markProbed(kv, probe.type, slug, 'hit');

                    logger.info(`[AtsEnum] Found ${probe.type} board: ${slug} → ${sourceUrl}`);

                    // If we found a hit on one platform, skip the rest for this slug
                    // (most companies use only one ATS)
                    break;
                } else {
                    await markProbed(kv, probe.type, slug, 'miss');
                }
            } catch (err) {
                errors++;
                await markProbed(kv, probe.type, slug, 'error');
                // Don't log each failure — too noisy
            }
        }

        // Polite delay between slugs
        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
    }

    logger.info(
        `[AtsEnum] Enumeration complete: probed=${totalProbes}, new=${newSources}, errors=${errors}`
    );

    return { newSources, probed: totalProbes, errors };
}

/**
 * Get the seed slug count for metrics.
 */
export function getSeedSlugCount() {
    return SEED_SLUGS.length;
}
