/**
 * @module feeds
 * @description RSS feed fetching with retries, concurrency limiting, and content sanitization.
 */

import Parser from 'rss-parser';
import pLimit from 'p-limit';
import { retryWithBackoff, sanitizeText } from './utils.js';
import logger from './logger.js';

const parser = new Parser({
    customFields: { feed: [], item: [] },
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobHunterBot/2.0; +https://github.com/job-hunter-bot)' },
});

/**
 * @typedef {object} FeedResult
 * @property {string} feedUrl - The URL of the feed.
 * @property {object[]} items - Parsed and sanitized feed items.
 * @property {string} [error] - Error message if the fetch failed.
 */

/**
 * Fetch and parse all RSS feeds concurrently with retry and concurrency control.
 *
 * @param {string[]} feedUrls - Array of RSS feed URLs to fetch.
 * @param {object} config - Configuration object.
 * @param {number} config.maxConcurrentFeeds - Max concurrent feed requests.
 * @param {number} config.maxRetries - Max retry attempts per feed.
 * @returns {Promise<FeedResult[]>} Array of feed results (fulfilled or with error).
 */
export async function fetchAllFeeds(feedUrls, config) {
    const limit = pLimit(config.maxConcurrentFeeds);

    // Warn about non-HTTPS feeds
    for (const url of feedUrls) {
        if (url.startsWith('http://')) {
            logger.warn(`Feed URL uses HTTP (insecure): ${url}`);
        }
    }

    const promises = feedUrls.map((feedUrl) =>
        limit(() => fetchSingleFeed(feedUrl, config.maxRetries))
    );

    const results = await Promise.allSettled(promises);

    return results.map((result, index) => {
        const feedUrl = feedUrls[index];
        if (result.status === 'fulfilled') {
            return result.value;
        }
        return { feedUrl, items: [], error: result.reason?.message || 'Unknown error' };
    });
}

/**
 * Fetch and parse a single RSS feed with retry.
 *
 * @param {string} feedUrl - The RSS feed URL.
 * @param {number} maxRetries - Max retry attempts.
 * @returns {Promise<FeedResult>} Parsed feed result.
 */
async function fetchSingleFeed(feedUrl, maxRetries) {
    try {
        const feed = await retryWithBackoff(
            () => parser.parseURL(feedUrl),
            maxRetries
        );

        // Sanitize item content
        const items = (feed.items || []).map((item) => ({
            ...item,
            title: sanitizeText(item.title),
            content: sanitizeText(item.content),
            contentSnippet: sanitizeText(item.contentSnippet),
            // Preserve original fields needed for processing
            guid: item.guid,
            link: item.link,
            pubDate: item.pubDate,
            isoDate: item.isoDate,
            categories: item.categories || [],
            creator: item.creator || item['dc:creator'] || '',
        }));

        logger.info(`Fetched ${items.length} items from ${feedUrl}`);
        return { feedUrl, items };
    } catch (err) {
        logger.error(`Failed to fetch feed "${feedUrl}" after retries: ${err.message}`);
        return { feedUrl, items: [], error: err.message };
    }
}
