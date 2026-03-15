/**
 * @module connectors/freshteam
 * @description Freshteam (Freshworks) ATS connector.
 * Fetches jobs from the public Freshteam API and normalizes them.
 *
 * API: GET https://{company}.freshteam.com/api/job_postings
 */

import { fetchWithTimeout, rateLimitDomain, applySourceLimit, loadAtsCursor, saveAtsCursor, filterByAtsCursor } from './base.js';
import { normalizeJob } from '../core/schema.js';
import { sanitizeText, pLimit } from '../core/utils.js';
import logger from '../core/logger.js';

const CONCURRENCY = 3;

/**
 * Extract company slug from a Freshteam URL or plain string.
 */
function extractSlug(urlOrSlug) {
    try {
        const url = new URL(urlOrSlug);
        const hostname = url.hostname;
        // {slug}.freshteam.com
        const sub = hostname.replace(/\.freshteam\.com$/i, '');
        if (sub) return sub;
    } catch {
        // Plain slug
    }
    return urlOrSlug;
}

function buildApiUrl(slug) {
    return `https://${slug}.freshteam.com/api/job_postings`;
}

/**
 * Normalize a Freshteam job into a RawJob.
 */
function normalizeFreshteamJob(job, source) {
    const categories = [];
    if (job.branch?.name) categories.push(job.branch.name);
    if (job.department?.name) categories.push(job.department.name);
    if (job.location) categories.push(job.location);
    if (job.remote) categories.push('Remote');
    if (job.type) categories.push(job.type);

    return normalizeJob({
        id: `ft-${job.id}`,
        title: job.title || '',
        content: sanitizeText(job.description || ''),
        link: job.applicant_apply_link || job.url || '',
        pubDate: job.created_at || '',
        isoDate: job.created_at || '',
        categories,
        company: source.name || '',
    }, {
        url: source.url,
        name: source.name || 'Freshteam',
        type: 'freshteam',
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
        const jobs = Array.isArray(data) ? data : (data.job_postings || data.data || []);

        const allItems = applySourceLimit(jobs.map(j => normalizeFreshteamJob(j, source)));

        const cursorIds = await loadAtsCursor(kv, 'freshteam', slug);
        const { newItems, cursorSkipped } = filterByAtsCursor(allItems, cursorIds);

        if (newItems.length > 0) {
            const allIds = allItems.map(i => i.id);
            await saveAtsCursor(kv, 'freshteam', slug, allIds);
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

export async function fetchFreshteamJobs(sources, config, kv) {
    const limit = pLimit(CONCURRENCY);
    return Promise.all(sources.map(s => limit(() => fetchSingleBoard(s, config, kv))));
}
