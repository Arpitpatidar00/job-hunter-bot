/**
 * @module discovery/financialSignals
 * @description Financial signals discovery vector.
 * Monitors funding announcements, SEC filings, IPO/acquisition news,
 * and hiring surge indicators to discover companies that are actively
 * growing and likely to have open positions.
 *
 * Sub-vectors:
 *   1. Funding Round RSS — TechCrunch, Crunchbase, Sifted funding feeds
 *   2. SEC EDGAR Filings — S-1/IPO filings and 8-K hiring disclosures
 *   3. Acquisition Alerts — M&A news for post-merger hiring ramps
 *   4. Hiring Surge Signals — Press releases mentioning headcount growth
 */

import { fetchWithTimeout } from '../connectors/base.js';
import { registerDiscoveredSource } from '../db/index.js';
import { registerDomain } from './careerDetector.js';
import { detectAtsSources } from './sourceDiscovery.js';
import logger from '../core/logger.js';

// ── Funding Round RSS Feeds ─────────────────────────────────────────────────

const FUNDING_RSS_FEEDS = [
    { name: 'TechCrunch Fundraises', url: 'https://techcrunch.com/category/fundraise/feed/' },
    { name: 'Crunchbase Daily', url: 'https://news.crunchbase.com/feed/' },
    { name: 'Sifted EU Funding', url: 'https://sifted.eu/feed' },
    { name: 'VentureBeat', url: 'https://venturebeat.com/category/money/feed/' },
    { name: 'PitchBook News', url: 'https://pitchbook.com/news/rss' },
];

/**
 * Funding keywords that indicate active hiring.
 * Companies that just raised are almost always hiring.
 */
const FUNDING_KEYWORDS = [
    'series a', 'series b', 'series c', 'series d',
    'seed round', 'funding', 'raised', 'million',
    'growth round', 'expansion', 'capital',
];

const HIRING_SIGNAL_KEYWORDS = [
    'hiring', 'headcount', 'new hires', 'recruiting',
    'talent', 'team growth', 'workforce expansion',
    'open positions', 'job openings',
];

// ── SEC EDGAR Patterns ──────────────────────────────────────────────────────

/**
 * SEC EDGAR full-text search for recent S-1/IPO filings.
 * Companies filing S-1 are about to IPO — massive hiring ramps follow.
 */
const SEC_EFTS_URL = 'https://efts.sec.gov/LATEST/search-index?q=%22hiring%22+OR+%22headcount%22&dateRange=custom&startdt=STARTDATE&enddt=ENDDATE&forms=S-1,8-K,10-K';

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Run the financial signals discovery vector.
 *
 * @param {D1Database} db
 * @param {Set<string>} knownUrls - Already registered source URLs
 * @param {KVNamespace} [kv] - KV for state tracking
 * @param {object} [options]
 * @returns {Promise<{ newDomains: number, newSources: number, signalsDetected: number }>}
 */
export async function runFinancialSignals(db, knownUrls, kv, options = {}) {
    let newDomains = 0;
    let newSources = 0;
    let signalsDetected = 0;

    // Sub-vector 1: Funding round RSS feeds
    try {
        const fundingResult = await scanFundingFeeds(db, knownUrls, kv);
        newDomains += fundingResult.domains;
        newSources += fundingResult.sources;
        signalsDetected += fundingResult.signals;
    } catch (err) {
        logger.error(`[FinancialSignals] Funding feeds failed: ${err.message}`);
    }

    // Sub-vector 2: SEC EDGAR filings
    try {
        const secResult = await scanSecFilings(db, knownUrls, kv);
        newDomains += secResult.domains;
        newSources += secResult.sources;
        signalsDetected += secResult.signals;
    } catch (err) {
        logger.error(`[FinancialSignals] SEC filings failed: ${err.message}`);
    }

    // Sub-vector 3: Acquisition / M&A signals
    try {
        const maResult = await scanAcquisitionNews(db, knownUrls, kv);
        newDomains += maResult.domains;
        newSources += maResult.sources;
        signalsDetected += maResult.signals;
    } catch (err) {
        logger.error(`[FinancialSignals] M&A scan failed: ${err.message}`);
    }

    // Sub-vector 4: Press releases with hiring surge language
    try {
        const surgeResult = await scanHiringSurgePress(db, knownUrls, kv);
        newDomains += surgeResult.domains;
        newSources += surgeResult.sources;
        signalsDetected += surgeResult.signals;
    } catch (err) {
        logger.error(`[FinancialSignals] Hiring surge scan failed: ${err.message}`);
    }

    logger.info(
        `[FinancialSignals] Complete: ${signalsDetected} signals, ${newDomains} domains, ${newSources} sources`
    );

    return { newDomains, newSources, signalsDetected };
}

// ── Sub-vector 1: Funding Round RSS ─────────────────────────────────────────

/**
 * Scan funding round RSS feeds for company domains.
 */
