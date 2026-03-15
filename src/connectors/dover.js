/**
 * @module connectors/dover
 * @description Dover ATS connector.
 * Fetches jobs from the public Dover job board API and normalizes them.
 *
 * API: GET https://app.dover.com/api/v1/job-board/{company}/jobs
 */

import { fetchWithTimeout, rateLimitDomain, applySourceLimit, loadAtsCursor, saveAtsCursor, filterByAtsCursor } from './base.js';
import { normalizeJob } from '../core/schema.js';
import { sanitizeText, pLimit } from '../core/utils.js';
import logger from '../core/logger.js';

const CONCURRENCY = 3;

/**
 * Extract company slug from a Dover URL or plain string.
 */
function extractSlug(urlOrSlug) {
    try {
        const url = new URL(urlOrSlug);
        const parts = url.pathname.split('/').filter(Boolean);
        // /api/v1/job-board/{slug}/jobs
        const boardIdx = parts.indexOf('job-board');
        if (boardIdx >= 0 && parts[boardIdx + 1]) return parts[boardIdx + 1];
        // /jobs/{slug}
        const jobsIdx = parts.indexOf('jobs');
        if (jobsIdx >= 0 && parts[jobsIdx + 1]) return parts[jobsIdx + 1];
        if (parts.length > 0) return parts[0];
    } catch {
        // Plain slug
    }
    return urlOrSlug;
}

function buildApiUrl(slug) {
    return `https://app.dover.com/api/v1/job-board/${slug}/jobs`;
}

/**
 * Normalize a Dover job into a RawJob.
 */
function normalizeDoverJob(job, source) {
    const categories = [];
    if (job.location) categories.push(job.location);
    if (job.department) categories.push(job.department);
    if (job.remote) categories.push('Remote');

    return normalizeJob({
        id: `dover-${job.id}`,
        title: job.title || job.name || '',
        content: sanitizeText(job.description || ''),
        link: job.url || job.apply_url || '',
        pubDate: job.published_at || job.created_at || '',
        isoDate: job.published_at || job.created_at || '',
        categories,
        company: source.name || '',
    }, {
        url: source.url,
        name: source.name || 'Dover',
        type: 'dover',
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
        const jobs = Array.isArray(data) ? data : (data.jobs || data.data || []);

        const allItems = applySourceLimit(jobs.map(j => normalizeDoverJob(j, source)));

        const cursorIds = await loadAtsCursor(kv, 'dover', slug);
        const { newItems, cursorSkipped } = filterByAtsCursor(allItems, cursorIds);

        if (newItems.length > 0) {
            const allIds = allItems.map(i => i.id);
            await saveAtsCursor(kv, 'dover', slug, allIds);
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

export async function fetchDoverJobs(sources, config, kv) {
    const limit = pLimit(CONCURRENCY);
    return Promise.all(sources.map(s => limit(() => fetchSingleBoard(s, config, kv))));
}
