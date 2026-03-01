/**
 * @module connectors/base
 * @description Shared connector utilities — fetch with timeout, rate limiting,
 * source validation, and consistent stat building.
 *
 * Every connector imports from this module to ensure consistent behavior
 * across RSS, Greenhouse, Lever, Ashby, Workable, etc.
 */

import logger from '../core/logger.js';

// ── Fetch with Timeout ───────────────────────────────────────────────────────

/** Default request timeout in ms. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Fetch a URL with an automatic AbortController timeout.
 *
 * @param {string} url
 * @param {RequestInit} [options={}]
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: {
                'User-Agent': 'JobHunterBot/5.1 (+https://github.com/job-hunter-bot)',
                'Accept': 'application/json',
                ...options.headers,
            },
        });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

// ── Rate Limiting per Domain ─────────────────────────────────────────────────

/** In-memory tracker for per-domain request timestamps. */
const _domainTimestamps = new Map();

/** Minimum ms between requests to the same domain (default: 2s). */
const MIN_DOMAIN_INTERVAL_MS = 2000;

/**
 * Wait if needed to respect the per-domain rate limit.
 * Call this before every outbound fetch to an external API.
 *
 * @param {string} url - The URL being fetched (domain extracted automatically).
 * @param {number} [minIntervalMs=2000]
 */
export async function rateLimitDomain(url, minIntervalMs = MIN_DOMAIN_INTERVAL_MS) {
    let domain;
    try {
        domain = new URL(url).hostname;
    } catch {
        return; // invalid URL, skip rate limiting
    }

    const lastTs = _domainTimestamps.get(domain) || 0;
    const elapsed = Date.now() - lastTs;

    if (elapsed < minIntervalMs) {
        const waitMs = minIntervalMs - elapsed;
        await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    _domainTimestamps.set(domain, Date.now());
}

// ── Source Validation ────────────────────────────────────────────────────────

/**
 * Filter and validate sources for a specific connector type.
 *
 * @param {object[]} sources - All sources from config.
 * @param {string} type - The connector type to filter for (e.g., 'greenhouse').
 * @returns {object[]} Valid, enabled sources for this type.
 */
export function validateConnectorSources(sources, type) {
    return (sources || []).filter(s => {
        if (s.type !== type) return false;
        if (s.enabled === false) return false;
        if (!s.url) {
            logger.warn(`[${type}] Source missing URL, skipping: ${s.name || 'unnamed'}`);
            return false;
        }
        return true;
    });
}

// ── Stat Builder ─────────────────────────────────────────────────────────────

/**
 * Build a consistent feedStats entry for observability.
 *
 * @param {object} source - Source config object `{ type, url, name }`.
 * @param {object[]} items - Normalized RawJob items.
 * @param {string|null} error - Error message or null on success.
 * @param {number} durationMs - Time taken in ms.
 * @returns {object}
 */
export function buildFeedStat(source, items, error, durationMs) {
    return {
        type: source.type,
        url: source.url,
        name: source.name || 'Unknown',
        count: items.length,
        durationMs,
        success: !error,
        error: error || null,
    };
}

// ── Source List Builder ──────────────────────────────────────────────────────

/**
 * Merge `config.feeds` (legacy RSS strings/objects) with `config.sources`
 * (new multi-type array) into a single unified source list.
 *
 * @param {object} config - Full bot config.
 * @returns {object[]} Unified source list with `{ type, url, name, enabled }`.
 */
export function buildSourceList(config) {
    const sources = [];
    const seenUrls = new Set();

    // 1. Convert legacy feeds[] to source objects
    for (const entry of (config.feeds || [])) {
        const url = typeof entry === 'string' ? entry : entry.url;
        const name = typeof entry === 'string' ? hostnameLabel(url) : (entry.name || hostnameLabel(url));
        if (url && !seenUrls.has(url)) {
            seenUrls.add(url);
            sources.push({ type: 'rss', url, name, enabled: true });
        }
    }

    // 2. Merge explicit sources[] (new format)
    for (const s of (config.sources || [])) {
        if (s.url && !seenUrls.has(s.url)) {
            seenUrls.add(s.url);
            sources.push({
                type: s.type || 'rss',
                url: s.url,
                name: s.name || hostnameLabel(s.url),
                enabled: s.enabled !== false,
                metadata: s.metadata || {},
            });
        }
    }

    return sources.filter(s => s.enabled !== false);
}

/**
 * Group sources by connector type.
 *
 * @param {object[]} sources
 * @returns {Map<string, object[]>}
 */
export function groupByType(sources) {
    const groups = new Map();
    for (const s of sources) {
        const type = s.type || 'rss';
        if (!groups.has(type)) groups.set(type, []);
        groups.get(type).push(s);
    }
    return groups;
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Derive a human-readable label from a URL hostname.
 * @param {string} url
 * @returns {string}
 */
function hostnameLabel(url) {
    try {
        const { hostname } = new URL(url);
        return hostname.replace(/^www\./, '').split('.')[0];
    } catch {
        return url;
    }
}
