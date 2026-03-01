/**
 * @module utils
 * @description Shared helper functions — retry logic, date parsing, text sanitization,
 * and NLP feature extraction utilities.
 * Zero external dependencies — all functionality inlined for Cloudflare Workers compatibility.
 */

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

    // Try native Date constructor (handles ISO 8601 and RFC 2822 which are the RSS formats)
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d;

    console.warn(`[WARN] Could not parse date: "${dateStr}"`);
    return null;
}

/**
 * Strip HTML tags from text. Lightweight replacement for sanitize-html.
 * @param {string} html - Raw HTML/text to sanitize.
 * @returns {string} Clean plain text.
 */
export function sanitizeText(html) {
    if (!html) return '';
    return html
        .replace(/<[^>]*>/g, ' ')        // Remove HTML tags
        .replace(/&nbsp;/gi, ' ')         // Replace &nbsp;
        .replace(/&amp;/gi, '&')          // Decode &amp;
        .replace(/&lt;/gi, '<')           // Decode &lt;
        .replace(/&gt;/gi, '>')           // Decode &gt;
        .replace(/&quot;/gi, '"')         // Decode &quot;
        .replace(/&#39;/gi, "'")          // Decode &#39;
        .replace(/\s+/g, ' ')            // Collapse whitespace
        .trim();
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
 * Compare two strings and return a similarity score between 0 and 1.
 * Uses Dice's coefficient (bigram comparison) — equivalent to string-similarity's compareTwoStrings.
 * @param {string} a
 * @param {string} b
 * @returns {number} Similarity score between 0 and 1.
 */
export function compareTwoStrings(a, b) {
    a = a.toLowerCase().replace(/\s+/g, '');
    b = b.toLowerCase().replace(/\s+/g, '');

    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;

    const bigramsA = new Map();
    for (let i = 0; i < a.length - 1; i++) {
        const bigram = a.substring(i, i + 2);
        bigramsA.set(bigram, (bigramsA.get(bigram) || 0) + 1);
    }

    let intersectionSize = 0;
    for (let i = 0; i < b.length - 1; i++) {
        const bigram = b.substring(i, i + 2);
        const count = bigramsA.get(bigram) || 0;
        if (count > 0) {
            bigramsA.set(bigram, count - 1);
            intersectionSize++;
        }
    }

    return (2.0 * intersectionSize) / (a.length - 1 + b.length - 1);
}

/**
 * Limit concurrency of async operations.
 * Lightweight replacement for p-limit.
 * @param {number} concurrency - Maximum concurrent operations.
 * @returns {function} Limiter function that wraps async functions.
 */
export function pLimit(concurrency) {
    let activeCount = 0;
    const queue = [];

    function next() {
        if (queue.length > 0 && activeCount < concurrency) {
            activeCount++;
            const { fn, resolve, reject } = queue.shift();
            fn().then(resolve, reject).finally(() => {
                activeCount--;
                next();
            });
        }
    }

    return function limit(fn) {
        return new Promise((resolve, reject) => {
            queue.push({ fn, resolve, reject });
            next();
        });
    };
}

/**
 * Parse experience years from a job description string.
 * Handles patterns like: "2+ years", "3-5 years", "minimum 2 years", "at least 4 years".
 * @param {string} text - Raw job description text (lowercase).
 * @returns {{ min: number, max: number } | null} Min/max years or null if not found.
 */
export function parseExperienceYears(text) {
    if (!text) return null;

    // Patterns: "2-5 years", "2 to 5 years", "2–5 years"
    const rangeMatch = text.match(/([1-9]\d?)\s*(?:[-–to]+)\s*([1-9]\d?)\s+years?/i);
    if (rangeMatch) {
        return { min: parseInt(rangeMatch[1]), max: parseInt(rangeMatch[2]) };
    }

    // Patterns: "2+ years", "at least 3 years", "minimum 2 years", "2 years"
    const singleMatch = text.match(/(?:at\s+least\s+|minimum\s+|min\.?\s+)?([1-9]\d?)\+?\s+years?/i);
    if (singleMatch) {
        const min = parseInt(singleMatch[1]);
        return { min, max: null };
    }

    return null;
}

/**
 * Extract and normalize a salary to a USD integer estimate.
 * Handles: "$80k", "$80,000", "€70k", "INR 15 LPA", "25 LPA", "80k-100k".
 * @param {string} text - Raw text.
 * @returns {{ min: number, max: number, currency: string } | null}
 */
export function extractSalaryUSD(text) {
    if (!text) return null;

    // INR LPA (Lakhs Per Annum) → USD (approx 1 LPA = ~1200 USD)
    const lpaMatch = text.match(/([\d.]+)\s*[-–to]*\s*([\d.]+)?\s*(?:lpa|lakhs?\s+per\s+annum)/i);
    if (lpaMatch) {
        const min = Math.round(parseFloat(lpaMatch[1]) * 1200);
        const max = lpaMatch[2] ? Math.round(parseFloat(lpaMatch[2]) * 1200) : min;
        return { min, max, currency: 'INR' };
    }

    // USD/EUR/GBP patterns: $80k, $80,000, €70k-90k
    const currencyMap = { '$': 1, '€': 1.08, '£': 1.27 };
    const rangeMatch = text.match(/([\$€£]?)\s*([\d,]+(?:\.\d+)?)(k?)\s*[-–to]+\s*[\$€£]?\s*([\d,]+(?:\.\d+)?)(k?)\s*(?:usd|eur|gbp|per\s+year|\/yr|p\.?a\.?|annually)?/i);
    if (rangeMatch) {
        const sym = rangeMatch[1] || '$';
        const rate = currencyMap[sym] || 1;
        const rawMin = parseFloat(rangeMatch[2].replace(/,/g, '')) * (rangeMatch[3] ? 1000 : 1);
        const rawMax = parseFloat(rangeMatch[4].replace(/,/g, '')) * (rangeMatch[5] ? 1000 : 1);
        // Sanity check: yearly salary
        if (rawMin >= 100 && rawMax >= rawMin) {
            const adjust = rawMin < 1000 ? 1000 : 1; // treat sub-1000 as monthly
            return { min: Math.round(rawMin * rate * adjust), max: Math.round(rawMax * rate * adjust), currency: sym };
        }
    }

    return null;
}

/**
 * Detect the work arrangement from job text.
 * @param {string} text - Lowercase job text.
 * @returns {'remote' | 'hybrid' | 'onsite' | 'unknown'}
 */
export function detectRemoteType(text) {
    if (!text) return 'unknown';
    const t = text.toLowerCase();

    // Hybrid signals
    if (/\bhybrid\b|\bhybrid-remote\b|\b\d+\s+days?\s+(?:in|from)\s+office\b/.test(t)) return 'hybrid';

    // Remote signals
    if (/\bfully\s+remote\b|\b100%\s+remote\b|\bremote[-\s]?first\b|\bwork\s+from\s+(?:home|anywhere)\b|\bwfh\b|\bdistributed\b/.test(t)) return 'remote';
    if (/\bremote\b/.test(t) && !/\bno\s+remote\b|\bremote\s+not\b/.test(t)) return 'remote';

    // Onsite signals
    if (/\bon[-\s]?site\b|\bin[-\s]?office\b|\bin[-\s]?person\b|\bno\s+remote\b/.test(t)) return 'onsite';

    return 'unknown';
}
