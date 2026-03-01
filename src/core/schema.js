/**
 * @module schema
 * @description Canonical `RawJob` schema and normalization utilities.
 * Every source connector MUST return jobs conforming to this shape before
 * they enter the scoring pipeline.
 */

/**
 * @typedef {object} RawJob
 * @property {string}   id             - Unique identifier (guid, url, or content hash).
 * @property {string}   title          - Job title (sanitized, no HTML).
 * @property {string}   company        - Company name (normalized).
 * @property {string}   link           - Application / detail URL.
 * @property {string}   content        - Full job description text (sanitized).
 * @property {string}   contentSnippet - First 500 chars of content.
 * @property {string}   pubDate        - Raw published date string from source.
 * @property {string}   isoDate        - ISO-8601 date string (best effort).
 * @property {string[]} categories     - Tags / categories from the source.
 * @property {string}   sourceUrl      - The feed/connector URL this came from.
 * @property {string}   sourceName     - Human-readable source name (e.g. "WeWorkRemotely").
 * @property {string}   sourceType     - Connector type: "rss" | "api" | "email" | "scraper".
 */

/**
 * Normalize raw company name.
 * Strips common legal suffixes, extra whitespace, trailing punctuation.
 * @param {string} company
 * @returns {string}
 */
export function normalizeCompany(company) {
    if (!company) return '';
    return company
        // Only strip legal suffixes at the END of the string (with optional trailing punctuation)
        .replace(/\s*\b(inc\.?|ltd\.?|llc\.?|corp\.?|gmbh|s\.?a\.?|b\.?v\.?)\s*[,.|]*\s*$/gi, '')
        .replace(/[,.|]+$/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Normalize a job title.
 * Strips emojis, removes parenthetical noise like "(m/w/d)", "(remote)", "(all levels)",
 * normalizes case, and trims whitespace.
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
    if (!title) return '';
    return title
        // Remove emojis
        .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
        // Remove parenthetical noise
        .replace(/\s*\((?:m\/w\/d|remote|all\s+levels?|anywhere|f\/m\/d|all\s+genders?)\)/gi, '')
        // Remove bracketed suffixes like [remote], [contract]
        .replace(/\s*\[(?:remote|contract|full[- ]?time|part[- ]?time)\]/gi, '')
        // Collapse whitespace
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Produce a canonical deduplication key for a job.
 * Used alongside the URL-based key to catch cross-platform duplicates.
 * @param {string} title
 * @param {string} company
 * @returns {string} Normalized string suitable for hashing.
 */
export function jobDedupeKey(title, company) {
    const t = normalizeTitle(title).toLowerCase().replace(/\s+/g, ' ');
    const c = normalizeCompany(company).toLowerCase().replace(/\s+/g, ' ');
    return `${c}::${t}`;
}

/**
 * Synchronous FNV-1a hash for generating content_hash without async crypto.
 * Used in normalizeJob to guarantee every RawJob has a content_hash field.
 * @param {string} input
 * @returns {string} 8-char hex hash.
 */
function fnvHash(input) {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/**
 * Produce a normalized `RawJob` from any connector output.
 * Guarantees every field exists (never undefined/null).
 *
 * @param {Partial<RawJob>} raw - Raw job data from a connector.
 * @param {object} sourceMeta - Connector metadata.
 * @param {string} sourceMeta.url - Feed/source URL.
 * @param {string} sourceMeta.name - Human-readable source name.
 * @param {string} sourceMeta.type - Connector type.
 * @returns {RawJob}
 */
export function normalizeJob(raw, sourceMeta = {}) {
    const title = normalizeTitle(raw.title || '');
    const company = normalizeCompany(raw.company || raw.creator || '');
    const link = raw.link || raw.url || '';
    const content = raw.content || raw.description || '';
    const snippet = content.slice(0, 500);
    const guid = raw.guid || raw.id || link || '';
    const dedupeStr = jobDedupeKey(title, company);
    const urlPath = link.replace(/\?.*$/, '').replace(/#.*$/, ''); // strip query/fragment
    const content_hash = fnvHash(dedupeStr + '::' + urlPath);

    return {
        id: guid,
        url: link,
        content_hash,
        title,
        company,
        link,
        content,
        contentSnippet: snippet,
        pubDate: raw.pubDate || raw.date || '',
        isoDate: raw.isoDate || raw.pubDate || raw.date || '',
        categories: Array.isArray(raw.categories) ? raw.categories : [],
        sourceUrl: sourceMeta.url || '',
        sourceName: sourceMeta.name || 'Unknown',
        sourceType: sourceMeta.type || 'rss',
    };
}
