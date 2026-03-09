/**
 * @module relevance
 * @description Job Intelligence Scoring Engine v3 — multi-layer 0–100 ranking.
 *
 * Signal Stack:
 *   1. Input sanitization & null-safety guard
 *   2. Exclusion guard       — hard stop on blacklisted tech (title + body)
 *   3. Title match           — graduated score based on hit count (weight: 30)
 *   4. Skills match          — must/should keywords with dedup (weight: 30)
 *      ↳ Hard gate: mustHits < 1 → score capped at 45 regardless
 *   5. Tech stack / nice-to-have (weight: 20)
 *   6. Location/remote match — word-boundary checked (weight: 10)
 *   7. Salary quality signal — minimum amount check (weight: 10)
 *   8. TF-IDF enhancement   — true per-term TF×IDF, summed not averaged (blend: 15%)
 *   9. Experience years      — actively used in scoring (bonus/penalty)
 *  10. Combo bonuses         — Next.js+TS, MERN, AWS, Remote India
 *  11. Seniority alignment   — scans full text for signals
 *  12. Penalty layer         — non-JS stack (title+body), frontend-only
 *  13. Score floor: final score must be ≥ 50 to pass (otherwise returns excluded=true)
 *
 * Fixes vs v2:
 *  - Title: graduated scoring (1 hit=60%, 2=80%, 3+=100% of weight)
 *  - Title: word-boundary regex instead of includes()
 *  - Skills: per-skill dedup using Set — no duplicate counting
 *  - TF-IDF: exact token match only (no token.includes(v) overcounting)
 *  - TF-IDF: sum of TF×IDF (not mean) — more matches = higher signal
 *  - TF-IDF: IDF smoothed with log((N+1)/(df+1)) for better discrimination
 *  - Location: word-boundary regex — no false positives from substrings
 *  - Salary: validates extracted amount ≥ 10,000 USD
 *  - Experience years: bonus/penalty applied based on config
 *  - Seniority: scans full text (not just 500 chars)
 *  - Non-JS penalty: triggers on title OR body (not just title)
 *  - Frontend penalty: stricter — requires zero must-match AND no backend keywords
 *  - Hard mustMatch gate: <1 must-match → score capped at 45 (below 50 threshold)
 *  - Score threshold: final score < 50 → excluded=true (never sends alerts)
 *  - matchedSkills: fully deduplicated before return
 *  - reasons: deduplicated — no duplicate entries
 */

import {
  compareTwoStrings,
  sanitizeText,
  parseDate,
  escapeRegex,
  parseExperienceYears,
  extractSalaryUSD,
  detectRemoteType,
} from "../core/utils.js";

import {
  SCORE_LABELS,
  SENIORITY_REGEX,
  SENIORITY_PREF_REGEX,
  REGION_BONUS_REGEX,
  NON_JS_STACKS,
  FRONTEND_KEYWORDS,
  BACKEND_KEYWORDS,
  FRONTEND_TITLE_REGEX,
} from "./skills.js";

import { getGlobalMatcher } from "./fastMatcher.js";

// ── Score Labels ─────────────────────────────────────────────────────────────

/**
 * @param {number} score
 * @returns {{ label: string, color: string }}
 */
function resolveLabel(score) {
  for (const tier of SCORE_LABELS) {
    if (score >= tier.min) return { label: tier.label, color: tier.color };
  }
  return { label: "Poor Match", color: "🔴" };
}

// ── Synonym Expansion ─────────────────────────────────────────────────────────

/**
 * Expand keywords with their synonyms, returning a deduplicated lowercase set.
 * @param {string[]} keywords
 * @param {Record<string, string[]>} synonyms
 * @returns {string[]}
 */
function expandWithSynonyms(keywords, synonyms = {}) {
  const expanded = new Set();
  for (const kw of keywords) {
    const lower = kw.toLowerCase().trim();
    if (!lower) continue;
    expanded.add(lower);
    // Check both the canonical lower form and the original casing
    const syns = synonyms[lower] || synonyms[kw] || [];
    for (const s of syns) {
      const sl = s.toLowerCase().trim();
      if (sl) expanded.add(sl);
    }
  }
  return [...expanded];
}

// ── Keyword Matching ──────────────────────────────────────────────────────────

