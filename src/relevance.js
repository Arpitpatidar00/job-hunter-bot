/**
 * @module relevance
 * @description Job relevance scoring (0–100) with weighted multi-signal matching,
 * synonym expansion, combo bonuses/penalties, and structured match reports.
 */

import { compareTwoStrings } from 'string-similarity';
import { sanitizeText, parseDate, escapeRegex } from './utils.js';

/**
 * @typedef {object} ScoreResult
 * @property {number}   score       - Final score 0–100.
 * @property {string}   label       - Human-readable label (Excellent / Strong / Moderate / Weak / Poor).
 * @property {string}   color       - Emoji color indicator.
 * @property {string[]} reasons     - Why the job matched (or didn't).
 * @property {string[]} matchedSkills - Skills that were found in the posting.
 * @property {boolean}  excluded    - True if an exclusion keyword was detected.
 */

/** Score → label mapping thresholds (descending). */
const SCORE_LABELS = [
    { min: 85, label: 'Excellent Match', color: '🟢' },
    { min: 70, label: 'Strong Match', color: '🟡' },
    { min: 55, label: 'Moderate Match', color: '🔵' },
    { min: 40, label: 'Weak Match', color: '🟣' },
    { min: 0, label: 'Poor Match', color: '🔴' },
];

/**
 * Resolve the human-readable label + color for a numeric score.
 * @param {number} score
 * @returns {{ label: string, color: string }}
 */
function resolveLabel(score) {
    for (const tier of SCORE_LABELS) {
        if (score >= tier.min) return { label: tier.label, color: tier.color };
    }
    return { label: 'Poor Match', color: '🔴' };
}

/**
 * Expand a keyword list using the synonyms map so every synonym is also searched.
 * @param {string[]} keywords
 * @param {Record<string, string[]>} synonyms
 * @returns {string[]} De-duplicated expanded list (all lowercase).
 */
function expandWithSynonyms(keywords, synonyms = {}) {
    const expanded = new Set();
    for (const kw of keywords) {
        const lower = kw.toLowerCase();
        expanded.add(lower);
        const syns = synonyms[lower] || synonyms[kw];
        if (syns) {
            for (const s of syns) expanded.add(s.toLowerCase());
        }
    }
    return [...expanded];
}

/**
 * Check whether a keyword (or any of its synonyms) appears in text.
 * Uses word-boundary exact match first, then fuzzy fallback.
 * @param {string} keyword - Canonical keyword (lowercase).
 * @param {string} text - Lowercased search text.
 * @param {number} fuzzyThreshold
 * @param {Record<string, string[]>} synonyms
 * @returns {boolean}
 */
function keywordMatchesText(keyword, text, fuzzyThreshold, synonyms = {}) {
    const variants = [keyword, ...(synonyms[keyword] || []).map(s => s.toLowerCase())];

    for (const variant of variants) {
        // Exact word-boundary
        const re = new RegExp(`\\b${escapeRegex(variant)}\\b`, 'i');
        if (re.test(text)) return true;
    }

    // Fuzzy fallback on canonical keyword only (avoid noise from synonyms)
    const tokens = text.split(/\s+/);
    for (const token of tokens) {
        if (compareTwoStrings(keyword, token) >= fuzzyThreshold) return true;
    }

    // Multi-word sliding window
    const kwWords = keyword.split(/\s+/);
    if (kwWords.length > 1) {
        for (let i = 0; i <= tokens.length - kwWords.length; i++) {
            const window = tokens.slice(i, i + kwWords.length).join(' ');
            if (compareTwoStrings(keyword, window) >= fuzzyThreshold) return true;
        }
    }

    return false;
}

/**
 * Extract a salary string from raw text.
 * @param {string} text - Lowercased job text.
 * @returns {string|null}
 */
function extractSalaryFromText(text) {
    const patterns = [
        /(?:salary|compensation|pay|offer)[:\s]*([$€£₹]\s?[\d,]+(?:k)?\s*[-–to]+\s*[$€£₹]?\s?[\d,]+(?:k)?(?:\s*(?:per\s+)?(?:year|yr|annum|annually|pa|p\.?a\.?|lpa))?)/i,
        /([$€£₹]\s?[\d,]+(?:k)?\s*[-–to]+\s*[$€£₹]?\s?[\d,]+(?:k)?\s*(?:per\s+)?(?:year|yr|annum|annually|pa|p\.?a\.?|usd|eur|gbp|inr|lpa))/i,
        /([$€£₹]\s?[\d,]+(?:k)?\s*[-–to]+\s*[$€£₹]?\s?[\d,]+(?:k)?)/i,
        /((?:USD|EUR|GBP|INR)\s?[\d,]+(?:k)?\s*[-–to]+\s*[\d,]+(?:k)?)/i,
        /([\d,]+(?:k)?\s*[-–to]+\s*[\d,]+(?:k)?\s*(?:USD|EUR|GBP|INR|LPA))/i,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1].trim();
    }
    return null;
}

