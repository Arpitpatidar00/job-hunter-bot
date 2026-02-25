/**
 * @module relevance
 * @description Job relevance matching — exact, fuzzy (string-similarity), and regex keyword support.
 */

import { compareTwoStrings } from 'string-similarity';
import { sanitizeText, parseDate, escapeRegex } from './utils.js';

/**
 * Check if a job item matches the user's profile keywords and location keywords.
 * Uses a three-tier matching strategy: exact → fuzzy → regex.
 *
 * @param {object} item - RSS feed item with title, content/contentSnippet.
 * @param {object} config - Configuration object.
 * @param {string[]} config.profileKeywords - Skill keywords to match.
 * @param {string[]} config.locationKeywords - Location keywords (e.g. "remote").
 * @param {number} config.fuzzyThreshold - Minimum similarity score (0–1) for fuzzy matching.
 * @param {string[]} [config.regexKeywords] - Optional regex patterns for matching.
 * @returns {boolean} True if the job is relevant.
 */
export function isJobRelevant(item, config) {
    const rawText = `${item.title || ''} ${item.content || item.contentSnippet || ''}`;
    const text = sanitizeText(rawText).toLowerCase();

    // --- Location check (must match at least one) ---
    const matchesLocation = config.locationKeywords.some((kw) =>
        text.includes(kw.toLowerCase())
    );
    if (!matchesLocation) return false;

    // --- Profile keyword check (any one match suffices) ---
    const profileMatched = config.profileKeywords.some((keyword) => {
        const kw = keyword.toLowerCase();

        // 1. Exact (word-boundary) match — avoids "rest" matching "restructure" etc.
        const exactRegex = new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i');
        if (exactRegex.test(text)) return true;

        // 2. Fuzzy match — compare keyword against text tokens (words)
        const tokens = text.split(/\s+/);
        for (const token of tokens) {
            if (compareTwoStrings(kw, token) >= config.fuzzyThreshold) return true;
        }

        // For multi-word keywords, also compare against sliding windows of tokens
        const kwWords = kw.split(/\s+/);
        if (kwWords.length > 1) {
            for (let i = 0; i <= tokens.length - kwWords.length; i++) {
                const window = tokens.slice(i, i + kwWords.length).join(' ');
                if (compareTwoStrings(kw, window) >= config.fuzzyThreshold) return true;
            }
        }

        return false;
    });

    if (profileMatched) return true;

    // 3. Regex match (optional)
    if (config.regexKeywords && config.regexKeywords.length > 0) {
        return config.regexKeywords.some((pattern) => {
            try {
                const regex = new RegExp(pattern, 'i');
                return regex.test(text);
            } catch {
                return false;
            }
        });
    }

    return false;
}

/**
 * Check if a job was posted within the configured time window.
 *
 * @param {object} item - RSS feed item with pubDate.
 * @param {number} timeWindowHours - Number of hours to consider a job "new".
 * @returns {boolean} True if the job was posted within the time window.
 */
export function isNewJob(item, timeWindowHours) {
    const dateStr = item.pubDate || item.isoDate;
    if (!dateStr) return false;

    const postedDate = parseDate(dateStr);
    if (!postedDate) return false;

    const now = Date.now();
    const windowMs = timeWindowHours * 60 * 60 * 1000;
    return (now - postedDate.getTime()) <= windowMs;
}
