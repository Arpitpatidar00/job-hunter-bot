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
 * Parse RSS 2.0 or Atom XML into raw feed item objects using Cloudflare's HTMLRewriter.
 * This provides streaming parsing, preventing memory exhaustion on huge XML payloads.
 * 
 * @param {Response} response - The active fetch Response object.
 * @param {string} feedUrl - Source feed URL (for logging).
 * @returns {Promise<object[]>} Array of raw item objects.
 */
async function parseXml(response, feedUrl) {
    const items = [];
    let currentItem = null;
    let currentTag = null;
    let textBuffer = '';

    // We sniff the first few bytes lightly to detect atom vs rss, but HTMLRewriter Handles both gracefully 
    // if we just listen to <entry> and <item>.

    const rewriter = new HTMLRewriter()
        .on('item, entry', {
            element(el) {
                currentItem = { categories: [], link: '' };
            }
        })
        .on('item > *, entry > *', {
            element(el) {
                currentTag = el.tagName.toLowerCase();
                textBuffer = '';

                // Atom links use attributes: <link href="...">
                if (currentTag === 'link' && currentItem) {
                    const href = el.getAttribute('href');
                    if (href) currentItem.link = href;
                }
            },
            text(chunk) {
                if (currentItem && currentTag) {
                    textBuffer += chunk.text;
                }
            }
        })
        .on('item > *, entry > *', {
            // Fired when the closing tag is reached
            element(el) {
                if (!currentItem || !currentTag) return;

                const content = textBuffer.trim();

                // Map XML tags to our schema
                if (currentTag === 'title') currentItem.title = sanitizeText(content);
                else if (currentTag === 'link' && !currentItem.link) currentItem.link = content;
                else if (currentTag === 'guid' || currentTag === 'id') currentItem.guid = content;
                else if (currentTag === 'pubdate' || currentTag === 'published' || currentTag === 'updated' || currentTag === 'dc:date') {
                    currentItem.pubDate = content;
                    currentItem.isoDate = content;
                }
                else if (currentTag === 'description' || currentTag === 'summary' || currentTag === 'content:encoded' || currentTag === 'content') {
                    // Accumulate content if multiple fields exist
                    currentItem.content = sanitizeText((currentItem.content || '') + ' ' + content);
                }
                else if (currentTag === 'author' || currentTag === 'dc:creator') currentItem.creator = sanitizeText(content);
                else if (currentTag === 'category') currentItem.categories.push(content);

                currentTag = null;
                textBuffer = '';
            }
        })
        .on('item, entry', {
            element(el) {
                if (currentItem) {
                    // Fallback link to guid if missing
                    if (!currentItem.link && currentItem.guid && currentItem.guid.startsWith('http')) {
                        currentItem.link = currentItem.guid;
                    }
                    if (!currentItem.guid) currentItem.guid = currentItem.link;
                    items.push(currentItem);
                    currentItem = null;
                }
            }
        });

    // We pass a cloned response through the rewriter and exhaust the stream
    const resStream = rewriter.transform(response);
    await resStream.arrayBuffer(); // This forces the stream chunks through the rewriter hooks

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
    const limit = pLimit(config.maxConcurrentFeeds ?? 7);

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
