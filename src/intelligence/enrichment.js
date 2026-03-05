/**
 * @module enrichment
 * @description Job metadata enrichment pipeline.
 *
 * Takes a normalized RawJob and a ScoreResult from relevance.js and maps
 * them into a richer EnrichedJob shape with structured intelligence fields:
 *   - techStack[]         — detected technology keywords
 *   - seniorityLevel      — junior | mid | senior | lead
 *   - salaryRange         — { min, max } in USD (if detected)
 *   - remoteType          — remote | hybrid | onsite | unknown
 *   - visaSponsorship     — boolean
 *   - industryCluster     — fintech | healthtech | devtools | ai_ml | etc.
 *   - hiringUrgencyScore  — 0-100, based on posting language signals
 *
 * All extractors are regex-based and run synchronously (no AI cost).
 */

// ── Tech Stack Detection ──────────────────────────────────────────────────────

/**
 * Ordered map of technology names to their detection patterns.
 * Keys are canonical names; values are regex patterns to match.
 * @type {Array<{ name: string, pattern: RegExp }>}
 */
const TECH_PATTERNS = [
    // Languages
    { name: 'JavaScript',  pattern: /\b(javascript|js|es6|ecmascript)\b/i },
    { name: 'TypeScript',  pattern: /\b(typescript|ts)\b/i },
    { name: 'Python',      pattern: /\bpython\b/i },
    { name: 'Go',          pattern: /\b(golang|go\b)/i },
    { name: 'Rust',        pattern: /\brust\b/i },
    { name: 'Java',        pattern: /\bjava\b/i },
    { name: 'Ruby',        pattern: /\bruby\b/i },
    { name: 'PHP',         pattern: /\bphp\b/i },
    // Frameworks & libraries
    { name: 'React',       pattern: /\b(react\.?js|reactjs|react)\b/i },
    { name: 'Next.js',     pattern: /\bnext\.?js\b/i },
    { name: 'Vue',         pattern: /\bvue\.?js\b/i },
    { name: 'Angular',     pattern: /\bangular\b/i },
    { name: 'Node.js',     pattern: /\bnode\.?js\b/i },
    { name: 'NestJS',      pattern: /\bnest\.?js\b/i },
    { name: 'Express',     pattern: /\bexpress\.?js\b/i },
    { name: 'GraphQL',     pattern: /\bgraphql\b/i },
    { name: 'tRPC',        pattern: /\btrpc\b/i },
    // Databases
    { name: 'PostgreSQL',  pattern: /\b(postgresql|postgres|psql)\b/i },
    { name: 'MongoDB',     pattern: /\b(mongodb|mongoose)\b/i },
    { name: 'MySQL',       pattern: /\bmysql\b/i },
    { name: 'Redis',       pattern: /\bredis\b/i },
    { name: 'Prisma',      pattern: /\bprisma\b/i },
    // Cloud & infra
    { name: 'AWS',         pattern: /\b(aws|amazon web services)\b/i },
    { name: 'GCP',         pattern: /\b(gcp|google cloud)\b/i },
    { name: 'Azure',       pattern: /\bazure\b/i },
    { name: 'Docker',      pattern: /\bdocker\b/i },
    { name: 'Kubernetes',  pattern: /\b(kubernetes|k8s)\b/i },
    { name: 'Terraform',   pattern: /\bterraform\b/i },
    // Testing & tooling
    { name: 'Jest',        pattern: /\bjest\b/i },
    { name: 'Cypress',     pattern: /\bcypress\b/i },
    { name: 'GitHub Actions', pattern: /\bgithub actions\b/i },
    // Styling
    { name: 'TailwindCSS', pattern: /\b(tailwind|tailwindcss)\b/i },
];

/**
 * Extract technology stack from job text.
 * @param {string} text - Full job description (lowercase-safe).
 * @returns {string[]} Deduplicated list of detected tech names.
 */
export function detectTechStack(text) {
    if (!text) return [];
    const found = [];
    for (const { name, pattern } of TECH_PATTERNS) {
        if (pattern.test(text)) found.push(name);
    }
    return found;
}

// ── Visa Sponsorship Detection ────────────────────────────────────────────────

/** Patterns indicating visa sponsorship is available. */
const VISA_POSITIVE = /\b(visa sponsorship|h[- ]?1b|work authorization provided|we sponsor|sponsoring visas|sponsorship available)\b/i;

/** Patterns indicating visa sponsorship is NOT available. */
const VISA_NEGATIVE = /\b(no visa|cannot sponsor|not able to sponsor|unable to sponsor|must be authorized|us citizen only|citizen or permanent resident)\b/i;

/**
 * Detect whether the job offers visa sponsorship.
 * Returns true only when a positive signal is detected AND no negative override.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function detectVisaSponsorship(text) {
    if (!text) return false;
    return VISA_POSITIVE.test(text) && !VISA_NEGATIVE.test(text);
}

// ── Industry Cluster Detection ────────────────────────────────────────────────

/**
 * Ordered list of industry clusters with their detection patterns.
 * First match wins — order from most specific to most generic.
 */
