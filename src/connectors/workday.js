/**
 * @module connectors/workday
 * @description Workday ATS connector.
 * Fetches jobs from the public Workday job search API and normalizes them.
 *
 * API: POST https://{company}.wd5.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs
 * Workday uses numbered cloud instances (wd1-wd5).
 */

import { fetchWithTimeout, rateLimitDomain, applySourceLimit, loadAtsCursor, saveAtsCursor, filterByAtsCursor } from './base.js';
import { normalizeJob } from '../core/schema.js';
import { sanitizeText, pLimit } from '../core/utils.js';
import logger from '../core/logger.js';

const CONCURRENCY = 3;

/** Workday cloud instances to try when probing. */
const WD_INSTANCES = ['wd1', 'wd3', 'wd5'];

/**
 * Extract company slug and site from a Workday URL or plain string.
 * URL forms:
 *   - https://{company}.wd5.myworkdayjobs.com/en-US/{site}
 *   - https://{company}.wd1.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs
 *   - Plain slug (assumes External_Career_Site)
 */
function parseWorkdayUrl(urlOrSlug) {
    try {
        const url = new URL(urlOrSlug);
        const hostname = url.hostname;
        // Extract company from hostname: {company}.wd5.myworkdayjobs.com
        const hostMatch = hostname.match(/^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
        if (hostMatch) {
            const company = hostMatch[1];
            const instance = hostMatch[2];
            const parts = url.pathname.split('/').filter(Boolean);
            // Try to find site in path: /wday/cxs/{company}/{site}/jobs or /en-US/{site}
            const cxsIdx = parts.indexOf('cxs');
            let site = 'External_Career_Site';
            if (cxsIdx >= 0 && parts[cxsIdx + 2]) {
                site = parts[cxsIdx + 2];
            } else if (parts.length >= 2 && parts[0].match(/^[a-z]{2}(-[A-Z]{2})?$/)) {
                site = parts[1];
            } else if (parts.length >= 1 && !parts[0].match(/^(wday|en-US)$/i)) {
                site = parts[0];
            }
            return { company, instance, site };
        }
    } catch {
        // Plain slug
    }
    return { company: urlOrSlug, instance: 'wd5', site: 'External_Career_Site' };
}

/**
 * Build the Workday CXS API URL.
 */
function buildApiUrl(company, instance, site) {
    return `https://${company}.${instance}.myworkdayjobs.com/wday/cxs/${company}/${site}/jobs`;
}

/**
 * Normalize a Workday job into a RawJob.
 */
function normalizeWorkdayJob(wdJob, source, company, instance, site) {
    const categories = [];
    if (wdJob.locationsText) categories.push(wdJob.locationsText);
    if (wdJob.postedOn) categories.push(wdJob.postedOn);
    if (wdJob.bulletFields) {
        for (const field of wdJob.bulletFields) {
            if (field) categories.push(field);
        }
    }

    const externalPath = wdJob.externalPath || '';
    const link = externalPath
        ? `https://${company}.${instance}.myworkdayjobs.com/en-US/${site}${externalPath}`
        : '';

    return normalizeJob({
        id: `wd-${wdJob.bulletFields?.[0] || ''}-${wdJob.title?.slice(0, 30) || Math.random().toString(36).slice(2, 8)}`,
        title: wdJob.title || '',
        content: sanitizeText(wdJob.descriptionPlainText || wdJob.title || ''),
        link,
        pubDate: wdJob.postedOn || '',
        isoDate: wdJob.postedOn || '',
        categories,
        company: source.name || company || '',
    }, {
        url: source.url,
        name: source.name || 'Workday',
        type: 'workday',
    });
}

/**
 * Fetch jobs from a single Workday company board.
 */
async function fetchSingleBoard(source, config, kv) {
    const { company, instance, site } = parseWorkdayUrl(source.url);
    const apiUrl = buildApiUrl(company, instance, site);

    try {
        await rateLimitDomain(apiUrl);
        const res = await fetchWithTimeout(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({
                appliedFacets: {},
                limit: 20,
                offset: 0,
                searchText: '',
            }),
        }, 10000, 1);

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const data = await res.json();
        const jobPostings = data.jobPostings || [];
        const slug = company;

        const allItems = applySourceLimit(
            jobPostings.map(j => normalizeWorkdayJob(j, source, company, instance, site))
        );

        const cursorIds = await loadAtsCursor(kv, 'workday', slug);
        const { newItems, cursorSkipped } = filterByAtsCursor(allItems, cursorIds);

        if (newItems.length > 0) {
            const allIds = allItems.map(i => i.id);
            await saveAtsCursor(kv, 'workday', slug, allIds);
        }

        return {
            feedUrl: source.url,
            sourceName: source.name || company,
            items: newItems,
            cursorSkipped,
        };
    } catch (err) {
        return {
            feedUrl: source.url,
            sourceName: source.name || company,
            items: [],
            error: err.message,
        };
    }
}

/**
 * Fetch jobs from multiple Workday sources.
 */
export async function fetchWorkdayJobs(sources, config, kv) {
    const limit = pLimit(CONCURRENCY);
    return Promise.all(sources.map(s => limit(() => fetchSingleBoard(s, config, kv))));
}
