/**
 * @module relevance
 * @description Job Intelligence Scoring Engine v2 — multi-layer 0–100 ranking.
 *
 * Signal Stack:
 *   1. Exclusion guard       — hard stop on blacklisted tech
 *   2. Title match           — target role alignment (weight: 30)
 *   3. Skills match          — must/should keywords (weight: 30)
 *   4. Tech stack / nice-to-have (weight: 20)
 *   5. Location/remote match (weight: 10)
 *   6. Salary present bonus  (weight: 10)
 *   7. TF-IDF enhancement    — term frequency boost on must-match skills (blend: 15%)
 *   8. Combo bonuses         — Next.js+TS, MERN, AWS, Remote India
 *   9. Seniority alignment   — bonus for junior/mid roles, penalty for senior-only
 *  10. Penalty layer         — non-JS stack, frontend-only
 *
 * Adapted for Cloudflare Workers — zero npm dependencies.
 */

import {
    compareTwoStrings,
    sanitizeText,
    parseDate,
    escapeRegex,
    parseExperienceYears,
    extractSalaryUSD,
    detectRemoteType,
} from '../core/utils.js';

// ── Score Labels ─────────────────────────────────────────────────────────────

/** @type {Array<{min: number, label: string, color: string}>} */
const SCORE_LABELS = [
    { min: 88, label: 'Excellent Match', color: '🟢' },
    { min: 72, label: 'Strong Match', color: '🟡' },
    { min: 55, label: 'Moderate Match', color: '🔵' },
    { min: 38, label: 'Weak Match', color: '🟣' },
    { min: 0, label: 'Poor Match', color: '🔴' },
];

/**
 * @param {number} score
 * @returns {{ label: string, color: string }}
 */
function resolveLabel(score) {
    for (const tier of SCORE_LABELS) {
        if (score >= tier.min) return { label: tier.label, color: tier.color };
    }
    return { label: 'Poor Match', color: '🔴' };
}

// ── Synonym Expansion ─────────────────────────────────────────────────────────

/**
 * @param {string[]} keywords
 * @param {Record<string, string[]>} synonyms
 * @returns {string[]}
 */
function expandWithSynonyms(keywords, synonyms = {}) {
    const expanded = new Set();
    for (const kw of keywords) {
        const lower = kw.toLowerCase();
        expanded.add(lower);
        const syns = synonyms[lower] || synonyms[kw] || [];
        for (const s of syns) expanded.add(s.toLowerCase());
    }
    return [...expanded];
}

// ── Keyword Matching ──────────────────────────────────────────────────────────

/**
 * @param {string} keyword
 * @param {string} text
 * @param {number} fuzzyThreshold
 * @param {Record<string, string[]>} synonyms
 * @returns {boolean}
 */
