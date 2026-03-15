/**
 * @module connectors/breezy
 * @description Breezy HR ATS connector.
 * Fetches jobs from the public Breezy HR API and normalizes them.
 *
 * API: GET https://{company}.breezy.hr/json
 * Alt: GET https://breezy.hr/api/v3/company/{slug}/positions?type=published
 */

import { fetchWithTimeout, rateLimitDomain, applySourceLimit, loadAtsCursor, saveAtsCursor, filterByAtsCursor } from './base.js';
import { normalizeJob } from '../core/schema.js';
import { sanitizeText, pLimit } from '../core/utils.js';
import logger from '../core/logger.js';

const CONCURRENCY = 3;

/**
 * Extract company slug from a Breezy URL or plain string.
 */
function extractSlug(urlOrSlug) {
    try {
        const url = new URL(urlOrSlug);
        const hostname = url.hostname;
        // jobs.breezy.hr/{slug}
        if (/^jobs\.breezy\.hr$/i.test(hostname)) {
            const parts = url.pathname.split('/').filter(Boolean);
            return parts[0] || null;
        }
        // {slug}.breezy.hr
        const sub = hostname.replace(/\.breezy\.hr$/i, '');
        if (sub && sub !== 'jobs' && sub !== 'api' && sub !== 'app') return sub;
        // /api/v3/company/{slug}/positions
        const parts = url.pathname.split('/').filter(Boolean);
        const companyIdx = parts.indexOf('company');
        if (companyIdx >= 0 && parts[companyIdx + 1]) return parts[companyIdx + 1];
    } catch {
        // Plain slug
    }
    return urlOrSlug;
}

function buildApiUrl(slug) {
    return `https://${slug}.breezy.hr/json`;
}

/**
 * Normalize a Breezy job into a RawJob.
 */
function normalizeBreezyJob(job, source, slug) {
    const categories = [];
    if (job.location?.name) categories.push(job.location.name);
    if (job.location?.city) categories.push(job.location.city);
    if (job.location?.country) categories.push(job.location.country);
    if (job.location?.is_remote) categories.push('Remote');
    if (job.department) categories.push(job.department);
    if (job.type?.name) categories.push(job.type.name);

    const link = job.url || `https://${slug}.breezy.hr/p/${job.friendly_id || job.id}`;

    return normalizeJob({
        id: `breezy-${job.id || job.friendly_id}`,
        title: job.name || '',
        content: sanitizeText(job.description || ''),
        link,
        pubDate: job.published_date || job.creation_date || '',
        isoDate: job.published_date || job.creation_date || '',
        categories,
        company: job.company?.name || source.name || '',
    }, {
        url: source.url,
        name: source.name || 'Breezy',
        type: 'breezy',
    });
}

async function fetchSingleBoard(source, config, kv) {
    const slug = extractSlug(source.url);
    const apiUrl = buildApiUrl(slug);

    try {
        await rateLimitDomain(apiUrl);
        const res = await fetchWithTimeout(apiUrl, {
            headers: { Accept: 'application/json' },
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const data = await res.json();
        const positions = Array.isArray(data) ? data : (data.positions || []);

        const allItems = applySourceLimit(
            positions.map(j => normalizeBreezyJob(j, source, slug))
        );

        const cursorIds = await loadAtsCursor(kv, 'breezy', slug);
        const { newItems, cursorSkipped } = filterByAtsCursor(allItems, cursorIds);

        if (newItems.length > 0) {
            const allIds = allItems.map(i => i.id);
            await saveAtsCursor(kv, 'breezy', slug, allIds);
        }

        return {
            feedUrl: source.url,
            sourceName: source.name || slug,
            items: newItems,
            cursorSkipped,
        };
    } catch (err) {
        return {
            feedUrl: source.url,
            sourceName: source.name || slug,
            items: [],
            error: err.message,
        };
    }
}

export async function fetchBreezyJobs(sources, config, kv) {
    const limit = pLimit(CONCURRENCY);
    return Promise.all(sources.map(s => limit(() => fetchSingleBoard(s, config, kv))));
}
