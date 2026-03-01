/**
 * @module connectors/greenhouse
 * @description Greenhouse ATS connector.
 * Fetches jobs from the public Greenhouse boards API and normalizes them
 * into the canonical RawJob schema.
 *
 * API: GET https://boards-api.greenhouse.io/v1/boards/{company}/jobs?content=true
 * Docs: https://developers.greenhouse.io/job-board.html
 */

import { fetchWithTimeout, rateLimitDomain, buildFeedStat } from './base.js';
import { normalizeJob } from '../core/schema.js';
import { sanitizeText, pLimit } from '../core/utils.js';
import logger from '../core/logger.js';

/** Max concurrent Greenhouse API requests. */
const CONCURRENCY = 3;

/**
 * Extract the company slug from a Greenhouse boards URL.
 * Supports:
 *   - https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
 *   - https://boards.greenhouse.io/{slug}
 *   - Plain slug string
 *
 * @param {string} urlOrSlug
 * @returns {string}
 */
function extractSlug(urlOrSlug) {
    try {
        const url = new URL(urlOrSlug);
        const parts = url.pathname.split('/').filter(Boolean);
        // /v1/boards/{slug}/jobs → slug at index 2
        const boardsIdx = parts.indexOf('boards');
        if (boardsIdx >= 0 && parts[boardsIdx + 1]) return parts[boardsIdx + 1];
        // /slug → slug at index 0
        if (parts.length > 0) return parts[0];
    } catch {
        // Not a URL — treat as plain slug
    }
    return urlOrSlug;
}

/**
 * Build the API URL for a Greenhouse company.
 * @param {string} slug
 * @returns {string}
 */
function buildApiUrl(slug) {
    return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
}

/**
 * Normalize a single Greenhouse job object into a RawJob.
 *
 * Greenhouse JSON shape:
 * {
 *   id, title, content, updated_at,
 *   location: { name },
 *   departments: [{ name }],
 *   absolute_url
 * }
 */
function normalizeGreenhouseJob(ghJob, source) {
    const categories = [];
    if (ghJob.departments) {
        for (const dept of ghJob.departments) {
            if (dept.name) categories.push(dept.name);
        }
    }
    if (ghJob.location?.name) {
        categories.push(ghJob.location.name);
    }

    return normalizeJob({
        id: `gh-${ghJob.id}`,
        title: ghJob.title || '',
        content: ghJob.content || '',
        link: ghJob.absolute_url || '',
        pubDate: ghJob.updated_at || '',
        isoDate: ghJob.updated_at || '',
        categories,
        company: source.name || '',
    }, {
        url: source.url,
        name: source.name || 'Greenhouse',
        type: 'greenhouse',
    });
}

/**
 * Fetch jobs from a single Greenhouse company board.
 *
 * @param {object} source - { url, name }
 * @param {object} config
 * @returns {Promise<{ feedUrl: string, sourceName: string, items: RawJob[], error?: string }>}
 */
async function fetchSingleBoard(source, config) {
    const slug = extractSlug(source.url);
    const apiUrl = buildApiUrl(slug);
    const startMs = Date.now();

    try {
        await rateLimitDomain(apiUrl);
        const res = await fetchWithTimeout(apiUrl);

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const data = await res.json();
        const ghJobs = data.jobs || [];

        const items = ghJobs.map(j => normalizeGreenhouseJob(j, source));

        logger.info(`[Greenhouse] ${source.name}: ${items.length} jobs fetched`);

        return {
            feedUrl: source.url,
            sourceName: source.name || slug,
            items,
        };
    } catch (err) {
        const msg = err.name === 'AbortError'
            ? 'Timeout'
            : err.message;
        logger.warn(`[Greenhouse] ${source.name || slug} failed: ${msg}`);
        return {
            feedUrl: source.url,
            sourceName: source.name || slug,
            items: [],
            error: msg,
        };
    }
}

/**
 * Fetch jobs from all Greenhouse sources.
 *
 * @param {object[]} sources - Filtered sources with type 'greenhouse'.
 * @param {object} config
 * @returns {Promise<Array<{ feedUrl: string, sourceName: string, items: RawJob[], error?: string }>>}
 */
export async function fetchGreenhouseJobs(sources, config) {
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
