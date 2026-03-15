/**
 * @module connectors/jobvite
 * @description Jobvite ATS connector.
 * Fetches jobs from the public Jobvite job listings page and normalizes them.
 *
 * API: GET https://jobs.jobvite.com/CompanyJobs/json/{company}
 * Alt: GET https://jobs.jobvite.com/{company}/search (HTML scraping)
 */

import { fetchWithTimeout, rateLimitDomain, applySourceLimit, loadAtsCursor, saveAtsCursor, filterByAtsCursor } from './base.js';
import { normalizeJob } from '../core/schema.js';
import { sanitizeText, pLimit } from '../core/utils.js';
import logger from '../core/logger.js';

const CONCURRENCY = 3;

/**
 * Extract company slug from a Jobvite URL or plain string.
 */
function extractSlug(urlOrSlug) {
    try {
        const url = new URL(urlOrSlug);
        const parts = url.pathname.split('/').filter(Boolean);
        // /CompanyJobs/json/{slug}
        const jsonIdx = parts.indexOf('json');
        if (jsonIdx >= 0 && parts[jsonIdx + 1]) return parts[jsonIdx + 1];
        // /{slug}/search or /{slug}/jobs
        if (parts.length > 0 && parts[0] !== 'api') return parts[0];
        // ?sc=slug
        const sc = url.searchParams.get('sc');
        if (sc) return sc;
    } catch {
        // Plain slug
    }
    return urlOrSlug;
}

function buildApiUrl(slug) {
    return `https://jobs.jobvite.com/CompanyJobs/json/${slug}`;
}

/**
 * Normalize a Jobvite job into a RawJob.
 */
function normalizeJobviteJob(job, source) {
    const categories = [];
    if (job.location) categories.push(job.location);
    if (job.category) categories.push(job.category);
    if (job.department) categories.push(job.department);
    if (job.jobType) categories.push(job.jobType);

    return normalizeJob({
        id: `jv-${job.id || job.eId}`,
        title: job.title || '',
        content: sanitizeText(job.briefDescription || job.description || ''),
        link: job.detail_url || job.applyLink || '',
        pubDate: job.date || '',
        isoDate: job.date || '',
        categories,
        company: source.name || '',
    }, {
        url: source.url,
        name: source.name || 'Jobvite',
        type: 'jobvite',
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
            // Fallback: try HTML scraping from the career page
            return await fetchFromHtml(source, slug, kv);
        }

        const data = await res.json();
        const requisitions = data.requisitions || (Array.isArray(data) ? data : []);

        const allItems = applySourceLimit(
            requisitions.map(j => normalizeJobviteJob(j, source))
        );

        const cursorIds = await loadAtsCursor(kv, 'jobvite', slug);
        const { newItems, cursorSkipped } = filterByAtsCursor(allItems, cursorIds);

        if (newItems.length > 0) {
            const allIds = allItems.map(i => i.id);
            await saveAtsCursor(kv, 'jobvite', slug, allIds);
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

/**
 * Fallback HTML parsing for Jobvite career pages.
 */
async function fetchFromHtml(source, slug, kv) {
    try {
        const pageUrl = `https://jobs.jobvite.com/${slug}/search`;
        await rateLimitDomain(pageUrl);
        const res = await fetchWithTimeout(pageUrl, {
            headers: {
                Accept: 'text/html',
                'User-Agent': 'JobHunterBot/5.1 (+https://github.com/job-hunter-bot)',
            },
        });

        if (!res.ok) {
            return { feedUrl: source.url, sourceName: source.name || slug, items: [], error: `HTML fallback HTTP ${res.status}` };
        }

        const html = await res.text();
        const jobs = [];

        // Extract job links from HTML: <a class="jv-job-link" href="...">...</a>
        const linkRegex = /<a[^>]*href="(\/[^"]*\/j\/[^"]*)"[^>]*>([^<]*)<\/a>/gi;
        let match;
        while ((match = linkRegex.exec(html)) !== null) {
            jobs.push({
                id: match[1],
                title: match[2].trim(),
                link: `https://jobs.jobvite.com${match[1]}`,
            });
        }

        const allItems = applySourceLimit(jobs.map(j => normalizeJob({
            id: `jv-${j.id}`,
            title: j.title,
            content: j.title,
            link: j.link,
            pubDate: '',
            isoDate: '',
            categories: [],
            company: source.name || slug,
        }, {
            url: source.url,
            name: source.name || 'Jobvite',
            type: 'jobvite',
        })));

        return {
            feedUrl: source.url,
            sourceName: source.name || slug,
            items: allItems,
        };
    } catch (err) {
        return { feedUrl: source.url, sourceName: source.name || slug, items: [], error: err.message };
    }
}

export async function fetchJobviteJobs(sources, config, kv) {
    const limit = pLimit(CONCURRENCY);
    return Promise.all(sources.map(s => limit(() => fetchSingleBoard(s, config, kv))));
}