async function scanFundingFeeds(db, knownUrls, kv) {
    let domains = 0, sources = 0, signals = 0;

    // Round-robin: pick 2 feeds per cycle to stay within rate limits
    const offset = kv
        ? parseInt(await kv.get('financial:funding_offset') || '0', 10)
        : 0;
    const selected = [];
    for (let i = 0; i < 2 && i < FUNDING_RSS_FEEDS.length; i++) {
        selected.push(FUNDING_RSS_FEEDS[(offset + i) % FUNDING_RSS_FEEDS.length]);
    }

    if (kv) {
        try {
            await kv.put('financial:funding_offset',
                String((offset + 2) % FUNDING_RSS_FEEDS.length),
                { expirationTtl: 86400 * 30 }
            );
        } catch { /* non-critical */ }
    }

    for (const feed of selected) {
        try {
            const res = await fetchWithTimeout(feed.url, {
                headers: { 'User-Agent': 'JobHunterBot/5.2', Accept: 'application/rss+xml, application/xml, text/xml' },
            }, 10_000);

            if (!res.ok) continue;
            const xml = await res.text();

            // Extract items from RSS/Atom
            const items = extractRssItems(xml);

            for (const item of items) {
                const text = `${item.title || ''} ${item.description || ''}`.toLowerCase();

                // Check for funding keywords
                const hasFundingSignal = FUNDING_KEYWORDS.some(kw => text.includes(kw));
                if (!hasFundingSignal) continue;

                signals++;

                // Extract company domain from the article link
                const companyDomains = extractCompanyDomainsFromText(item.link, text);
                for (const domain of companyDomains) {
                    await registerDomain(db, domain, item.link || feed.url, 'financial_signals');
                    domains++;

                    // Also try ATS detection on common career URL patterns
                    const careerUrls = [
                        `https://${domain}/careers`,
                        `https://jobs.${domain}`,
                        `https://${domain}/jobs`,
                    ];
                    const detected = detectAtsSources(careerUrls, knownUrls);
                    for (const src of detected) {
                        src.discovery_origin = 'financial_signals';
                        await registerDiscoveredSource(db, src);
                        knownUrls.add(src.url);
                        sources++;
                    }
                }
            }

            logger.info(`[FinancialSignals] ${feed.name}: ${items.length} items, ${signals} funding signals`);
        } catch (err) {
            logger.warn(`[FinancialSignals] Feed ${feed.name} failed: ${err.message}`);
        }
    }

    return { domains, sources, signals };
}

// ── Sub-vector 2: SEC EDGAR Filings ─────────────────────────────────────────

/**
 * Scan SEC EDGAR for recent S-1/8-K filings that mention hiring.
 */
async function scanSecFilings(db, knownUrls, kv) {
    let domains = 0, sources = 0, signals = 0;

    try {
        const endDate = new Date().toISOString().split('T')[0];
        const startDate = new Date(Date.now() - 7 * 86400_000).toISOString().split('T')[0];

        const url = SEC_EFTS_URL
            .replace('STARTDATE', startDate)
            .replace('ENDDATE', endDate);

        const res = await fetchWithTimeout(url, {
            headers: { 'User-Agent': 'JobHunterBot/5.2 (job-discovery-research)', Accept: 'application/json' },
        }, 15_000);

        if (!res.ok) {
            logger.warn(`[FinancialSignals] SEC EDGAR returned ${res.status}`);
            return { domains, sources, signals };
        }

        const data = await res.json();
        const hits = data?.hits?.hits || [];

        for (const hit of hits.slice(0, 20)) {
            const companyName = hit?._source?.entity_name || hit?._source?.display_names?.[0] || '';
            const filingType = hit?._source?.form_type || '';

            if (!companyName) continue;
            signals++;

            // Try to derive domain from company name
            const slug = companyName.toLowerCase()
                .replace(/[^a-z0-9\s]/g, '')
                .trim()
                .split(/\s+/)
                .slice(0, 2)
                .join('');
            if (slug.length < 3) continue;

            const guessedDomain = `${slug}.com`;
            await registerDomain(db, guessedDomain, `sec:${filingType}:${companyName}`, 'financial_signals');
            domains++;
        }
    } catch (err) {
        logger.warn(`[FinancialSignals] SEC EDGAR scan failed: ${err.message}`);
    }

    return { domains, sources, signals };
}

// ── Sub-vector 3: Acquisition / M&A News ────────────────────────────────────

const MA_RSS_FEEDS = [
    'https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss',
    'https://finance.yahoo.com/rss/industry?s=technology',
];

const MA_KEYWORDS = ['acqui', 'merger', 'acquisition', 'acquired by', 'buys', 'purchase'];

/**
 * Scan M&A news feeds for acquisition-driven hiring opportunities.
 */
