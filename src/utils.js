/**
 * @module utils
 * @description Shared helper functions — retry logic, date parsing, text sanitization, interval parsing.
 */

import { parseISO, isValid } from 'date-fns';
import sanitizeHtml from 'sanitize-html';
import logger from './logger.js';

/**
 * Retry a function with exponential backoff.
 * @param {Function} fn - Async function to retry.
 * @param {number} [maxRetries=3] - Maximum number of attempts.
 * @param {number} [baseDelay=1000] - Base delay in ms (doubles each retry).
 * @returns {Promise<*>} Result of the function.
 * @throws {Error} If all retries are exhausted.
 */
export async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt - 1);
                logger.warn(`Attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms...`, {
                    error: err.message,
                });
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

/**
 * Robustly parse a date string. Tries ISO 8601 first, then falls back to native Date.
 * @param {string} dateStr - Date string to parse.
 * @returns {Date|null} Parsed Date or null if invalid.
 */
export function parseDate(dateStr) {
    if (!dateStr) return null;

    // Try ISO 8601 first
    const iso = parseISO(dateStr);
    if (isValid(iso)) return iso;

    // Fallback to native Date constructor
    const native = new Date(dateStr);
    if (isValid(native)) return native;

    logger.warn(`Could not parse date: "${dateStr}"`);
    return null;
}

/**
 * Strip HTML tags and dangerous content from text.
 * @param {string} html - Raw HTML/text to sanitize.
 * @returns {string} Clean plain text.
 */
export function sanitizeText(html) {
    if (!html) return '';
    return sanitizeHtml(html, {
        allowedTags: [],
        allowedAttributes: {},
    }).trim();
}

/**
 * Escape a string for safe use in a RegExp.
 * @param {string} str - String to escape.
 * @returns {string} Escaped string.
 */
export function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a human-readable interval string into milliseconds.
 * Supported formats: "30m", "1h", "15m", "2h30m", plain number (treated as ms).
 * @param {string|number} input - Interval string or number.
 * @returns {number} Interval in milliseconds.
 * @throws {Error} If the input format is invalid.
 */
export function parseInterval(input) {
    if (typeof input === 'number') return input;
    if (typeof input !== 'string') throw new Error(`Invalid interval: ${input}`);

    const str = input.trim().toLowerCase();

    // Plain number string → treat as ms
    if (/^\d+$/.test(str)) return parseInt(str, 10);

    let totalMs = 0;
    const hourMatch = str.match(/(\d+)\s*h/);
    const minMatch = str.match(/(\d+)\s*m/);

    if (hourMatch) totalMs += parseInt(hourMatch[1], 10) * 60 * 60 * 1000;
    if (minMatch) totalMs += parseInt(minMatch[1], 10) * 60 * 1000;

    if (totalMs === 0) throw new Error(`Invalid interval format: "${input}". Use e.g. "30m", "1h", "2h30m".`);

    return totalMs;
}