function keywordMatchesText(keyword, text, fuzzyThreshold, synonyms = {}) {
    const variants = [keyword, ...(synonyms[keyword] || []).map(s => s.toLowerCase())];

    for (const variant of variants) {
        if (new RegExp(`\\b${escapeRegex(variant)}\\b`, 'i').test(text)) return true;
    }

    // Fuzzy fallback on canonical keyword
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

// ── TF-IDF Signal ─────────────────────────────────────────────────────────────

/**
 * Compute a normalized TF-IDF score for how prominent the mustMatch
 * keywords are within the document, penalized by global frequency.
 *
 * TF  = (occurrences of keyword in doc) / (total tokens in doc)
 * IDF = log(totalDocuments / documentsContainingTerm)
 * Score = sum of (TF * IDF) across all mustMatch terms, normalized.
 *
 * @param {string[]} mustMatch
 * @param {string} text
 * @param {Record<string, string[]>} synonyms
 * @param {{ totalDocs: number, termCounts: Record<string, number> }} idfData
 * @returns {number} 0–1
 */
function computeTfIdfScore(mustMatch, text, synonyms = {}, idfData = { totalDocs: 1, termCounts: {} }) {
    if (!mustMatch.length || !text) return 0;

    const tokens = text.toLowerCase().split(/\s+/);
    const totalTokens = tokens.length || 1;
    const { totalDocs, termCounts } = idfData;

    let totalTfIdf = 0;

    for (const keyword of mustMatch) {
        const variants = [keyword.toLowerCase(), ...(synonyms[keyword.toLowerCase()] || [])];
        let count = 0;
        for (const token of tokens) {
            if (variants.some(v => token === v || token.includes(v))) count++;
        }

        // Term Frequency (how dense is it locally)
        const tf = count / totalTokens;

        // Inverse Document Frequency (how rare is it globally)
        // Add 1 to denominator to prevent division by zero, +1 to total to ensure idf > 0
        const docCountForTerm = termCounts[keyword.toLowerCase()] || 1;
        const idf = Math.log10(totalDocs / docCountForTerm) + 1;

        totalTfIdf += (tf * idf);
    }

    // Mean TF-IDF across all terms
    const meanTfIdf = totalTfIdf / mustMatch.length;

    // Cap — normalize to [0, 1]. A score of 0.05 is generally very dense for TF*IDF.
    return Math.min(1, meanTfIdf / 0.05);
}

// ── Seniority Helpers ─────────────────────────────────────────────────────────

/**
 * Detect seniority signals in the job text.
 * @param {string} text - Lowercase text.
 * @returns {'junior' | 'mid' | 'senior' | 'lead' | 'unknown'}
 */
function detectSeniority(text) {
    if (/\b(vp|vice president|director|c[tse]o|head of engineering)\b/.test(text)) return 'lead';
    if (/\b(staff|principal|lead|senior|sr\.?|expert)\b/.test(text)) return 'senior';
    if (/\b(mid[- ]?level|intermediate|associate|sde[-\s]?2|ii)\b/.test(text)) return 'mid';
    if (/\b(junior|jr\.?|entry[- ]?level|graduate|intern|sde[-\s]?1|i\b|fresh)\b/.test(text)) return 'junior';
    return 'unknown';
}

/**
 * Check if the detected seniority aligns with the user's experience preferences.
 * @param {string} detectedSeniority
 * @param {string[]} configExperienceLevel - Config `experienceLevel` array.
 * @returns {'match' | 'mismatch' | 'neutral'}
 */
function senioritySatisfied(detectedSeniority, configExperienceLevel = []) {
    if (!detectedSeniority || detectedSeniority === 'unknown') return 'neutral';
    if (detectedSeniority === 'lead') return 'mismatch';

    const juniorSignals = ['junior', 'entry level', 'sde 1', '1+ years', '2+ years'];
    const midSignals = ['mid-level', 'mid', 'associate', 'sde 2', '3+ years', '4+ years'];

    const wantsJunior = configExperienceLevel.some(e => juniorSignals.some(s => e.toLowerCase().includes(s)));
    const wantsMid = configExperienceLevel.some(e => midSignals.some(s => e.toLowerCase().includes(s)));

    if (detectedSeniority === 'junior' && wantsJunior) return 'match';
    if (detectedSeniority === 'mid' && (wantsMid || wantsJunior)) return 'match';
    if (detectedSeniority === 'senior' && !wantsJunior && !wantsMid) return 'neutral';
    if (detectedSeniority === 'senior' && (wantsJunior || wantsMid)) return 'mismatch';

    return 'neutral';
}

// ── @typedef ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ScoreBreakdown
 * @property {number} titleScore
 * @property {number} skillsScore
 * @property {number} techScore
 * @property {number} locationScore
 * @property {number} salaryScore
 * @property {number} tfidfBoost
 * @property {number} bonuses
 * @property {number} penalties
 */

/**
 * @typedef {object} JobFeatures
 * @property {{ min: number, max: number|null } | null} experience
 * @property {{ min: number, max: number, currency: string } | null} salaryUSD
 * @property {'remote'|'hybrid'|'onsite'|'unknown'} remoteType
 * @property {'junior'|'mid'|'senior'|'lead'|'unknown'} seniority
 */

/**
 * @typedef {object} ScoreResult
 * @property {number}        score
 * @property {string}        label
 * @property {string}        color
 * @property {string[]}      reasons
 * @property {string[]}      matchedSkills
 * @property {boolean}       excluded
 * @property {ScoreBreakdown} breakdown
 * @property {JobFeatures}   features
 */

// ── Main Scorer ───────────────────────────────────────────────────────────────

/**
 * Score a job from 0–100.
 *
 * @param {object} item - RSS/RawJob item.
 * @param {object} config - Full bot config.
 * @param {{ totalDocs: number, termCounts: Record<string, number> }} [idfData] - Global term frequencies.
 * @param {number} [semanticSimilarity] - AI generated cosine distance against profile (0 to 1).
 * @returns {ScoreResult}
 */
export function scoreJob(item, config, idfData = { totalDocs: 1, termCounts: {} }, semanticSimilarity = 0) {
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
        experienceLevel = [],
        scoring = {},
    } = config;

    const tfidfWeight = scoring.tfidfWeight ?? 0.15;
    const experienceBonus = scoring.experienceBonus ?? 5;
    const seniorityPenalty = scoring.seniorityPenalty ?? -8;

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

    // ── Feature Extraction ──────────────────────────────────────────────────
    const experience = parseExperienceYears(text);
    const salaryUSD = extractSalaryUSD(text);
    const remoteType = detectRemoteType(text);
    const seniority = detectSeniority(titleText + ' ' + text.slice(0, 500));

    /** @type {JobFeatures} */
    const features = { experience, salaryUSD, remoteType, seniority };

    // ── 0. Exclusion check ──────────────────────────────────────────────────
    const excludeList = expandWithSynonyms(searchRules.exclude || [], synonyms);
    for (const ex of excludeList) {
        if (new RegExp(`\\b${escapeRegex(ex)}\\b`, 'i').test(text)) {
            reasons.push(`Excluded: "${ex}" found`);
            return {
                score: 0,
                ...resolveLabel(0),
                reasons,
                matchedSkills: [],
                excluded: true,
                breakdown: { titleScore: 0, skillsScore: 0, techScore: 0, locationScore: 0, salaryScore: 0, tfidfBoost: 0, bonuses: 0, penalties: 0 },
                features,
            };
        }
    }

    // ── 1. Title match ──────────────────────────────────────────────────────
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

    // ── 2. Skills match ─────────────────────────────────────────────────────
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
    const skillRatio = mustRatio * 0.7 + shouldRatio * 0.3;
    const skillsScore = Math.min(w.skillsMatch, Math.round(skillRatio * w.skillsMatch));
    baseScore += skillsScore;

    if (mustHits > 0) reasons.push(`Must-match (${mustHits}/${mustTotal}): ${matchedSkills.slice(0, mustHits).join(', ')}`);
    if (shouldHits > 0) reasons.push(`Should-match (${shouldHits}/${shouldTotal}): ${matchedSkills.slice(mustHits, mustHits + shouldHits).join(', ')}`);

    // ── 3. Tech stack / nice-to-have ────────────────────────────────────────
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
    if (niceHits > 0) reasons.push(`Nice-to-have (${niceHits}/${niceTotal}): ${matchedSkills.slice(mustHits + shouldHits).join(', ')}`);

    // ── 4. Location match ───────────────────────────────────────────────────
    const locationTerms = [
        ...(locationKeywords || []),
        ...(filters.workPreference || []),
        ...(filters.locations || []),
    ];
    const locLower = [...new Set(locationTerms.map(l => l.toLowerCase()))];
    const locationHit = locLower.some(loc => text.includes(loc));
    const locationScore = locationHit ? w.locationMatch : 0;
    baseScore += locationScore;
    if (locationHit) reasons.push(`Location/remote match (${remoteType})`);

    // ── 5. Salary signal ────────────────────────────────────────────────────
    let salaryScore = 0;
    if (salaryUSD) {
        salaryScore = w.salaryMatch;
        reasons.push(`Salary detected: ~$${salaryUSD.min.toLocaleString()}${salaryUSD.max !== salaryUSD.min ? '–$' + salaryUSD.max.toLocaleString() : ''} USD`);
    } else {
        // Legacy text extraction fallback
        const patterns = [
            /(?:salary|compensation|pay|offer)[:\s]*([$€£₹]\s?[\d,]+(?:k)?\s*[-–to]+\s*[$€£₹]?\s?[\d,]+(?:k)?(?:\s*(?:per\s+)?(?:year|yr|lpa))?)/i,
            /([$€£₹]\s?[\d,]+(?:k)?\s*[-–to]+\s*[$€£₹]?\s?[\d,]+(?:k)?)/i,
        ];
        for (const p of patterns) {
            const m = text.match(p);
            if (m) {
                salaryScore = w.salaryMatch;
                reasons.push(`Salary detected: ${m[1].trim()}`);
                break;
            }
        }
    }
    baseScore += salaryScore;

    // ── 6. TF-IDF Enhancement ───────────────────────────────────────────────
    const tfidf = computeTfIdfScore(searchRules.mustMatch || [], text, synonyms, idfData);
    const tfidfBoost = Math.round(tfidf * tfidfWeight * 100);
    if (tfidfBoost > 0) reasons.push(`True TF-IDF boost: +${tfidfBoost} (rarity * density)`);

    // ── 7. Combo bonuses ────────────────────────────────────────────────────
    let bonus = 0;
    const matched = matchedSkills.map(s => s.toLowerCase());

    if (matched.includes('next.js') && matched.includes('typescript')) {
        bonus += scoringBonuses.nextjsAndTypescript ?? 8;
        reasons.push('Bonus: Next.js + TypeScript combo (+8)');
    }
    if (matched.includes('node.js') && matched.includes('mongodb')) {
        bonus += scoringBonuses.nodeAndMongodb ?? 6;
        reasons.push('Bonus: Node.js + MongoDB combo (+6)');
    }
    if (matched.includes('aws')) {
        bonus += scoringBonuses.awsPresent ?? 4;
        reasons.push('Bonus: AWS present (+4)');
    }
    if (['mongodb', 'express', 'react', 'node.js'].every(k => matched.includes(k))) {
        bonus += scoringBonuses.fullMernStack ?? 10;
        reasons.push('Bonus: Full MERN stack (+10)');
    }
    if (text.includes('india') && locationHit) {
        bonus += scoringBonuses.remoteIndia ?? 5;
        reasons.push('Bonus: Remote India (+5)');
    }

    // ── 8. Seniority bonus/penalty ──────────────────────────────────────────
    const seniorityResult = senioritySatisfied(seniority, experienceLevel);
    if (seniority !== 'unknown') {
        if (seniorityResult === 'match') {
            bonus += experienceBonus;
            reasons.push(`Seniority match: ${seniority} (+${experienceBonus})`);
        } else if (seniorityResult === 'mismatch') {
            bonus += seniorityPenalty;
            reasons.push(`Seniority mismatch: ${seniority} (${seniorityPenalty})`);
        }
    }

    // Experience years info (informational only)
    if (experience) {
        const expStr = experience.max ? `${experience.min}–${experience.max}` : `${experience.min}+`;
        reasons.push(`Experience: ${expStr} years required`);
    }

    // ── 9. Penalty layer ────────────────────────────────────────────────────
    let penalty = 0;
    const nonJsStacks = ['python', 'ruby', 'go ', 'golang', 'rust', 'scala', 'elixir'];
    for (const lang of nonJsStacks) {
        if (new RegExp(`\\b${escapeRegex(lang.trim())}\\b`, 'i').test(titleText) && mustHits === 0) {
            penalty += scoringPenalties.nonJsStack ?? -15;
            reasons.push(`Penalty: Non-JS primary stack (${lang.trim()}) in title`);
            break;
        }
    }

    const feKeywords = ['frontend', 'front-end', 'css', 'html', 'ui/ux'];
    const beKeywords = ['backend', 'back-end', 'node.js', 'express', 'api', 'server'];
    const hasFE = feKeywords.some(k => text.includes(k));
    const hasBE = beKeywords.some(k => text.includes(k));
    if (hasFE && !hasBE && titleText.includes('frontend')) {
        penalty += scoringPenalties.frontendOnlyNoBackend ?? -5;
        reasons.push('Penalty: Frontend-only, no backend signals');
    }

    // ── 10. Hard filter: minimum primary matches ────────────────────────────
    const totalHits = mustHits + shouldHits;
    const minPrimary = filters.minPrimaryMatches ?? 1;
    if (totalHits === 0 && titleHits === 0) {
        baseScore = Math.round(baseScore * 0.1);
        reasons.push('Hard filter: No primary stack matches');
    } else if (totalHits < minPrimary) {
        const scaleFactor = Math.max(0.5, totalHits / minPrimary);
        baseScore = Math.round(baseScore * scaleFactor);
        reasons.push(`Hard filter: Only ${totalHits}/${minPrimary} required primary matches`);
    }

    // ── 11. AI Semantic Bonus ───────────────────────────────────────────────
    let semanticBoost = 0;
    if (semanticSimilarity > 0.70) {
        // Between 0.70 and 1.0, scale to max 25 points.
        semanticBoost = Math.round(((semanticSimilarity - 0.70) / 0.30) * 25);
        reasons.push(`AI Semantic boost: +${semanticBoost} (${(semanticSimilarity * 100).toFixed(1)}% match)`);
    }

    // ── Final score ─────────────────────────────────────────────────────────
    const finalScore = Math.max(0, Math.min(100, baseScore + tfidfBoost + bonus + penalty + semanticBoost));
    const { label, color } = resolveLabel(finalScore);

    /** @type {ScoreBreakdown} */
    const breakdown = {
        titleScore,
        skillsScore,
        techScore,
        locationScore,
        salaryScore,
        tfidfBoost,
        semanticBoost,
        bonuses: bonus,
        penalties: penalty,
    };

    return {
        score: finalScore,
        label,
        color,
        reasons,
        matchedSkills: [...new Set(matchedSkills)],
        excluded: false,
        breakdown,
        features,
    };
}

/**
 * Boolean shortcut: job is relevant if score ≥ threshold.
 * @param {object} item
 * @param {object} config
 * @returns {boolean}
 */
export function isJobRelevant(item, config) {
    const threshold = config.notificationThreshold ?? 65;
    const result = scoreJob(item, config);
    return result.score >= threshold && !result.excluded;
}

/**
 * Check if a job was posted within the configured time window.
 * @param {object} item
 * @param {number} timeWindowHours
 * @returns {boolean}
 */
export function isNewJob(item, timeWindowHours) {
    const dateStr = item.pubDate || item.isoDate;
    if (!dateStr) return false;
    const postedDate = parseDate(dateStr);
    if (!postedDate) return false;
    return (Date.now() - postedDate.getTime()) <= timeWindowHours * 60 * 60 * 1000;
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
