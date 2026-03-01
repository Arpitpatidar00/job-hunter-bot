/**
 * @module connectors/careerPage
 * @description Career page connector — fetches job listings from company
 * career pages using JSON-LD JobPosting schema and HTML link extraction.
 *
 * This connector handles sources with `type: 'career_page'`.
 * Each source URL points to a company's career/jobs page.
 */

import { fetchWithTimeout, rateLimitDomain, buildFeedStat } from './base.js';
import { normalizeJob } from '../core/schema.js';
import logger from '../core/logger.js';

/**
 * Fetch and parse jobs from career page sources.
 *
 * @param {object[]} sources - Career page sources `{ url, name, type }`.
 * @param {object} config - Bot config.
 * @returns {Promise<{ items: object[], stats: object[] }>}
 */
export async function fetchCareerPageJobs(sources, config) {
    const allItems = [];
    const allStats = [];

    for (const source of sources) {
        const start = Date.now();
        let items = [];
        let error = null;

        try {
            await rateLimitDomain(source.url, 5000); // 5s between same-domain requests

            const res = await fetchWithTimeout(source.url, {
                headers: {
                    'Accept': 'text/html,application/xhtml+xml',
                    'User-Agent': 'JobHunterBot/5.1 (+https://github.com/job-hunter-bot)',
                },
            }, 15_000); // 15s timeout for HTML pages

            if (!res.ok) {
                throw new Error(`HTTP ${res.status} ${res.statusText}`);
            }

            const html = await res.text();

            // Try JSON-LD first (most structured)
            const jsonLdJobs = extractJsonLdJobs(html, source);
            if (jsonLdJobs.length > 0) {
                items = jsonLdJobs;
                logger.info(`[CareerPage] ${source.name}: Found ${items.length} jobs via JSON-LD`);
            } else {
                // Fallback: extract job links from HTML
                const linkJobs = extractJobLinks(html, source);
                items = linkJobs;
                if (items.length > 0) {
                    logger.info(`[CareerPage] ${source.name}: Found ${items.length} jobs via link extraction`);
                }
            }

            // Normalize all items to RawJob
            items = items.map(raw => normalizeJob(raw, {
                url: source.url,
                name: source.name || 'CareerPage',
                type: 'career_page',
            }));

        } catch (err) {
            error = err.message;
            logger.warn(`[CareerPage] ${source.name} failed: ${err.message}`);
        }

        allItems.push(...items);
        allStats.push(buildFeedStat(source, items, error, Date.now() - start));
    }

    return { items: allItems, stats: allStats };
}

// ── JSON-LD Extraction ──────────────────────────────────────────────────────

/**
 * Extract JobPosting data from JSON-LD script tags.
 *
 * @param {string} html - Full HTML content.
 * @param {object} source - Source metadata.
 * @returns {object[]} Raw job objects.
 */
function extractJsonLdJobs(html, source) {
    const jobs = [];
    // Match all <script type="application/ld+json"> blocks
    const regex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;

    while ((match = regex.exec(html)) !== null) {
        try {
            const data = JSON.parse(match[1]);
            const postings = extractPostingsFromLd(data);
            for (const posting of postings) {
                jobs.push(ldToRawJob(posting, source));
            }
        } catch {
            // Invalid JSON, skip
        }
    }

    return jobs;
}

/**
 * Navigate JSON-LD structures to find JobPosting entries.
 * Handles single objects, arrays, and @graph.
 *
 * @param {*} data - Parsed JSON-LD data.
 * @returns {object[]} JobPosting objects.
 */
function extractPostingsFromLd(data) {
    if (!data) return [];

    // Direct JobPosting
    if (data['@type'] === 'JobPosting') return [data];

    // Array of items
    if (Array.isArray(data)) {
        return data.flatMap(item => extractPostingsFromLd(item));
    }

    // @graph container
    if (data['@graph'] && Array.isArray(data['@graph'])) {
        return data['@graph'].flatMap(item => extractPostingsFromLd(item));
    }

    // ItemList containing JobPostings
    if (data['@type'] === 'ItemList' && Array.isArray(data.itemListElement)) {
        return data.itemListElement.flatMap(el => {
            if (el.item && el.item['@type'] === 'JobPosting') return [el.item];
            if (el['@type'] === 'JobPosting') return [el];
            return [];
        });
    }

    return [];
}

/**
 * Convert a JSON-LD JobPosting to a raw job object.
 *
 * @param {object} posting - JSON-LD JobPosting.
 * @param {object} source - Source metadata.
 * @returns {object}
 */
function ldToRawJob(posting, source) {
    const title = posting.title || posting.name || '';
    const company = posting.hiringOrganization?.name ||
        posting.hiringOrganization?.legalName ||
        source.name || '';
    const url = posting.url || posting.sameAs || '';
    const description = posting.description || '';
    const location = posting.jobLocation?.address?.addressLocality ||
        posting.jobLocation?.name ||
        (posting.jobLocationType === 'TELECOMMUTE' ? 'Remote' : '') || '';
    const datePosted = posting.datePosted || '';

    return {
        title,
        company,
        link: url,
        url,
        content: stripHtml(description),
        description: stripHtml(description),
        pubDate: datePosted,
        isoDate: datePosted,
        categories: [],
        location,
        guid: url || `${source.url}#${title}`,
    };
}

// ── HTML Link Extraction ────────────────────────────────────────────────────

/** Common job URL patterns */
const JOB_LINK_PATTERNS = [
    /\/jobs?\//i,
    /\/careers?\//i,
    /\/positions?\//i,
    /\/openings?\//i,
    /\/apply\//i,
    /\/vacancies?\//i,
    /job[_-]?id/i,
    /posting[_-]?id/i,
];

/**
 * Extract job listing links from HTML content.
 *
 * @param {string} html - Full HTML content.
 * @param {object} source - Source metadata.
 * @returns {object[]} Raw job objects.
 */
function extractJobLinks(html, source) {
    const jobs = [];
    const seenUrls = new Set();

    // Extract all <a href="..."> with title text
    const linkRegex = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    let baseUrl;
    try {
        baseUrl = new URL(source.url);
    } catch {
        return [];
    }

    while ((match = linkRegex.exec(html)) !== null) {
        const href = match[1];
        const linkText = stripHtml(match[2]).trim();

        if (!linkText || linkText.length < 5 || linkText.length > 200) continue;

        // Check if the link looks like a job link
        const isJobLink = JOB_LINK_PATTERNS.some(p => p.test(href));
        if (!isJobLink) continue;

        // Resolve relative URLs
        let fullUrl;
        try {
            fullUrl = new URL(href, baseUrl.origin).href;
        } catch {
            continue;
        }

        // Dedup
        if (seenUrls.has(fullUrl)) continue;
        seenUrls.add(fullUrl);

        jobs.push({
            title: linkText,
            company: source.name || baseUrl.hostname,
            link: fullUrl,
            url: fullUrl,
            content: linkText,
            description: linkText,
            pubDate: new Date().toISOString(),
            isoDate: new Date().toISOString(),
            categories: [],
            guid: fullUrl,
        });
    }

    return jobs;
}

// ── Utilities ───────────────────────────────────────────────────────────────

/**
 * Strip HTML tags from a string.
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-zA-Z]+;/g, ' ')
        .replace(/&#?\d+;/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}
