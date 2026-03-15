/**
 * @module connectors/teamtailor
 * @description Teamtailor ATS connector.
 * Fetches jobs from Teamtailor's public embed API and normalizes them.
 *
 * API: GET https://{company}.teamtailor.com/api/v1/jobs (via embed page scraping)
 * Alternative: Company career sites on Teamtailor use a JSON endpoint.
 */

import { fetchWithTimeout, rateLimitDomain, applySourceLimit, loadAtsCursor, saveAtsCursor, filterByAtsCursor } from './base.js';
import { normalizeJob } from '../core/schema.js';
import { sanitizeText, pLimit } from '../core/utils.js';
import logger from '../core/logger.js';

const CONCURRENCY = 3;

/**
 * Extract company slug from a Teamtailor URL or plain string.
 */
function extractSlug(urlOrSlug) {
    try {
        const url = new URL(urlOrSlug);
        const hostname = url.hostname;
        // careers.teamtailor.com/{slug}
        if (/careers\.teamtailor\.com/i.test(hostname)) {
            const parts = url.pathname.split('/').filter(Boolean);
            return parts[0] || null;
        }
        // {slug}.teamtailor.com
        const sub = hostname.replace(/\.teamtailor\.com$/i, '');
        if (sub && sub !== 'careers' && sub !== 'api') return sub;
        // URL with filter param ?filter[company_slug]=slug
        const filterSlug = url.searchParams.get('filter[company_slug]');
        if (filterSlug) return filterSlug;
    } catch {
        // Plain slug
    }
    return urlOrSlug;
}

/**
 * Build the jobs page URL. Teamtailor uses a server-rendered page with
 * embedded JSON data. We fetch the career page and extract JSON-LD or
 * the API-like JSON blob.
 */
function buildPageUrl(slug) {
    return `https://${slug}.teamtailor.com/jobs`;
}

/**
 * Normalize a Teamtailor job into a RawJob.
 */
function normalizeTeamtailorJob(job, source) {
    const categories = [];
    if (job.department) categories.push(job.department);
    if (job.location) categories.push(job.location);
    if (job.remote_status === 'fully') categories.push('Remote');

    return normalizeJob({
        id: `tt-${job.id}`,
        title: job.title || '',
        content: sanitizeText(job.pitch || job.body || ''),
        link: job.careersite_job_url || job.links?.careersite_job_url || '',
        pubDate: job.created_at || '',
        isoDate: job.created_at || '',
        categories,
        company: source.name || '',
    }, {
        url: source.url,
        name: source.name || 'Teamtailor',
        type: 'teamtailor',
    });
}

async function fetchSingleBoard(source, config, kv) {
    const slug = extractSlug(source.url);
    const pageUrl = buildPageUrl(slug);

    try {
        await rateLimitDomain(pageUrl);
        const res = await fetchWithTimeout(pageUrl, {
            headers: {
                Accept: 'text/html,application/xhtml+xml',
                'User-Agent': 'JobHunterBot/5.1 (+https://github.com/job-hunter-bot)',
            },
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const html = await res.text();

        // Extract jobs from JSON-LD or embedded data
        const jobs = extractJobsFromHtml(html, slug);
        const allItems = applySourceLimit(jobs.map(j => normalizeTeamtailorJob(j, source)));

        const cursorIds = await loadAtsCursor(kv, 'teamtailor', slug);
        const { newItems, cursorSkipped } = filterByAtsCursor(allItems, cursorIds);

        if (newItems.length > 0) {
            for (const item of allItems) cursorIds.add(item.id);
            await saveAtsCursor(kv, 'teamtailor', slug, cursorIds);
        }

        logger.info(`[Teamtailor] ${source.name}: ${newItems.length} new / ${cursorSkipped} cursor-skipped / ${allItems.length} total`);

        return {
            feedUrl: source.url,
            sourceName: source.name || slug,
            items: newItems,
            cursorSkipped,
        };
    } catch (err) {
        const msg = err.name === 'AbortError' ? 'Timeout' : err.message;
        logger.warn(`[Teamtailor] ${source.name || slug} failed: ${msg}`);
        return {
            feedUrl: source.url,
            sourceName: source.name || slug,
            items: [],
            error: msg,
        };
    }
}

/**
 * Extract job data from Teamtailor HTML.
 * Teamtailor embeds job data in JSON-LD or data attributes.
 */
function extractJobsFromHtml(html, slug) {
    const jobs = [];

    // Try JSON-LD first
    const jsonLdRegex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = jsonLdRegex.exec(html)) !== null) {
        try {
            const data = JSON.parse(match[1]);
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
                if (item['@type'] === 'JobPosting') {
                    jobs.push({
                        id: item.identifier?.value || item.url || `${slug}-${jobs.length}`,
                        title: item.title || item.name || '',
                        body: item.description || '',
                        location: item.jobLocation?.address?.addressLocality || '',
                        department: item.occupationalCategory || '',
                        careersite_job_url: item.url || '',
                        created_at: item.datePosted || '',
                    });
                }
            }
        } catch {
            // Invalid JSON-LD, continue
        }
    }

    // Fallback: extract job links from HTML
    if (jobs.length === 0) {
        const linkRegex = /href=["'](\/jobs\/[^"']+)["'][^>]*>([^<]+)</gi;
        while ((match = linkRegex.exec(html)) !== null) {
            const path = match[1];
            const title = match[2].trim();
            if (title && title.length > 3) {
                jobs.push({
                    id: `${slug}-${path.replace(/\W+/g, '-')}`,
                    title,
                    body: '',
                    location: '',
                    department: '',
                    careersite_job_url: `https://${slug}.teamtailor.com${path}`,
                    created_at: '',
                });
            }
        }
    }

    return jobs;
}

/**
 * Fetch jobs from all Teamtailor sources.
 */
export async function fetchTeamtailorJobs(sources, config, kv) {
    const limit = pLimit(CONCURRENCY);
    const results = await Promise.all(
        sources.map(s => limit(() => fetchSingleBoard(s, config, kv)))
    );
    return results;
}
