/**
 * @module connectors/recruitee
 * @description Recruitee ATS connector.
 * Fetches jobs from the public Recruitee offers API and normalizes them.
 *
 * API: GET https://{company}.recruitee.com/api/offers
 */

import { fetchWithTimeout, rateLimitDomain, applySourceLimit, loadAtsCursor, saveAtsCursor, filterByAtsCursor } from './base.js';
import { normalizeJob } from '../core/schema.js';
import { sanitizeText, pLimit } from '../core/utils.js';
import logger from '../core/logger.js';

const CONCURRENCY = 3;

/**
 * Extract company slug from a Recruitee URL or plain string.
 */
function extractSlug(urlOrSlug) {
    try {
        const url = new URL(urlOrSlug);
        // {company}.recruitee.com → extract subdomain
        const sub = url.hostname.replace(/\.recruitee\.com$/i, '');
        if (sub && sub !== 'api') return sub;
        // URL path: /api/offers or similar
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0] === 'api') return null;
        return parts[0] || null;
    } catch {
        // Plain slug
    }
    return urlOrSlug;
}

function buildApiUrl(slug) {
    return `https://${slug}.recruitee.com/api/offers`;
}

/**
 * Normalize a Recruitee offer into a RawJob.
 *
 * Shape: { id, title, description, department, location, city, country,
 *          remote, slug, careers_url, created_at, published_at }
 */
function normalizeRecruiteeJob(offer, source, slug) {
    const categories = [];
    if (offer.department) categories.push(offer.department);
    if (offer.city) categories.push(offer.city);
    if (offer.country) categories.push(offer.country);
    if (offer.location) categories.push(offer.location);
    if (offer.remote) categories.push('Remote');

    const link = offer.careers_url
        || offer.url
        || `https://${slug}.recruitee.com/o/${offer.slug || offer.id}`;

    return normalizeJob({
        id: `recruitee-${offer.id}`,
        title: offer.title || '',
        content: sanitizeText(offer.description || ''),
        link,
        pubDate: offer.published_at || offer.created_at || '',
        isoDate: offer.published_at || offer.created_at || '',
        categories,
        company: source.name || '',
    }, {
        url: source.url,
        name: source.name || 'Recruitee',
        type: 'recruitee',
    });
}

async function fetchSingleBoard(source, config, kv) {
    const slug = extractSlug(source.url);
    if (!slug) {
        return { feedUrl: source.url, sourceName: source.name, items: [], error: 'Could not extract slug' };
    }

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
        const offers = data.offers || [];

        const allItems = applySourceLimit(offers.map(o => normalizeRecruiteeJob(o, source, slug)));

        const cursorIds = await loadAtsCursor(kv, 'recruitee', slug);
        const { newItems, cursorSkipped } = filterByAtsCursor(allItems, cursorIds);

        if (newItems.length > 0) {
            for (const item of allItems) cursorIds.add(item.id);
            await saveAtsCursor(kv, 'recruitee', slug, cursorIds);
        }

        logger.info(`[Recruitee] ${source.name}: ${newItems.length} new / ${cursorSkipped} cursor-skipped / ${allItems.length} total`);

        return {
            feedUrl: source.url,
            sourceName: source.name || slug,
            items: newItems,
            cursorSkipped,
        };
    } catch (err) {
        const msg = err.name === 'AbortError' ? 'Timeout' : err.message;
        logger.warn(`[Recruitee] ${source.name || slug} failed: ${msg}`);
        return {
            feedUrl: source.url,
            sourceName: source.name || slug,
            items: [],
            error: msg,
        };
    }
}

/**
 * Fetch jobs from all Recruitee sources.
 */
export async function fetchRecruiteeJobs(sources, config, kv) {
    const limit = pLimit(CONCURRENCY);
    const results = await Promise.all(
        sources.map(s => limit(() => fetchSingleBoard(s, config, kv)))
    );
    return results;
}
