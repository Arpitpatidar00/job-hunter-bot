/**
 * @module connectors/rss
 * @description RSS/Atom feed SourceConnector.
 * Fetches, parses and normalizes jobs from RSS 2.0 and Atom feeds.
 * Returns an array of `RawJob` objects conforming to the canonical schema.
 */

import { retryWithBackoff, sanitizeText, pLimit } from '../core/utils.js';
import { normalizeJob } from '../core/schema.js';
import logger from '../core/logger.js';

// ── XML Helpers ─────────────────────────────────────────────────────────────

/**
 * Extract the text content of the first occurrence of a tag.
 * Handles CDATA sections and plain text.
 * @param {string} xml
 * @param {string} tag
 * @returns {string}
 */
function extractTag(xml, tag) {
    const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
    const cdataMatch = xml.match(cdataRe);
    if (cdataMatch) return cdataMatch[1].trim();

    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const match = xml.match(re);
    return match ? match[1].trim() : '';
}

/**
 * Extract all occurrences of a tag.
 * @param {string} xml
 * @param {string} tag
 * @returns {string[]}
 */
function extractAllTags(xml, tag) {
    const results = [];
    const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`, 'gi');
    let m;
    while ((m = re.exec(xml)) !== null) {
        results.push((m[1] || m[2] || '').trim());
    }
    return results;
}

/**
 * Parse RSS 2.0 or Atom XML into raw feed item objects using regex-based parsing.
 * Works reliably across all Cloudflare Workers environments.
 * Handles CDATA, plain text, Atom link attributes, and mixed content.
 * 
 * @param {Response} response - The active fetch Response object.
 * @param {string} feedUrl - Source feed URL (for logging).
 * @returns {Promise<object[]>} Array of raw item objects.
 */
async function parseXml(response, feedUrl) {
    const xml = await response.text();
    const items = [];

    // Match both RSS <item>...</item> and Atom <entry>...</entry>
    const itemRegex = /<(item|entry)[\s>]([\s\S]*?)<\/\1>/gi;
    let itemMatch;

    while ((itemMatch = itemRegex.exec(xml)) !== null) {
        const block = itemMatch[2];
        const currentItem = { categories: [], link: '' };

        // Title
        const title = extractTag(block, 'title');
        if (title) currentItem.title = sanitizeText(title);

        // Link — RSS uses <link>text</link>, Atom uses <link href="..."/>
        const linkText = extractTag(block, 'link');
        if (linkText) {
            currentItem.link = linkText;
        }
        // Also check for Atom-style <link href="...">
        const atomLinkMatch = block.match(/<link[^>]+href\s*=\s*["']([^"']+)["'][^>]*\/?>/i);
        if (atomLinkMatch && !currentItem.link) {
            currentItem.link = atomLinkMatch[1];
        }

        // GUID / ID
        const guid = extractTag(block, 'guid') || extractTag(block, 'id');
        if (guid) currentItem.guid = guid;

        // Date (try multiple tags)
        const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'published') ||
            extractTag(block, 'updated') || extractTag(block, 'dc:date');
        if (pubDate) {
            currentItem.pubDate = pubDate;
            currentItem.isoDate = pubDate;
        }

        // Content / Description (accumulate from multiple fields)
        const description = extractTag(block, 'description');
        const summary = extractTag(block, 'summary');
        const contentEncoded = extractTag(block, 'content:encoded');
        const contentTag = extractTag(block, 'content');
        const contentText = [description, summary, contentEncoded, contentTag]
            .filter(Boolean)
            .join(' ');
        if (contentText) currentItem.content = sanitizeText(contentText);

        // Author
        const author = extractTag(block, 'author') || extractTag(block, 'dc:creator');
        if (author) currentItem.creator = sanitizeText(author);

        // Categories
        const cats = extractAllTags(block, 'category');
        for (const cat of cats) {
            if (cat) currentItem.categories.push(cat);
        }

        // Fallback: use guid as link if link is missing
        if (!currentItem.link && currentItem.guid && currentItem.guid.startsWith('http')) {
            currentItem.link = currentItem.guid;
        }
        if (!currentItem.guid) currentItem.guid = currentItem.link;

        items.push(currentItem);
    }

    return items;
}

// ── Core Fetch Logic ─────────────────────────────────────────────────────────

/** Maximum response body size accepted (2 MB). Prevents OOM on huge feeds. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Request timeout in milliseconds. */
const FETCH_TIMEOUT_MS = 8_000;

/** Rotate through a small set of descriptive user agents. */
const USER_AGENTS = [
    'Mozilla/5.0 (compatible; JobHunterBot/3.1; +https://github.com/job-hunter-bot)',
    'Feedfetcher-Google; (+http://www.google.com/feedfetcher.html)',
    'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0',
];

let _uaIndex = 0;
function nextUserAgent() {
    const ua = USER_AGENTS[_uaIndex % USER_AGENTS.length];
    _uaIndex++;
    return ua;
}

/**
 * Fetch and parse a single RSS/Atom feed with automatic retry + timeout.
 *
 * @param {string} feedUrl
 * @param {number} maxRetries
 * @param {string} sourceName - Human label for logging.
 * @returns {Promise<{ feedUrl: string, sourceName: string, items: RawJob[], error?: string }>}
 */
async function fetchSingleFeed(feedUrl, maxRetries, sourceName) {
    try {
        const rawItems = await retryWithBackoff(async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

            try {
                const res = await fetch(feedUrl, {
                    signal: controller.signal,
                    headers: {
                        'User-Agent': nextUserAgent(),
                        'Accept': 'application/rss+xml, application/rdf+xml;q=0.8, application/atom+xml;q=0.6, application/xml;q=0.4, text/xml;q=0.4',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Cache-Control': 'no-cache',
                    },
                    cf: {
                        cacheTtl: 0,
                    },
                });

                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
                }

                // Guard against oversized responses
                const contentLength = res.headers.get('content-length');
                if (contentLength && parseInt(contentLength) > MAX_RESPONSE_BYTES) {
                    throw new Error(`Feed too large: ${contentLength} bytes (limit ${MAX_RESPONSE_BYTES})`);
                }

                // Parse XML via HTMLRewriter stream synchronously within the timeout window
                return await parseXml(res, feedUrl);
            } finally {
                clearTimeout(timer);
            }
        }, maxRetries);

        // Normalize to canonical RawJob schema
        const meta = { url: feedUrl, name: sourceName, type: 'rss' };
        const items = rawItems.map(raw => normalizeJob(raw, meta));

        return { feedUrl, sourceName, items };
    } catch (err) {
        const msg = err.name === 'AbortError'
            ? `Timeout after ${FETCH_TIMEOUT_MS}ms`
            : err.message;
        logger.warn(`[RSS] Feed failed: ${sourceName || feedUrl} — ${msg}`);
        return { feedUrl, sourceName, items: [], error: msg };
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch all RSS feeds concurrently with concurrency control.
 *
 * @param {Array<{url: string, name: string}>} feedSources
 * @param {object} config
 * @returns {Promise<Array<{ feedUrl: string, sourceName: string, items: RawJob[], error?: string }>>}
 */
export async function fetchRssFeeds(feedSources, config) {
    const limit = pLimit(config.maxConcurrentFeeds ?? 5);

    const promises = feedSources.map(source =>
        limit(() => fetchSingleFeed(source.url, config.maxRetries ?? 3, source.name))
    );

    const results = await Promise.allSettled(promises);

    return results.map((result, i) => {
        if (result.status === 'fulfilled') return result.value;
        const source = feedSources[i];
        return {
            feedUrl: source.url,
            sourceName: source.name,
            items: [],
            error: result.reason?.message || 'Unknown error',
        };
    });
}