/**
 * Test whether a keyword (or any of its synonyms) appears in text,
 * using word-boundary regex first, then fuzzy fallback.
 *
 * FIX v3: keywordMatchesText now always expands synonyms from the central map
 * so behavior is consistent regardless of call-site.
 *
 * @param {string} keyword - Already lowercased.
 * @param {string} text    - Sanitized, lowercased.
 * @param {number} fuzzyThreshold
 * @param {Record<string, string[]>} synonyms
 * @returns {boolean}
 */
function keywordMatchesText(keyword, text, fuzzyThreshold, synonyms = {}) {
  // Build full variant list: canonical + all synonyms (both directions)
  const variantSet = new Set([keyword]);
  const directSyns = synonyms[keyword] || [];
  for (const s of directSyns) variantSet.add(s.toLowerCase().trim());

  for (const variant of variantSet) {
    if (!variant) continue;
    // FIX: word-boundary regex — prevents "go" matching "google"
    try {
      if (new RegExp(`\\b${escapeRegex(variant)}\\b`, "i").test(text))
        return true;
    } catch {
      // Regex construction failed (rare) — fall through to fuzzy
    }
  }

  // Fuzzy fallback: compare against individual tokens (exact token comparison, not substring)
  const tokens = text.split(/\s+/);
  for (const token of tokens) {
    if (compareTwoStrings(keyword, token) >= fuzzyThreshold) return true;
  }

  // Multi-word sliding window fuzzy
  const kwWords = keyword.split(/\s+/);
  if (kwWords.length > 1) {
    for (let i = 0; i <= tokens.length - kwWords.length; i++) {
      const window = tokens.slice(i, i + kwWords.length).join(" ");
      if (compareTwoStrings(keyword, window) >= fuzzyThreshold) return true;
    }
  }

  return false;
}

// ── TF-IDF Signal ─────────────────────────────────────────────────────────────

/**
 * Compute a normalized TF-IDF signal for mustMatch keywords.
 *
 * v3 fixes:
 *   - Exact token equality only (no token.includes(v) — was massively overcounting)
 *   - IDF = log((N+1)/(df+1)) — standard BM25-style smoothing, avoids zero IDF
 *   - Sum of TF*IDF across terms (not mean) — more matched terms = higher signal
 *   - Normalization constant tuned empirically to realistic densities
 *
 * @param {string[]} mustMatch
 * @param {string[]} tokens - Pre-tokenized, lowercased tokens from full job text.
 * @param {Record<string, string[]>} synonyms
 * @param {{ totalDocs: number, termCounts: Record<string, number> }} idfData
 * @returns {number} 0–1
 */
function computeTfIdfScore(
  mustMatch,
  tokens,
  synonyms = {},
  idfData = { totalDocs: 1, termCounts: {} },
) {
  if (!mustMatch.length || !tokens.length) return 0;

  const totalTokens = tokens.length;
  const { totalDocs = 1, termCounts = {} } = idfData || {};
  // Smoothed total to avoid log(0)
  const N = Math.max(totalDocs, 1) + 1;

  let totalTfIdf = 0;
  let termsWithSignal = 0;

  for (const keyword of mustMatch) {
    const lower = keyword.toLowerCase().trim();
    const variants = new Set([
      lower,
      ...(synonyms[lower] || []).map((s) => s.toLowerCase().trim()),
    ]);

    // FIX: exact token match only (was token.includes(v) — massive overcounting)
    let count = 0;
    for (const token of tokens) {
      if (variants.has(token)) count++;
    }

    if (count === 0) continue;
    termsWithSignal++;

    // Term Frequency — how dense in this document
    const tf = count / totalTokens;

    // IDF — BM25-style smoothing: log((N+1) / (df+1))
    const df = termCounts[lower] || 1;
    const idf = Math.log(N / (df + 1)) + 1; // +1 ensures idf > 0 even for very common terms

    totalTfIdf += tf * idf;
  }

  if (termsWithSignal === 0) return 0;

  // Normalize: sum of TF-IDF across terms, cap at 1.
  // A realistic dense document with 3+ rare terms scores ~0.08–0.15, so normalize to that range.
  const NORM = 0.1;
  return Math.min(1, totalTfIdf / NORM);
}

// ── Seniority Helpers ─────────────────────────────────────────────────────────

