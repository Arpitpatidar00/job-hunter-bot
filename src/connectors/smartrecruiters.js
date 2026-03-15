/**
 * @module connectors/smartrecruiters
 * @description SmartRecruiters ATS connector.
 * Fetches jobs from the public SmartRecruiters API and normalizes them.
 *
 * API: GET https://api.smartrecruiters.com/v1/companies/{company}/postings
 */

import { fetchWithTimeout, rateLimitDomain, applySourceLimit, loadAtsCursor, saveAtsCursor, filterByAtsCursor } from './base.js';
import { normalizeJob } from '../core/schema.js';
import { sanitizeText, pLimit } from '../core/utils.js';
import logger from '../core/logger.js';

const CONCURRENCY = 3;

/**
 * Extract company slug from a SmartRecruiters URL or plain string.
 */
function extractSlug(urlOrSlug) {
    try {
        const url = new URL(urlOrSlug);
        const parts = url.pathname.split('/').filter(Boolean);
        // /v1/companies/{slug}/postings → slug after 'companies'
        const compIdx = parts.indexOf('companies');
        if (compIdx >= 0 && parts[compIdx + 1]) return parts[compIdx + 1];
        // careers.smartrecruiters.com/{slug}
        if (parts.length > 0) return parts[0];
    } catch {
        // Plain slug
    }
    return urlOrSlug;
}

function buildApiUrl(slug) {
    return `https://api.smartrecruiters.com/v1/companies/${slug}/postings`;
}

/**
 * Normalize a SmartRecruiters job into a RawJob.
 *
 * Shape: { id, name, location: { city, region, country, remote },
 *          department: { label }, releasedDate, company: { name },
 *          ref: string (URL) }
 */
function normalizeSmartRecruitersJob(srJob, source) {
    const categories = [];
    if (srJob.department?.label) categories.push(srJob.department.label);
    if (srJob.location) {
        if (srJob.location.city) categories.push(srJob.location.city);
        if (srJob.location.country) categories.push(srJob.location.country);
        if (srJob.location.remote) categories.push('Remote');
    }

    const link = srJob.ref || srJob.applyUrl || '';

    return normalizeJob({
        id: `sr-${srJob.id}`,
        title: srJob.name || '',
        content: sanitizeText(srJob.name || ''),
        link,
        pubDate: srJob.releasedDate || '',
        isoDate: srJob.releasedDate || '',
        categories,
        company: srJob.company?.name || source.name || '',
    }, {
        url: source.url,
        name: source.name || 'SmartRecruiters',
        type: 'smartrecruiters',
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
        const srJobs = data.content || data.results || [];

        const allItems = applySourceLimit(srJobs.map(j => normalizeSmartRecruitersJob(j, source)));

        const cursorIds = await loadAtsCursor(kv, 'smartrecruiters', slug);
        const { newItems, cursorSkipped } = filterByAtsCursor(allItems, cursorIds);

        if (newItems.length > 0) {
            for (const item of allItems) cursorIds.add(item.id);
            await saveAtsCursor(kv, 'smartrecruiters', slug, cursorIds);
        }

        logger.info(`[SmartRecruiters] ${source.name}: ${newItems.length} new / ${cursorSkipped} cursor-skipped / ${allItems.length} total`);

        return {
            feedUrl: source.url,
            sourceName: source.name || slug,
            items: newItems,
            cursorSkipped,
        };
    } catch (err) {
        const msg = err.name === 'AbortError' ? 'Timeout' : err.message;
        logger.warn(`[SmartRecruiters] ${source.name || slug} failed: ${msg}`);
        return {
            feedUrl: source.url,
            sourceName: source.name || slug,
            items: [],
            error: msg,
        };
    }
}

/**
 * Fetch jobs from all SmartRecruiters sources.
 */
export async function fetchSmartRecruitersJobs(sources, config, kv) {
    const limit = pLimit(CONCURRENCY);
    const results = await Promise.all(
        sources.map(s => limit(() => fetchSingleBoard(s, config, kv)))
    );
    return results;
}
