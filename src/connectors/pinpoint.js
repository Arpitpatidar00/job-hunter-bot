/**
 * @module connectors/pinpoint
 * @description Pinpoint ATS connector.
 * Fetches jobs from the public Pinpoint API and normalizes them.
 *
 * API: GET https://{company}.pinpointhq.com/postings.json
 */

import { fetchWithTimeout, rateLimitDomain, applySourceLimit, loadAtsCursor, saveAtsCursor, filterByAtsCursor } from './base.js';
import { normalizeJob } from '../core/schema.js';
import { sanitizeText, pLimit } from '../core/utils.js';
import logger from '../core/logger.js';

const CONCURRENCY = 3;

/**
 * Extract company slug from a Pinpoint URL or plain string.
 */
function extractSlug(urlOrSlug) {
    try {
        const url = new URL(urlOrSlug);
        const hostname = url.hostname;
        // {slug}.pinpointhq.com
        const sub = hostname.replace(/\.pinpointhq\.com$/i, '');
        if (sub && sub !== 'app' && sub !== 'api') return sub;
        // API URL: ?company_slug=slug
        const slug = url.searchParams.get('company_slug');
        if (slug) return slug;
    } catch {
        // Plain slug
    }
    return urlOrSlug;
}

function buildApiUrl(slug) {
    return `https://${slug}.pinpointhq.com/postings.json`;
}

/**
 * Normalize a Pinpoint job into a RawJob.
 */
function normalizePinpointJob(job, source) {
    const categories = [];
    if (job.location?.name) categories.push(job.location.name);
    if (job.department?.name) categories.push(job.department.name);
    if (job.remote) categories.push('Remote');

    return normalizeJob({
        id: `pinpoint-${job.id}`,
        title: job.title || '',
        content: sanitizeText(job.description || ''),
        link: job.url || job.application_url || '',
        pubDate: job.published_at || job.created_at || '',
        isoDate: job.published_at || job.created_at || '',
        categories,
        company: source.name || '',
    }, {
        url: source.url,
        name: source.name || 'Pinpoint',
        type: 'pinpoint',
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
        const jobs = Array.isArray(data) ? data : (data.data || data.postings || []);

        const allItems = applySourceLimit(jobs.map(j => normalizePinpointJob(j, source)));

        const cursorIds = await loadAtsCursor(kv, 'pinpoint', slug);
        const { newItems, cursorSkipped } = filterByAtsCursor(allItems, cursorIds);

        if (newItems.length > 0) {
            const allIds = allItems.map(i => i.id);
            await saveAtsCursor(kv, 'pinpoint', slug, allIds);
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

export async function fetchPinpointJobs(sources, config, kv) {
    const limit = pLimit(CONCURRENCY);
    return Promise.all(sources.map(s => limit(() => fetchSingleBoard(s, config, kv))));
}