async function scanAcquisitionNews(db, knownUrls, kv) {
    let domains = 0, sources = 0, signals = 0;

    for (const feedUrl of MA_RSS_FEEDS) {
        try {
            const res = await fetchWithTimeout(feedUrl, {
                headers: { 'User-Agent': 'JobHunterBot/5.2', Accept: 'application/rss+xml, application/xml, text/xml' },
            }, 10_000);

            if (!res.ok) continue;
            const xml = await res.text();
            const items = extractRssItems(xml);

            for (const item of items) {
                const text = `${item.title || ''} ${item.description || ''}`.toLowerCase();
                const hasMASignal = MA_KEYWORDS.some(kw => text.includes(kw));
                if (!hasMASignal) continue;

                signals++;
                const companyDomains = extractCompanyDomainsFromText(item.link, text);
                for (const domain of companyDomains) {
                    await registerDomain(db, domain, item.link || feedUrl, 'financial_signals');
                    domains++;
                }
            }
        } catch (err) {
            logger.warn(`[FinancialSignals] M&A feed failed: ${err.message}`);
        }
    }

    return { domains, sources, signals };
}

// ── Sub-vector 4: Hiring Surge Press Releases ───────────────────────────────

const HIRING_PRESS_FEEDS = [
    'https://www.prnewswire.com/rss/technology-latest-news/technology-latest-news-list.rss',
    'https://www.businesswire.com/portal/site/home/news/rss/',
];

/**
 * Scan press release feeds for hiring surge announcements.
 */
async function scanHiringSurgePress(db, knownUrls, kv) {
    let domains = 0, sources = 0, signals = 0;

    for (const feedUrl of HIRING_PRESS_FEEDS) {
        try {
            const res = await fetchWithTimeout(feedUrl, {
                headers: { 'User-Agent': 'JobHunterBot/5.2', Accept: 'application/rss+xml, application/xml, text/xml' },
            }, 10_000);

            if (!res.ok) continue;
            const xml = await res.text();
            const items = extractRssItems(xml);

            for (const item of items) {
                const text = `${item.title || ''} ${item.description || ''}`.toLowerCase();
                const hasHiringSignal = HIRING_SIGNAL_KEYWORDS.some(kw => text.includes(kw));
                if (!hasHiringSignal) continue;

                signals++;
                const companyDomains = extractCompanyDomainsFromText(item.link, text);
                for (const domain of companyDomains) {
                    await registerDomain(db, domain, item.link || feedUrl, 'financial_signals');
                    domains++;
                }
            }
        } catch (err) {
            logger.warn(`[FinancialSignals] Hiring press feed failed: ${err.message}`);
        }
    }

    return { domains, sources, signals };
}

// ── RSS Parsing Helpers ─────────────────────────────────────────────────────

/**
 * Extract items from RSS/Atom XML.
 * Lightweight regex-based parser (no XML lib needed in Workers).
 *
 * @param {string} xml
 * @returns {Array<{title: string, link: string, description: string}>}
 */
function extractRssItems(xml) {
    const items = [];

    // RSS <item> elements
    const rssItemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = rssItemRegex.exec(xml)) !== null) {
        const block = match[1];
        const title = block.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i)?.[1] || '';
        const link = block.match(/<link[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/i)?.[1] || '';
        const desc = block.match(/<description[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/i)?.[1] || '';
        items.push({ title: decodeHtmlEntities(title), link: link.trim(), description: decodeHtmlEntities(desc) });
    }

    // Atom <entry> elements
    if (items.length === 0) {
        const atomEntryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
        while ((match = atomEntryRegex.exec(xml)) !== null) {
            const block = match[1];
            const title = block.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || '';
            const link = block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] || '';
            const summary = block.match(/<summary[^>]*>(.*?)<\/summary>/i)?.[1] || '';
            items.push({ title: decodeHtmlEntities(title), link: link.trim(), description: decodeHtmlEntities(summary) });
        }
    }

    return items;
}

/**
 * Decode basic HTML entities.
 * @param {string} str
 * @returns {string}
 */
function decodeHtmlEntities(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

/**
 * Extract company domains from article text and URLs.
 * Looks for explicit domain mentions and derives from article links.
 *
 * @param {string} articleUrl
 * @param {string} text - Lowercased article text
 * @returns {string[]} Extracted domains
 */
function extractCompanyDomainsFromText(articleUrl, text) {
    const domains = new Set();

    // 1. Extract domain from article URL itself (if it's a company page, not a news site)
    if (articleUrl) {
        try {
            const host = new URL(articleUrl).hostname.replace(/^www\./, '');
            const NEWS_DOMAINS = new Set([
                'techcrunch.com', 'crunchbase.com', 'sifted.eu', 'venturebeat.com',
                'pitchbook.com', 'prnewswire.com', 'businesswire.com', 'yahoo.com',
                'finance.yahoo.com', 'reuters.com', 'bloomberg.com',
            ]);
            if (!NEWS_DOMAINS.has(host)) {
                domains.add(host);
            }
        } catch { /* invalid URL */ }
    }

    // 2. Extract explicit domain mentions from text (e.g., "example.com")
    const domainRegex = /\b([a-z0-9][-a-z0-9]*\.(?:com|io|co|ai|dev|tech|app|xyz|org))\b/g;
    let m;
    while ((m = domainRegex.exec(text)) !== null) {
        const d = m[1];
        // Skip news/generic domains
        if (d.length > 4 && !d.includes('news') && !d.includes('rss') && !d.startsWith('www.')) {
            domains.add(d);
        }
    }

    return [...domains].slice(0, 5); // Cap at 5 domains per article
}