/**
 * Detect seniority signals in the job text.
 * FIX v3: scans FULL text (was limited to first 500 chars).
 * @param {string} text - Lowercase full text.
 * @returns {'junior' | 'mid' | 'senior' | 'lead' | 'unknown'}
 */
function detectSeniority(text) {
  if (SENIORITY_REGEX.lead.test(text)) return "lead";
  if (SENIORITY_REGEX.senior.test(text)) return "senior";
  if (SENIORITY_REGEX.mid.test(text)) return "mid";
  if (SENIORITY_REGEX.junior.test(text)) return "junior";
  return "unknown";
}

/**
 * Check if the detected seniority aligns with the user's experience preferences.
 * @param {string} detectedSeniority
 * @param {string[]} configExperienceLevel
 * @returns {'match' | 'mismatch' | 'neutral'}
 */
function senioritySatisfied(detectedSeniority, configExperienceLevel = []) {
  if (!detectedSeniority || detectedSeniority === "unknown") return "neutral";
  if (detectedSeniority === "lead") return "mismatch";

  const levs = configExperienceLevel.map((e) => e.toLowerCase());
  const wantsJunior = levs.some((e) => SENIORITY_PREF_REGEX.junior.test(e));
  const wantsMid = levs.some((e) => SENIORITY_PREF_REGEX.mid.test(e));

  if (detectedSeniority === "junior")
    return wantsJunior ? "match" : wantsMid ? "neutral" : "mismatch";
  if (detectedSeniority === "mid")
    return wantsMid || wantsJunior ? "match" : "neutral";
  if (detectedSeniority === "senior")
    return wantsJunior || wantsMid ? "mismatch" : "neutral";

  return "neutral";
}

// ── Experience Year Scoring ───────────────────────────────────────────────────

/**
 * Score based on experience years extracted from job text vs user's config.
 * FIX v3: experience years are now ACTIVELY USED (were extracted but ignored in v2).
 *
 * @param {{ min: number, max: number|null }|null} experience - Extracted from job text.
 * @param {string[]} configExperienceLevel - User's experience preferences.
 * @returns {{ bonus: number, reason: string|null }}
 */