const INDUSTRY_CLUSTERS = [
    { cluster: 'ai_ml',      pattern: /\b(machine learning|deep learning|llm|large language model|nlp|computer vision|mlops|ai engineer|artificial intelligence)\b/i },
    { cluster: 'web3',       pattern: /\b(blockchain|web3|defi|nft|smart contract|solidity|ethereum|crypto)\b/i },
    { cluster: 'fintech',    pattern: /\b(fintech|payments|banking|lending|insurtech|trading|financial technology)\b/i },
    { cluster: 'healthtech', pattern: /\b(healthtech|health tech|medtech|telemedicine|ehr|fhir|clinical|patient data)\b/i },
    { cluster: 'edtech',     pattern: /\b(edtech|ed-tech|e-learning|learning management|lms|online education)\b/i },
    { cluster: 'devtools',   pattern: /\b(developer tools|devtools|sdk|api platform|cli|open.?source|oss)\b/i },
    { cluster: 'ecommerce',  pattern: /\b(ecommerce|e-commerce|shopify|marketplace|retail tech|checkout)\b/i },
    { cluster: 'saas',       pattern: /\b(saas|b2b software|enterprise software|platform)\b/i },
    { cluster: 'infra',      pattern: /\b(infrastructure|platform engineering|cloud native|devops|site reliability|sre)\b/i },
    { cluster: 'security',   pattern: /\b(cybersecurity|infosec|appsec|zero trust|soc analyst|penetration testing)\b/i },
    { cluster: 'other',      pattern: /.*/ }, // catch-all
];

/**
 * Detect which industry cluster a job belongs to.
 * @param {string} title
 * @param {string} text
 * @returns {string} Cluster identifier (e.g. 'fintech', 'ai_ml', 'saas')
 */
export function detectIndustryCluster(title, text) {
    const combined = `${title} ${text}`;
    for (const { cluster, pattern } of INDUSTRY_CLUSTERS) {
        if (pattern.test(combined)) return cluster;
    }
    return 'other';
}

// ── Hiring Urgency Score ──────────────────────────────────────────────────────

const URGENCY_SIGNALS = [
    { pattern: /\b(immediate(ly)?|asap|start immediately|urgent|urgent(ly)?)\b/i, points: 30 },
    { pattern: /\b(interviewing now|rolling interviews|available immediately)\b/i, points: 25 },
    { pattern: /\b(we('re| are) hiring now|actively hiring|currently hiring)\b/i, points: 20 },
    { pattern: /\b(contract|contract-to-hire|short.term)\b/i,                     points: 10 },
    { pattern: /\b(full.time|permanent)\b/i,                                        points: 5  },
];

/**
 * Score how urgent the hiring signal is (0–100).
 * @param {string} text
 * @returns {number} 0–100
 */
export function detectHiringUrgencyScore(text) {
    if (!text) return 0;
    let score = 0;
    for (const { pattern, points } of URGENCY_SIGNALS) {
        if (pattern.test(text)) score += points;
    }
    return Math.min(100, score);
}

// ── Main Enrichment Entry Point ───────────────────────────────────────────────

/**
 * @typedef {object} EnrichedJob
 * @property {string}   id
 * @property {string}   title
 * @property {string}   company
 * @property {string}   link
 * @property {string}   content
 * @property {string}   contentSnippet
 * @property {string}   pubDate
 * @property {string}   isoDate
 * @property {string[]} categories
 * @property {string}   sourceUrl
 * @property {string}   sourceName
 * @property {string}   sourceType
 * @property {string}   content_hash
 * @property {string}   similarity_hash
 * @property {string[]} techStack
 * @property {string}   seniorityLevel
 * @property {{ min: number, max: number } | null} salaryRange
 * @property {string}   remoteType
 * @property {boolean}  visaSponsorship
 * @property {string}   industryCluster
 * @property {number}   hiringUrgencyScore
 * @property {number}   score
 * @property {string[]} matchedSkills
 */

/**
 * Enrich a normalized RawJob using the structured intelligence extracted
 * during scoring. Merges ScoreResult.features with new metadata extractors.
 *
 * @param {object} rawJob     - Output of normalizeJob() from schema.js
 * @param {object} scoreResult - Output of scoreJob() from relevance.js
 * @returns {EnrichedJob}
 */
export function enrichJob(rawJob, scoreResult) {
    const text = `${rawJob.title || ''} ${rawJob.content || ''}`;
    const features = scoreResult?.features || {};

    const techStack       = detectTechStack(text);
    const visaSponsorship = detectVisaSponsorship(text);
    const industryCluster = detectIndustryCluster(rawJob.title || '', rawJob.content || '');
    const hiringUrgency   = detectHiringUrgencyScore(text);

    // Map ScoreResult.features.salaryUSD → salaryRange shape
    let salaryRange = null;
    if (features.salaryUSD) {
        salaryRange = { min: features.salaryUSD.min, max: features.salaryUSD.max };
    }

    return {
        // Base RawJob fields
        id:              rawJob.id,
        title:           rawJob.title,
        company:         rawJob.company,
        link:            rawJob.link,
        content:         rawJob.content,
        contentSnippet:  rawJob.contentSnippet,
        pubDate:         rawJob.pubDate,
        isoDate:         rawJob.isoDate,
        categories:      rawJob.categories,
        sourceUrl:       rawJob.sourceUrl,
        sourceName:      rawJob.sourceName,
        sourceType:      rawJob.sourceType,
        content_hash:    rawJob.content_hash,
        similarity_hash: rawJob.similarity_hash || null,
        // Enrichment
        techStack,
        seniorityLevel:      features.seniority    || 'unknown',
        salaryRange,
        remoteType:          features.remoteType   || 'unknown',
        visaSponsorship,
        industryCluster,
        hiringUrgencyScore:  hiringUrgency,
        // Score data
        score:          scoreResult?.score        ?? 0,
        matchedSkills:  scoreResult?.matchedSkills ?? [],
    };
}
