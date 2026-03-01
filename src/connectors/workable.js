/**
 * @module connectors/workable
 * @description Workable ATS connector.
 * Fetches jobs from the public Workable jobs API and normalizes them
 * into the canonical RawJob schema.
 *
 * API: GET https://apply.workable.com/api/v3/accounts/{company}/jobs
 */

import { fetchWithTimeout, rateLimitDomain } from './base.js';
import { normalizeJob } from '../core/schema.js';
import { sanitizeText, pLimit } from '../core/utils.js';
import logger from '../core/logger.js';

/** Max concurrent Workable API requests. */
const CONCURRENCY = 3;

/**
 * Extract company slug from a Workable URL or plain string.
 * Supports:
 *   - https://apply.workable.com/api/v3/accounts/{slug}/jobs
 *   - https://apply.workable.com/{slug}
 *   - Plain slug
 *
 * @param {string} urlOrSlug
 * @returns {string}
 */
function extractSlug(urlOrSlug) {
    try {
        const url = new URL(urlOrSlug);
        const parts = url.pathname.split('/').filter(Boolean);
        // /api/v3/accounts/{slug}/jobs → slug at index 3
        const accountsIdx = parts.indexOf('accounts');
        if (accountsIdx >= 0 && parts[accountsIdx + 1]) return parts[accountsIdx + 1];
        // /slug → slug at index 0
        if (parts.length > 0) return parts[0];
    } catch {
        // Plain slug
    }
    return urlOrSlug;
}

/**
 * Build the API URL for a Workable company.
 * @param {string} slug
 * @returns {string}
 */
function buildApiUrl(slug) {
    return `https://apply.workable.com/api/v3/accounts/${slug}/jobs`;
}

/**
 * Normalize a single Workable job into a RawJob.
 *
 * Workable JSON shape:
 * {
 *   id, title, shortDescription, description,
 *   department, location: { city, country, countryCode, region, remote },
 *   published, shortcode, url
 * }
 */
function normalizeWorkableJob(wJob, source, slug) {
    const categories = [];
    if (wJob.department) categories.push(wJob.department);
    if (wJob.location) {
        if (wJob.location.city) categories.push(wJob.location.city);
        if (wJob.location.country) categories.push(wJob.location.country);
        if (wJob.location.remote) categories.push('Remote');
    }

    const content = wJob.description
        || wJob.shortDescription
        || '';

    const link = wJob.url
        || `https://apply.workable.com/${slug}/j/${wJob.shortcode || wJob.id}/`;

    return normalizeJob({
        id: `workable-${wJob.id || wJob.shortcode}`,
        title: wJob.title || '',
        content: sanitizeText(content),
        link,
        pubDate: wJob.published || '',
        isoDate: wJob.published || '',
        categories,
        company: source.name || '',
    }, {
        url: source.url,
        name: source.name || 'Workable',
        type: 'workable',
    });
}

/**
 * Fetch jobs from a single Workable company.
 *
 * @param {object} source - { url, name }
 * @param {object} config
 * @returns {Promise<{ feedUrl: string, sourceName: string, items: RawJob[], error?: string }>}
 */
async function fetchSingleBoard(source, config) {
    const slug = extractSlug(source.url);
    const apiUrl = buildApiUrl(slug);

    try {
        await rateLimitDomain(apiUrl);
        const res = await fetchWithTimeout(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: '', location: [], department: [], remote: null }),
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const data = await res.json();
        const wJobs = data.results || [];

        const items = wJobs.map(j => normalizeWorkableJob(j, source, slug));

        logger.info(`[Workable] ${source.name}: ${items.length} jobs fetched`);

        return {
            feedUrl: source.url,
            sourceName: source.name || slug,
            items,
        };
    } catch (err) {
        const msg = err.name === 'AbortError' ? 'Timeout' : err.message;
        logger.warn(`[Workable] ${source.name || slug} failed: ${msg}`);
        return {
            feedUrl: source.url,
            sourceName: source.name || slug,
            items: [],
            error: msg,
        };
    }
}

/**
 * Fetch jobs from all Workable sources.
 *
 * @param {object[]} sources
 * @param {object} config
 * @returns {Promise<Array<{ feedUrl: string, sourceName: string, items: RawJob[], error?: string }>>}
 */
export async function fetchWorkableJobs(sources, config) {
    const limit = pLimit(CONCURRENCY);

    const promises = sources.map(source =>
        limit(() => fetchSingleBoard(source, config))
    );

    const results = await Promise.allSettled(promises);

    return results.map((result, i) => {
        if (result.status === 'fulfilled') return result.value;
        return {
            feedUrl: sources[i].url,
            sourceName: sources[i].name,
            items: [],
            error: result.reason?.message || 'Unknown error',
        };
    });
}