/**
 * Score a job from 0–100 based on config-defined weighted signals.
 *
 * Signals (default weights from config.weights):
 *   titleMatch    (30) – target role appears in title
 *   skillsMatch   (30) – mustMatch / shouldMatch keywords found
 *   techStackMatch(20) – niceToHave keywords found
 *   locationMatch (10) – work-preference / location keywords found
 *   salaryMatch   (10) – salary present and above minimum
 *
 * After base scoring, combo bonuses/penalties are applied and the score is clamped 0–100.
 *
 * @param {object} item - RSS feed item (title, content, contentSnippet, categories, etc.)
 * @param {object} config - Full bot configuration.
 * @returns {ScoreResult}
 */
export function scoreJob(item, config) {
    const rawText = `${item.title || ''} ${item.content || item.contentSnippet || ''}`;
    const text = sanitizeText(rawText).toLowerCase();
    const titleText = (item.title || '').toLowerCase();

    const {
        searchRules = {},
        targetRoles = [],
        synonyms = {},
        weights = {},
        scoringBonuses = {},
        scoringPenalties = {},
        filters = {},
        locationKeywords = [],
        fuzzyThreshold = 0.82,
    } = config;

    const w = {
        titleMatch: weights.titleMatch ?? 30,
        skillsMatch: weights.skillsMatch ?? 30,
        techStackMatch: weights.techStackMatch ?? 20,
        locationMatch: weights.locationMatch ?? 10,
        salaryMatch: weights.salaryMatch ?? 10,
    };

    const reasons = [];
    const matchedSkills = [];
    let baseScore = 0;

    // ── 0. Exclusion check ─────────────────────────────────────────────
    const excludeList = expandWithSynonyms(searchRules.exclude || [], synonyms);
    for (const ex of excludeList) {
        const re = new RegExp(`\\b${escapeRegex(ex)}\\b`, 'i');
        if (re.test(text)) {
            reasons.push(`Excluded: "${ex}" found`);
            return { score: 0, ...resolveLabel(0), reasons, matchedSkills: [], excluded: true };
        }
    }

    // ── 1. Title match (target roles) ──────────────────────────────────
    const expandedRoles = expandWithSynonyms(targetRoles, synonyms);
    let titleHits = 0;
    for (const role of expandedRoles) {
        if (titleText.includes(role)) {
            titleHits++;
            reasons.push(`Title: "${role}"`);
        }
    }
    const titleScore = titleHits > 0 ? w.titleMatch : 0;
    baseScore += titleScore;

    // ── 2. Skills match (mustMatch + shouldMatch) ──────────────────────
    let mustHits = 0;
    for (const kw of (searchRules.mustMatch || [])) {
        if (keywordMatchesText(kw.toLowerCase(), text, fuzzyThreshold, synonyms)) {
            mustHits++;
            matchedSkills.push(kw);
        }
    }

    let shouldHits = 0;
    for (const kw of (searchRules.shouldMatch || [])) {
        if (keywordMatchesText(kw.toLowerCase(), text, fuzzyThreshold, synonyms)) {
            shouldHits++;
            matchedSkills.push(kw);
        }
    }

    const mustTotal = (searchRules.mustMatch || []).length;
    const shouldTotal = (searchRules.shouldMatch || []).length;
    const mustRatio = mustTotal > 0 ? mustHits / mustTotal : 0;
    const shouldRatio = shouldTotal > 0 ? shouldHits / shouldTotal : 0;
    // Weight must-match 70%, should-match 30% of the skills bucket
    const skillRatio = mustRatio * 0.7 + shouldRatio * 0.3;
    const skillsScore = Math.min(w.skillsMatch, Math.round(skillRatio * w.skillsMatch));
    baseScore += skillsScore;

    if (mustHits > 0) reasons.push(`Must-match skills (${mustHits}): ${matchedSkills.slice(0, mustHits).join(', ')}`);
    if (shouldHits > 0) reasons.push(`Should-match skills (${shouldHits}): ${matchedSkills.slice(mustHits).join(', ')}`);

    // ── 3. Tech stack / nice-to-have ───────────────────────────────────
    let niceHits = 0;
    for (const kw of (searchRules.niceToHave || [])) {
        if (keywordMatchesText(kw.toLowerCase(), text, fuzzyThreshold, synonyms)) {
            niceHits++;
            matchedSkills.push(kw);
        }
    }

    const niceTotal = (searchRules.niceToHave || []).length;
    const techRatio = niceTotal > 0 ? niceHits / niceTotal : 0;
    const techScore = Math.round(techRatio * w.techStackMatch);
    baseScore += techScore;
    if (niceHits > 0) reasons.push(`Nice-to-have (${niceHits}): ${matchedSkills.slice(mustHits + shouldHits).join(', ')}`);

    // ── 4. Location match ──────────────────────────────────────────────
    const locationTerms = [...(locationKeywords || []), ...(filters.workPreference || []), ...(filters.locations || [])];
    const locLower = [...new Set(locationTerms.map(l => l.toLowerCase()))];
    let locationHit = false;
    for (const loc of locLower) {
        if (text.includes(loc)) { locationHit = true; break; }
    }
    const locationScore = locationHit ? w.locationMatch : 0;
    baseScore += locationScore;
    if (locationHit) reasons.push('Location/remote match');

    // ── 5. Salary match ────────────────────────────────────────────────
    const salaryStr = extractSalaryFromText(text);
    let salaryScore = 0;
    if (salaryStr) {
        salaryScore = w.salaryMatch;
        reasons.push(`Salary detected: ${salaryStr}`);
    }
    baseScore += salaryScore;

    // ── 6. Combo bonuses ───────────────────────────────────────────────
    let bonus = 0;
    const mustLower = matchedSkills.map(s => s.toLowerCase());

    if (mustLower.includes('next.js') && mustLower.includes('typescript')) {
        bonus += scoringBonuses.nextjsAndTypescript ?? 8;
        reasons.push('Bonus: Next.js + TypeScript combo');
    }
    if (mustLower.includes('node.js') && mustLower.includes('mongodb')) {
        bonus += scoringBonuses.nodeAndMongodb ?? 6;
        reasons.push('Bonus: Node.js + MongoDB combo');
    }
    if (mustLower.includes('aws')) {
        bonus += scoringBonuses.awsPresent ?? 4;
        reasons.push('Bonus: AWS present');
    }
    // Full MERN stack check
    const mernKeys = ['mongodb', 'express', 'react', 'node.js'];
    if (mernKeys.every(k => mustLower.includes(k))) {
        bonus += scoringBonuses.fullMernStack ?? 10;
        reasons.push('Bonus: Full MERN stack alignment');
    }
    // Remote India
    if (text.includes('india') && locationHit) {
        bonus += scoringBonuses.remoteIndia ?? 5;
        reasons.push('Bonus: Remote India');
    }

    // ── 7. Penalties ───────────────────────────────────────────────────
    let penalty = 0;
    const nonJsStacks = ['python', 'ruby', 'go ', 'golang', 'rust', 'scala', 'elixir'];
    for (const lang of nonJsStacks) {
        const re = new RegExp(`\\b${escapeRegex(lang.trim())}\\b`, 'i');
        if (re.test(titleText) && mustHits === 0) {
            penalty += scoringPenalties.nonJsStack ?? -15;
            reasons.push(`Penalty: Non-JS primary stack (${lang.trim()}) in title`);
            break;
        }
    }

    // Frontend-only penalty (has frontend keywords but no backend)
    const feKeywords = ['frontend', 'front-end', 'css', 'html', 'ui/ux'];
    const beKeywords = ['backend', 'back-end', 'node.js', 'express', 'api', 'server'];
    const hasFE = feKeywords.some(k => text.includes(k));
    const hasBE = beKeywords.some(k => text.includes(k));
    if (hasFE && !hasBE && titleText.includes('frontend')) {
        penalty += scoringPenalties.frontendOnlyNoBackend ?? -5;
        reasons.push('Penalty: Frontend-only, no backend signals');
    }

    // ── 8. Hard filter: minimum primary matches ────────────────────────
    const minPrimary = filters.minPrimaryMatches ?? 1;
    const totalHits = mustHits + shouldHits;
    if (totalHits === 0 && titleHits === 0) {
        // No skill matches AND no title match → scale to near-zero
        baseScore = Math.round(baseScore * 0.1);
        reasons.push('Hard filter: No primary stack matches');
    } else if (totalHits < minPrimary) {
        // Some matches but below minimum — gentle scaling
        const scaleFactor = Math.max(0.5, totalHits / minPrimary);
        baseScore = Math.round(baseScore * scaleFactor);
        reasons.push(`Hard filter: Only ${totalHits} of ${minPrimary} required primary matches`);
    }

    // ── Final score ────────────────────────────────────────────────────
    const finalScore = Math.max(0, Math.min(100, baseScore + bonus + penalty));
    const { label, color } = resolveLabel(finalScore);

    return {
        score: finalScore,
        label,
        color,
        reasons,
        matchedSkills: [...new Set(matchedSkills)],
        excluded: false,
    };
}

/**
 * Legacy-compatible boolean check: score ≥ threshold.
 * @param {object} item - RSS feed item.
 * @param {object} config - Full bot config.
 * @returns {boolean}
 */
export function isJobRelevant(item, config) {
    const threshold = config.notificationThreshold ?? 65;
    const result = scoreJob(item, config);
    return result.score >= threshold && !result.excluded;
}

/**
 * Check if a job was posted within the configured time window.
 * @param {object} item - RSS feed item with pubDate.
 * @param {number} timeWindowHours - Number of hours to consider a job "new".
 * @returns {boolean}
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

/**
 * Compute a human-readable "posted X ago" string.
 * @param {string} dateStr
 * @returns {string}
 */
export function timeAgo(dateStr) {
    if (!dateStr) return 'Unknown';
    const d = parseDate(dateStr);
    if (!d) return 'Unknown';

    const diffMs = Date.now() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${mins} minute${mins !== 1 ? 's' : ''} ago`;

    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`;

    const days = Math.floor(hrs / 24);
    return `${days} day${days !== 1 ? 's' : ''} ago`;
}
