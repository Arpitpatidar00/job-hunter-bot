/**
 * @module connectors/rippling
 * @description Rippling ATS connector.
 * Fetches jobs from the public Rippling job board API and normalizes them.
 *
 * API: GET https://api.rippling.com/platform/api/ats/v1/org/{company}/jobs
 * Alt: GET https://app.rippling.com/api/recruiting/job-board/{company}/jobs
 */

import { fetchWithTimeout, rateLimitDomain, applySourceLimit, loadAtsCursor, saveAtsCursor, filterByAtsCursor } from './base.js';
import { normalizeJob } from '../core/schema.js';
import { sanitizeText, pLimit } from '../core/utils.js';
import logger from '../core/logger.js';

const CONCURRENCY = 3;

/**
 * Extract company slug from a Rippling URL or plain string.
 */
function extractSlug(urlOrSlug) {
    try {
        const url = new URL(urlOrSlug);
        const parts = url.pathname.split('/').filter(Boolean);
        // /api/recruiting/job-board/{slug}/jobs or /jobs/{slug}
        const boardIdx = parts.indexOf('job-board');
        if (boardIdx >= 0 && parts[boardIdx + 1]) return parts[boardIdx + 1];
        const jobsIdx = parts.indexOf('jobs');
        if (jobsIdx >= 0 && parts[jobsIdx + 1]) return parts[jobsIdx + 1];
        if (parts.length > 0) return parts[parts.length - 1];
    } catch {
        // Plain slug
    }
    return urlOrSlug;
}

function buildApiUrl(slug) {
    return `https://app.rippling.com/api/recruiting/job-board/${slug}/jobs`;
}

/**
 * Normalize a Rippling job into a RawJob.
 */
function normalizeRipplingJob(job, source) {
    const categories = [];
    if (job.location) categories.push(job.location);
    if (job.department) categories.push(job.department);
    if (job.remoteType) categories.push(job.remoteType);

    return normalizeJob({
        id: `rippling-${job.id}`,
        title: job.title || job.name || '',
        content: sanitizeText(job.description || ''),
        link: job.url || job.applyUrl || '',
        pubDate: job.createdAt || job.publishedAt || '',
        isoDate: job.createdAt || job.publishedAt || '',
        categories,
        company: source.name || '',
    }, {
        url: source.url,
        name: source.name || 'Rippling',
        type: 'rippling',
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
        const jobs = Array.isArray(data) ? data : (data.jobs || data.results || []);

        const allItems = applySourceLimit(jobs.map(j => normalizeRipplingJob(j, source)));

        const cursorIds = await loadAtsCursor(kv, 'rippling', slug);
        const { newItems, cursorSkipped } = filterByAtsCursor(allItems, cursorIds);

        if (newItems.length > 0) {
            const allIds = allItems.map(i => i.id);
            await saveAtsCursor(kv, 'rippling', slug, allIds);
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

export async function fetchRipplingJobs(sources, config, kv) {
    const limit = pLimit(CONCURRENCY);
    return Promise.all(sources.map(s => limit(() => fetchSingleBoard(s, config, kv))));
}