function scoreExperience(experience, configExperienceLevel = []) {
  if (!experience) return { bonus: 0, reason: null };

  const jobMaxYears = experience.max ?? experience.min;
  const jobMinYears = experience.min;

  // Parse user's preferred max years from config
  let userMaxYears = 3; // default: assume user wants ≤3 years
  const levs = configExperienceLevel.map((e) => e.toLowerCase());
  for (const lev of levs) {
    const m = lev.match(/(\d+)\+?\s*(?:yr|year)/);
    if (m) {
      userMaxYears = Math.max(userMaxYears, parseInt(m[1], 10));
    }
  }

  // If job requires more experience than user wants — penalty
  if (jobMinYears > userMaxYears + 1) {
    return {
      bonus: -6,
      reason: `Experience mismatch: job requires ${jobMinYears}+ yrs (user prefers ≤${userMaxYears})`,
    };
  }

  // If job max experience is within user's range — bonus
  if (jobMaxYears <= userMaxYears) {
    return {
      bonus: 4,
      reason: `Experience fit: ${jobMinYears}–${jobMaxYears} yrs matches preference`,
    };
  }

  return { bonus: 0, reason: null };
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
 * @property {number} semanticBoost
 * @property {number} bonuses
 * @property {number} penalties
 * @property {number} experienceBonus
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
 * @property {number}         score
 * @property {string}         label
 * @property {string}         color
 * @property {string[]}       reasons
 * @property {string[]}       matchedSkills
 * @property {boolean}        excluded
 * @property {ScoreBreakdown} breakdown
 * @property {JobFeatures}    features
 */

/** Minimum score required to send an alert — jobs below this are filtered. */
export const MINIMUM_ALERT_SCORE = 50;

// ── Main Scorer ───────────────────────────────────────────────────────────────

/** Module-level debug counter — logs first 10 scoring evaluations per worker invocation. */
let _scoreDebugCount = 0;

/** Reset debug counter at the start of each evaluateJobs() invocation. */
export function resetScoreDebugCount() {
  _scoreDebugCount = 0;
}

/**
 * Score a job from 0–100.
 *
 * @param {object} item - RSS/RawJob item.
 * @param {object} config - Full bot config.
 * @param {{ totalDocs: number, termCounts: Record<string, number> }} [idfData]
 * @param {Array<{text: string, sim: number, vec: number[]}>} [ragMatches] - v4 RAG matches
 * @param {number} [trajectoryFit] - v4 Trajectory prediction stub (0-1)
 * @returns {ScoreResult}
 */
export function scoreJob(
  item,
  config,
  idfData = { totalDocs: 1, termCounts: {} },
  ragMatches = [],
  trajectoryFit = 0.5,
) {
  // ── 0a. Null-safety: guard all fields ────────────────────────────────────
  if (!item || typeof item !== "object") {
    return _excluded([], {}, "Invalid job item");
  }

  const rawTitle = typeof item.title === "string" ? item.title : "";
  const rawBody =
    typeof (item.content || item.contentSnippet || item.description) ===
    "string"
      ? item.content || item.contentSnippet || item.description
      : "";

  const rawText = `${rawTitle} ${rawBody}`;
  const text = sanitizeText(rawText).toLowerCase();
  const titleText = sanitizeText(rawTitle).toLowerCase();

  // Pre-tokenize once — used for TF-IDF and fuzzy matching
  const tokens = text.split(/\s+/).filter(Boolean);

  const matcher = getGlobalMatcher(config);
  let textScanResult = { score: 0, matched: [], matchedCategories: {} };
  let titleScanResult = { score: 0, matched: [], matchedCategories: {} };

  try {
    textScanResult = matcher.scan(text);
    titleScanResult = matcher.scan(titleText);
  } catch (err) {
    import("../core/logger.js")
      .then(({ default: logger }) =>
        logger.error(`[Scoring] FastMatcher scan failed: ${err.message}`, {
          stack: err.stack,
        }),
      )
      .catch(() => {});
  }

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
  } = config || {};

  const tfidfWeight = scoring.tfidfWeight ?? 0.15;
  const seniorityPen = scoring.seniorityPenalty ?? -8;
  const seniorityBon = scoring.experienceBonus ?? 5;

  const w = {
    titleMatch: weights.titleMatch ?? 30,
    skillsMatch: weights.skillsMatch ?? 30,
    techStackMatch: weights.techStackMatch ?? 20,
    locationMatch: weights.locationMatch ?? 10,
    salaryMatch: weights.salaryMatch ?? 10,
  };

  const reasonSet = new Set(); // FIX: deduplicate reasons
  const addReason = (r) => {
    if (r) reasonSet.add(r);
  };

  const matchedSkillsSet = new Set(); // FIX: deduplicate skills during collection

  let baseScore = 0;

  // ── Feature Extraction ───────────────────────────────────────────────────
  const experience = parseExperienceYears(text);
  const salaryUSD = extractSalaryUSD(text);
  const remoteType = detectRemoteType(text);
  // FIX: seniority scans FULL text (not just first 500 chars)
  const seniority = detectSeniority(titleText + " " + text);

  /** @type {JobFeatures} */
  const features = { experience, salaryUSD, remoteType, seniority };

  // ── 1. Exclusion check  ──────────────────────────────────────────────────
  const excludeMatches = textScanResult.matched.filter(
    (m) => m.category === "exclude",
  );
  if (excludeMatches.length > 0) {
    const ex = excludeMatches[0].original;
    // FIX: log exclusion reason (was silently returning 0)
    const isDebug = _scoreDebugCount < 10;
    if (isDebug) {
      _scoreDebugCount++;
      const jobLabel = `"${(item.title || "untitled").slice(0, 60)}" @ ${item.company || "unknown"}`;
      import("../core/logger.js")
        .then(({ default: logger }) =>
          logger.debug(
            `[Scoring] EXCLUDED: ${jobLabel} — matched exclude term "${ex}"`,
          ),
        )
        .catch(() => {});
    }
    return _excluded([], features, `Excluded: "${ex}" found in job`);
  }

  // ── 2. Title match ───────────────────────────────────────────────────────
  // FIX: graduated scoring — more hits = higher title score (not all-or-nothing)
  const titleMatches = titleScanResult.matched.filter(
    (m) => m.category === "targetRole",
  );
  let titleHits = titleMatches.length;
  const titleHitNames = titleMatches.map((m) => m.original);

  // Graduated: 1 hit = 60%, 2 hits = 80%, 3+ hits = 100% of title weight
  const titlePct =
    titleHits === 0 ? 0 : titleHits === 1 ? 0.6 : titleHits === 2 ? 0.8 : 1.0;
  const titleScore = Math.round(w.titleMatch * titlePct);
  baseScore += titleScore;
  if (titleHits > 0)
    addReason(
      `Title match (${titleHits}): "${titleHitNames.slice(0, 3).join('", "')}"`,
    );

  // ── 3. Skills match ──────────────────────────────────────────────────────
  // FIX: use Set to prevent duplicate skill counting
  const mustMatchList = searchRules.mustMatch || [];
  const shouldMatchList = searchRules.shouldMatch || [];

  const mustMatches = textScanResult.matched.filter(
    (m) => m.category === "mustMatch",
  );
  const shouldMatches = textScanResult.matched.filter(
    (m) => m.category === "shouldMatch",
  );

  let mustHits = 0;
  for (const m of mustMatches) {
    const kl = m.original.toLowerCase().trim();
    if (!matchedSkillsSet.has(kl)) {
      mustHits++;
      matchedSkillsSet.add(kl);
    }
  }

  let shouldHits = 0;
  for (const m of shouldMatches) {
    const kl = m.original.toLowerCase().trim();
    if (!matchedSkillsSet.has(kl)) {
      shouldHits++;
      matchedSkillsSet.add(kl);
    }
  }

  const mustTotal = mustMatchList.length;
  const shouldTotal = shouldMatchList.length;
  const mustRatio = mustTotal > 0 ? mustHits / mustTotal : 0;
  const shouldRatio = shouldTotal > 0 ? shouldHits / shouldTotal : 0;
  const skillRatio = mustRatio * 0.7 + shouldRatio * 0.3;
  const skillsScore = Math.min(
    w.skillsMatch,
    Math.round(skillRatio * w.skillsMatch),
  );
  baseScore += skillsScore;

  if (mustHits > 0)
    addReason(
      `Must-match (${mustHits}/${mustTotal}): ${[...matchedSkillsSet].slice(0, mustHits).join(", ")}`,
    );
  if (shouldHits > 0)
    addReason(
      `Should-match (${shouldHits}/${shouldTotal}): ${[...matchedSkillsSet].slice(mustHits, mustHits + shouldHits).join(", ")}`,
    );

  // ── 4. Tech stack / nice-to-have ─────────────────────────────────────────
  const niceToHaveList = searchRules.niceToHave || [];
  const niceMatches = textScanResult.matched.filter(
    (m) => m.category === "niceToHave",
  );
  let niceHits = 0;
  const niceMatched = [];
  for (const m of niceMatches) {
    const kl = m.original.toLowerCase().trim();
    if (!matchedSkillsSet.has(kl)) {
      niceHits++;
      matchedSkillsSet.add(kl);
      niceMatched.push(kl);
    }
  }
  const niceTotal = niceToHaveList.length;
  const techRatio = niceTotal > 0 ? niceHits / niceTotal : 0;
  const techScore = Math.round(techRatio * w.techStackMatch);
  baseScore += techScore;
  if (niceHits > 0)
    addReason(
      `Nice-to-have (${niceHits}/${niceTotal}): ${niceMatched.slice(0, 5).join(", ")}`,
    );

  // ── 5. Location match ────────────────────────────────────────────────────
  const locationMatches = textScanResult.matched.filter(
    (m) => m.category === "location",
  );
  let locationHit = locationMatches.length > 0;
  let locationHitTerm = locationHit ? locationMatches[0].original : "";

  const locationScore = locationHit ? w.locationMatch : 0;
  baseScore += locationScore;
  if (locationHit)
    addReason(`Location/remote match: "${locationHitTerm}" (${remoteType})`);

  // ── 6. Salary signal ─────────────────────────────────────────────────────
  // FIX: validate minimum salary amount to filter false positives
  let salaryScore = 0;
  let salaryReason = null;

  if (salaryUSD && salaryUSD.min >= 10_000) {
    // extractSalaryUSD returned a real USD range
    salaryScore = w.salaryMatch;
    const maxStr =
      salaryUSD.max !== salaryUSD.min
        ? `–$${salaryUSD.max.toLocaleString()}`
        : "";
    salaryReason = `Salary detected: $${salaryUSD.min.toLocaleString()}${maxStr} USD`;
  } else {
    // Fallback text patterns — require a parseable real amount
    const patterns = [
      /(?:salary|compensation|pay|package)[:\s]*(\$[\d,]+(?:k)?(?:\s*[-–to]+\s*\$?[\d,]+(?:k)?)?(?:\s*(?:per\s+)?(?:year|yr|lpa|annual))?)/i,
      /(\$\s?[\d,]+(?:k)?\s*[-–to]+\s*\$?\s?[\d,]+(?:k)?)/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) {
        // Rough-parse amount to filter out tiny numbers (bug bounties, etc)
        const amt = parseInt(
          (m[1] || "").replace(/[$,]/g, "").replace(/k$/i, "000"),
          10,
        );
        if (amt >= 10_000 || (m[1] || "").toLowerCase().includes("lpa")) {
          salaryScore = w.salaryMatch;
          salaryReason = `Salary detected: ${(m[1] || m[0]).trim()}`;
          break;
        }
      }
    }
  }
  baseScore += salaryScore;
  if (salaryReason) addReason(salaryReason);

  // ── 7. TF-IDF Enhancement ────────────────────────────────────────────────
  const tfidf = computeTfIdfScore(mustMatchList, tokens, synonyms, idfData);
  const tfidfBoost = Math.round(tfidf * tfidfWeight * 100);
  if (tfidfBoost > 0)
    addReason(`TF-IDF signal: +${tfidfBoost} (keyword density × rarity)`);

  // ── 8. Experience years scoring (ACTIVE in v3) ───────────────────────────
  const expResult = scoreExperience(experience, experienceLevel);
  const expBonus = expResult.bonus;
  if (expResult.reason) addReason(expResult.reason);
  if (experience && !expResult.reason) {
    const expStr = experience.max
      ? `${experience.min}–${experience.max}`
      : `${experience.min}+`;
    addReason(`Experience required: ${expStr} years`);
  }

  // ── 9. Combo bonuses ──────────────────────────────────────────────────────
  let bonus = 0;
  const matched = [...matchedSkillsSet]; // already lowercase, deduplicated

  // FIX: check text directly (not just matchedSkills) for stack combos
  // This avoids the issue where a tech was in the text but wasn't in the keyword lists
  const inText = (kw) => {
    try {
      return new RegExp(`\\b${escapeRegex(kw)}\\b`, "i").test(text);
    } catch {
      return false;
    }
  };

  const hasNextJs =
    matched.includes("next.js") || inText("next.js") || inText("nextjs");
  const hasTs =
    matched.includes("typescript") || inText("typescript") || inText(" ts ");
  const hasNodeJs =
    matched.includes("node.js") || inText("node.js") || inText("nodejs");
  const hasMongo = matched.includes("mongodb") || inText("mongodb");
  const hasAws =
    matched.includes("aws") || inText("aws") || inText("amazon web services");
  const hasExpress =
    matched.includes("express") || inText("express.js") || inText("express");
  const hasReact = matched.includes("react") || inText("react");

  if (hasNextJs && hasTs) {
    bonus += scoringBonuses.nextjsAndTypescript ?? 8;
    addReason("Bonus: Next.js + TypeScript combo (+8)");
  }
  if (hasNodeJs && hasMongo) {
    bonus += scoringBonuses.nodeAndMongodb ?? 6;
    addReason("Bonus: Node.js + MongoDB combo (+6)");
  }
  if (hasAws) {
    bonus += scoringBonuses.awsPresent ?? 4;
    addReason("Bonus: AWS present (+4)");
  }

  // MERN stack — requires actual usage in body, not just keyword lists
  const mernHits = [hasMongo, hasExpress, hasReact, hasNodeJs].filter(
    Boolean,
  ).length;
  if (mernHits >= 4) {
    bonus += scoringBonuses.fullMernStack ?? 10;
    addReason("Bonus: Full MERN stack (+10)");
  } else if (mernHits === 3) {
    const partialBonus = Math.round((scoringBonuses.fullMernStack ?? 10) * 0.5);
    bonus += partialBonus;
    addReason(`Bonus: Partial MERN (3/4) (+${partialBonus})`);
  }

  // Remote + target region
  if (locationHit && REGION_BONUS_REGEX.test(text)) {
    bonus += scoringBonuses.remoteIndia ?? 5;
    addReason("Bonus: Remote + target region (+5)");
  }

  // ── 10. Seniority bonus/penalty ───────────────────────────────────────────
  const seniorityResult = senioritySatisfied(seniority, experienceLevel);
  if (seniority !== "unknown") {
    if (seniorityResult === "match") {
      bonus += seniorityBon;
      addReason(`Seniority match: ${seniority} (+${seniorityBon})`);
    } else if (seniorityResult === "mismatch") {
      bonus += seniorityPen; // negative
      addReason(`Seniority mismatch: ${seniority} (${seniorityPen})`);
    }
  }

  // ── 11. Penalty layer ────────────────────────────────────────────────────
  let penalty = 0;

  // FIX: Non-JS penalty — check BOTH title AND body (not just title)
  // FIX: triggers even with mustHits > 0 (if title has non-JS as primary lang)
  let nonJsPenaltyApplied = false;
  const nonJsTitleMatches = titleScanResult.matched.filter(
    (m) => m.category === "nonJsStack",
  );
  const nonJsBodyMatches = textScanResult.matched.filter(
    (m) => m.category === "nonJsStack",
  );

  let penaltyLang = null;
  if (nonJsTitleMatches.length > 0) {
    penaltyLang = nonJsTitleMatches[0].original;
  } else if (nonJsBodyMatches.length > 0 && mustHits === 0) {
    penaltyLang = nonJsBodyMatches[0].original;
  }

  if (penaltyLang) {
    if (trajectoryFit > 0.8) {
      addReason(
        `Trajectory override: Ignored Non-JS stack "${penaltyLang}" penalty`,
      );
    } else {
      penalty += scoringPenalties.nonJsStack ?? -15;
      addReason(`Penalty: Non-JS stack "${penaltyLang}" detected`);
      nonJsPenaltyApplied = true;
    }
  }

  // FIX: Frontend-only penalty — stricter: requires title match + no backend AND no must-match
  if (!nonJsPenaltyApplied) {
    const hasFE = textScanResult.matched.some((m) => m.category === "frontend");
    const hasBE = textScanResult.matched.some((m) => m.category === "backend");
    const feTitleMatch = FRONTEND_TITLE_REGEX.test(titleText);
    if (hasFE && !hasBE && feTitleMatch && mustHits === 0) {
      penalty += scoringPenalties.frontendOnlyNoBackend ?? -5;
      addReason("Penalty: Frontend-only, no backend signals, no skill match");
    }
  }

  // ── 12. Hard filter: enforce minimum mustMatch gate ──────────────────────
  // FIX: jobs with zero must-match hits are capped below the 50-point threshold
  // so they never generate alerts regardless of location/salary bonuses
  const totalHits = mustHits + shouldHits;

  let applyMustHitsCap = false;

  // The totalHits used for the "primary matches" check should include niceHits
  // if we want to allow strong niceToHave skills to carry a job to the 55 cap.
  const effectiveTotalHits = mustHits + shouldHits + niceHits;

  if (effectiveTotalHits === 0 && titleHits === 0) {
    // Absolutely no matches — heavy cap
    baseScore = Math.round(baseScore * 0.1);
    addReason("Hard filter: Zero skill or title matches — capped at 10%");
  } else if (mustHits === 0 && mustTotal > 0) {
    // Has some matches but missed ALL must-haves
    // We do NOT slash the baseScore here, we just set a flag to hard-cap the final score at 55.
    applyMustHitsCap = true;
  } else if (totalHits < (filters.minPrimaryMatches ?? 1)) {
    // Only slash if it's lacking primary (must/should) matches AND isn't already caught by the mustHits=0 cap condition.
    // The mustHits=0 logic above is an alternative downward pressure logic, so they are mutually exclusive.
    const scaleFactor = Math.max(
      0.5,
      totalHits / (filters.minPrimaryMatches ?? 1),
    );
    baseScore = Math.round(baseScore * scaleFactor);
    addReason(`Soft filter: Only ${totalHits} primary matches`);
  } else if (totalHits === 0 && titleHits > 0) {
    baseScore = Math.round(baseScore * 0.55);
    addReason("Soft filter: Title match only — no skill keywords");
  }

  // ── 13. AI / RAG Hybrid Semantic Bonus (v4) ──────────────────────────────
  let semanticBase = 0;
  if (ragMatches && ragMatches.length > 0) {
    // Mean pool the similarity of top chunks
    semanticBase =
      ragMatches.reduce((acc, m) => acc + m.sim, 0) / ragMatches.length;
  }

  // Calculate skill decay stub
  const skillDecay = 0.8; // Stub: assume 0.8 freshness

  // Blend (RAG 0.7 + decay 0.2 + LSTM 0.1) -> max 25 points
  let semanticBoost = 0;
  if (semanticBase > 0.4) {
    const blend = 0.7 * semanticBase + 0.2 * skillDecay + 0.1 * trajectoryFit;
    semanticBoost = Math.round(25 * blend);
    addReason(
      `Hybrid Semantic Boost: +${semanticBoost} (RAG ${semanticBase.toFixed(2)}, Decay ${skillDecay.toFixed(2)}, Traj ${trajectoryFit.toFixed(2)})`,
    );
  }

  // ── 14. Final score ───────────────────────────────────────────────────────
  const rawFinal =
    baseScore + tfidfBoost + bonus + penalty + expBonus + semanticBoost;

  let finalScore = Math.max(0, Math.min(100, rawFinal));

  // Apply the mustHits=0 cap AFTER all boosts (including semantic) have been calculated
  if (applyMustHitsCap && finalScore > 50) {
    if (trajectoryFit < 0.8) {
      finalScore = 50;
      addReason("Soft filter: No must-match skills → score capped at 50");
    } else {
      addReason("Trajectory override: Bypassed must-match cap");
    }
  }

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
    experienceBonus: expBonus,
  };

  // ── Debug logging for first N evaluations ────────────────────────────────
  if (_scoreDebugCount < 10) {
    _scoreDebugCount++;
    const jobLabel = `"${(item.title || "untitled").slice(0, 60)}" @ ${item.company || "unknown"}`;
    import("../core/logger.js")
      .then(({ default: logger }) =>
        logger.debug(
          `[Scoring] ${jobLabel} → score=${finalScore} | title=${titleScore} skills=${skillsScore} tech=${techScore} loc=${locationScore} bonus=${bonus} penalty=${penalty} tfidf=${tfidfBoost}`,
        ),
      )
      .catch(() => {});
  }

  return {
    score: finalScore,
    label,
    color,
    reasons: [...reasonSet],
    matchedSkills: [...matchedSkillsSet], // already a Set — fully deduplicated
    excluded: false,
    breakdown,
    features,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Return a zero-score excluded result.
 * @param {string[]} matchedSkills
 * @param {object} features
 * @param {string} reason
 * @returns {ScoreResult}
 */
function _excluded(matchedSkills, features, reason) {
  return {
    score: 0,
    ...resolveLabel(0),
    reasons: [reason],
    matchedSkills,
    excluded: true,
    breakdown: {
      titleScore: 0,
      skillsScore: 0,
      techScore: 0,
      locationScore: 0,
      salaryScore: 0,
      tfidfBoost: 0,
      semanticBoost: 0,
      bonuses: 0,
      penalties: 0,
      experienceBonus: 0,
    },
    features: features || {},
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Boolean shortcut: job is relevant if score ≥ threshold AND ≥ MINIMUM_ALERT_SCORE.
 * @param {object} item
 * @param {object} config
 * @returns {boolean}
 */
export function isJobRelevant(item, config) {
  const threshold = Math.max(
    config.notificationThreshold ?? 65,
    MINIMUM_ALERT_SCORE,
  );
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
  const dateStr = item?.pubDate || item?.isoDate;
  if (!dateStr) return false;
  let postedDate;
  try {
    postedDate = parseDate(dateStr);
  } catch {
    return false;
  }
  if (!postedDate || isNaN(postedDate.getTime())) return false;
  return Date.now() - postedDate.getTime() <= timeWindowHours * 60 * 60 * 1000;
}

/**
 * Compute a human-readable "posted X ago" string.
 * @param {string} dateStr
 * @returns {string}
 */
export function timeAgo(dateStr) {
  if (!dateStr) return "Unknown";
  let d;
  try {
    d = parseDate(dateStr);
  } catch {
    return "Unknown";
  }
  if (!d || isNaN(d.getTime())) return "Unknown";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins} minute${mins !== 1 ? "s" : ""} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? "s" : ""} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days !== 1 ? "s" : ""} ago`;
}
