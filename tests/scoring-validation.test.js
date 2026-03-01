/**
 * @file tests/scoring-validation.test.js
 * @jest-environment node
 * @description Structured Scoring Validation — validates each scoring layer
 * independently and tests the 4 scoring cases from e2etesting.md:
 *
 *   Case A: Perfect Match (all criteria)
 *   Case B: Title Match Only (skills weak, location mismatch)
 *   Case C: Skills Match Without Title Match
 *   Case D: Strong Tech Stack But Wrong Seniority
 *
 * Also validates score transparency: breakdown, reasons, features.
 */

import { jest } from '@jest/globals';

jest.unstable_mockModule('../src/core/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        evaluated: jest.fn(),
        skipped: jest.fn(),
        notified: jest.fn(),
    },
}));

const { scoreJob } = await import('../src/scoring/relevance.js');

const CONFIG = {
    searchRules: {
        mustMatch: ['javascript', 'typescript', 'react', 'next.js', 'node.js'],
        shouldMatch: ['mongodb', 'express', 'aws', 'docker'],
        niceToHave: ['redis', 'ci/cd', 'microservices'],
        exclude: ['wordpress', 'php', 'dotnet'],
    },
    targetRoles: ['full stack developer', 'software engineer', 'frontend engineer', 'backend engineer'],
    synonyms: {
        react: ['reactjs', 'react.js'],
        'next.js': ['nextjs', 'next js'],
        'node.js': ['nodejs', 'node js'],
        typescript: ['ts'],
        javascript: ['js', 'ecmascript'],
    },
    weights: { titleMatch: 30, skillsMatch: 30, techStackMatch: 20, locationMatch: 10, salaryMatch: 10 },
    scoringBonuses: { nextjsAndTypescript: 8, nodeAndMongodb: 6, awsPresent: 4, fullMernStack: 10, remoteIndia: 5 },
    scoringPenalties: { nonJsStack: -15, frontendOnlyNoBackend: -5, differentPrimaryLanguage: -10 },
    scoring: { tfidfWeight: 0.15, experienceBonus: 5, seniorityPenalty: -8 },
    notificationThreshold: 50,
    filters: { workPreference: ['remote'], locations: ['india'], minSalaryUSD: 0, minPrimaryMatches: 1 },
    locationKeywords: ['remote'],
    experienceLevel: ['junior', 'mid-level', '1+ years', '2+ years', '3+ years'],
    fuzzyThreshold: 0.82,
};

// ── Scoring Layer Breakdown Validation ───────────────────────────────────────

describe('Scoring Layer Breakdown — each component testable', () => {
    test('1. Exclusion Guard: excluded terms block the job', () => {
        const result = scoreJob({
            title: 'WordPress PHP Developer',
            content: 'WordPress and PHP expert needed.',
        }, CONFIG);
        expect(result.excluded).toBe(true);
        expect(result.score).toBe(0);
    });

    test('2. Title Match: job title containing a target role scores higher', () => {
        const withRole = scoreJob({
            title: 'Remote Full Stack Developer',
            content: 'javascript react node.js',
        }, CONFIG);
        const withoutRole = scoreJob({
            title: 'Remote Technical Person',
            content: 'javascript react node.js',
        }, CONFIG);
        expect(withRole.breakdown.titleScore).toBeGreaterThan(withoutRole.breakdown.titleScore);
    });

    test('3. Skills Match: must-match terms increase skills score', () => {
        const withSkills = scoreJob({
            title: 'Developer',
            content: 'javascript typescript react next.js node.js remote',
        }, CONFIG);
        const withoutSkills = scoreJob({
            title: 'Developer',
            content: 'general development work remote',
        }, CONFIG);
        expect(withSkills.breakdown.skillsScore).toBeGreaterThan(withoutSkills.breakdown.skillsScore);
    });

    test('4. Tech Stack Match: nice-to-have terms add tech score', () => {
        const withTech = scoreJob({
            title: 'Developer',
            content: 'javascript react redis ci/cd microservices remote',
        }, CONFIG);
        expect(withTech.breakdown.techScore).toBeGreaterThan(0);
    });

    test('5. Location Match: remote keyword adds location score', () => {
        const withRemote = scoreJob({
            title: 'Developer',
            content: 'javascript react remote',
        }, CONFIG);
        const withoutRemote = scoreJob({
            title: 'Developer',
            content: 'javascript react on-site only',
        }, CONFIG);
        expect(withRemote.breakdown.locationScore).toBeGreaterThan(withoutRemote.breakdown.locationScore);
    });

    test('6. Salary Match: salary in content adds salary score', () => {
        const withSalary = scoreJob({
            title: 'Developer',
            content: 'javascript react remote salary $80k-$120k per year',
        }, CONFIG);
        expect(withSalary.breakdown.salaryScore).toBeGreaterThan(0);
        expect(withSalary.features.salaryUSD).not.toBeNull();
    });

    test('7. TF-IDF Boost: keyword-dense content gets boost', () => {
        const dense = scoreJob({
            title: 'React Developer',
            content: 'react react react react react javascript typescript node.js react developer react engineer',
        }, CONFIG);
        expect(dense.breakdown.tfidfBoost).toBeGreaterThan(0);
    });

    test('8. Combo Bonuses: Next.js + TypeScript triggers bonus', () => {
        const result = scoreJob({
            title: 'Full Stack Developer',
            content: 'next.js typescript react node.js remote',
        }, CONFIG);
        expect(result.reasons).toContainEqual(expect.stringContaining('Next.js + TypeScript'));
        expect(result.breakdown.bonuses).toBeGreaterThan(0);
    });

    test('9. Seniority Alignment: junior/mid-level matches user preference', () => {
        const junior = scoreJob({
            title: 'Junior React Developer',
            content: 'javascript react typescript. Entry level. Remote.',
        }, CONFIG);
        expect(junior.features.seniority).toBe('junior');
    });

    test('10. Penalty Layer: non-JS primary language penalty', () => {
        const result = scoreJob({
            title: 'Remote Python Developer',
            content: 'python django flask',
        }, CONFIG);
        expect(result.reasons).toContainEqual(expect.stringContaining('Penalty'));
    });

    test('11. AI Semantic Boost: high similarity score increases final score', () => {
        const base = scoreJob({
            title: 'Frontend Engineer',
            content: 'react typescript remote',
        }, CONFIG, { totalDocs: 1, termCounts: {} });

        const withAi = scoreJob({
            title: 'Frontend Engineer',
            content: 'react typescript remote',
        }, CONFIG, { totalDocs: 1, termCounts: {} }, 0.9);

        expect(withAi.score).toBeGreaterThanOrEqual(base.score);
    });
});

// ── Scoring Test Case A: Perfect Match ───────────────────────────────────────

describe('Scoring Case A — Perfect Match', () => {
    const perfectJob = {
        title: 'Remote Full Stack Developer',
        content: 'JavaScript, TypeScript, React, Next.js, Node.js, MongoDB, Express, AWS, Docker, Redis, CI/CD. Fully remote. India. Salary $100k-$150k. Junior / mid-level welcome.',
    };

    test('structured score is near maximum', () => {
        const result = scoreJob(perfectJob, CONFIG);
        expect(result.score).toBeGreaterThanOrEqual(75);
    });

    test('all scoring layers contribute', () => {
        const result = scoreJob(perfectJob, CONFIG);
        expect(result.breakdown.titleScore).toBeGreaterThan(0);
        expect(result.breakdown.skillsScore).toBeGreaterThan(0);
        expect(result.breakdown.techScore).toBeGreaterThan(0);
        expect(result.breakdown.locationScore).toBeGreaterThan(0);
        expect(result.breakdown.salaryScore).toBeGreaterThan(0);
        expect(result.breakdown.bonuses).toBeGreaterThan(0);
    });

    test('AI boost is minimal (already high base score)', () => {
        const base = scoreJob(perfectJob, CONFIG);
        const withAi = scoreJob(perfectJob, CONFIG, { totalDocs: 1, termCounts: {} }, 0.95);
        // The boost should be small relative to the already-high base
        expect(withAi.score - base.score).toBeLessThan(15);
    });

    test('exceeds threshold → alert triggered', () => {
        const result = scoreJob(perfectJob, CONFIG);
        expect(result.score).toBeGreaterThanOrEqual(CONFIG.notificationThreshold);
    });
});

// ── Scoring Test Case B: Title Match Only ────────────────────────────────────

describe('Scoring Case B — Title Match Only', () => {
    const titleOnlyJob = {
        title: 'Remote Full Stack Developer', // Matches targetRoles
        content: 'We are a creative agency. Photoshop, Figma, Sketch.', // No tech skills
    };

    test('medium structured score from title only', () => {
        const result = scoreJob(titleOnlyJob, CONFIG);
        expect(result.score).toBeGreaterThan(10);
        expect(result.score).toBeLessThan(60);
    });

    test('title score high, skills score low', () => {
        const result = scoreJob(titleOnlyJob, CONFIG);
        expect(result.breakdown.titleScore).toBeGreaterThan(0);
        expect(result.breakdown.skillsScore).toBe(0);
    });

    test('likely below threshold → no alert', () => {
        const result = scoreJob(titleOnlyJob, CONFIG);
        expect(result.score).toBeLessThan(CONFIG.notificationThreshold);
    });
});

// ── Scoring Test Case C: Skills Match Without Title Match ────────────────────

describe('Scoring Case C — Skills Match Without Title Match', () => {
    const skillsOnlyJob = {
        title: 'Technical Lead — Platform Team', // Not in targetRoles
        content: 'Deep expertise in JavaScript, TypeScript, React, Node.js, MongoDB. Remote. $120k.',
    };

    test('moderate structured score from skills', () => {
        const result = scoreJob(skillsOnlyJob, CONFIG);
        expect(result.score).toBeGreaterThan(30);
    });

    test('skills score high, title score low', () => {
        const result = scoreJob(skillsOnlyJob, CONFIG);
        expect(result.breakdown.skillsScore).toBeGreaterThan(0);
        // Title may still partially match via fuzzy
    });

    test('AI boost could push it above threshold', () => {
        const base = scoreJob(skillsOnlyJob, CONFIG);
        const withAi = scoreJob(skillsOnlyJob, CONFIG, { totalDocs: 1, termCounts: {} }, 0.9);
        expect(withAi.score).toBeGreaterThanOrEqual(base.score);
    });
});

// ── Scoring Test Case D: Strong Tech But Wrong Seniority ─────────────────────

describe('Scoring Case D — Strong Tech Stack But Wrong Seniority', () => {
    const seniorJob = {
        title: 'Staff Engineer — Platform Architecture',
        content: 'JavaScript, TypeScript, React, Node.js. 10+ years required. Staff/Principal level only. Remote.',
    };

    test('seniority detected as senior/lead', () => {
        const result = scoreJob(seniorJob, CONFIG);
        expect(['senior', 'lead']).toContain(result.features.seniority);
    });

    test('score is penalized for seniority mismatch', () => {
        const result = scoreJob(seniorJob, CONFIG);
        // Should be lower than a perfect match job
        const perfectResult = scoreJob({
            title: 'Remote Full Stack Developer',
            content: 'JavaScript TypeScript React Node.js Remote. Junior/mid-level.',
        }, CONFIG);
        expect(result.score).toBeLessThanOrEqual(perfectResult.score);
    });
});

// ── Score Transparency Validation ────────────────────────────────────────────

describe('Score Transparency — explainability', () => {
    test('score result includes all layer scores', () => {
        const result = scoreJob({
            title: 'React Developer',
            content: 'javascript typescript react node.js. remote. $90k.',
        }, CONFIG);

        // Breakdown
        expect(result.breakdown).toHaveProperty('titleScore');
        expect(result.breakdown).toHaveProperty('skillsScore');
        expect(result.breakdown).toHaveProperty('techScore');
        expect(result.breakdown).toHaveProperty('locationScore');
        expect(result.breakdown).toHaveProperty('salaryScore');
        expect(result.breakdown).toHaveProperty('tfidfBoost');
        expect(result.breakdown).toHaveProperty('bonuses');
        expect(result.breakdown).toHaveProperty('penalties');

        // Features
        expect(result.features).toHaveProperty('experience');
        expect(result.features).toHaveProperty('salaryUSD');
        expect(result.features).toHaveProperty('remoteType');
        expect(result.features).toHaveProperty('seniority');
    });

    test('reasons array explains the match', () => {
        const result = scoreJob({
            title: 'Full Stack Developer',
            content: 'react next.js typescript node.js mongodb remote india',
        }, CONFIG);

        expect(Array.isArray(result.reasons)).toBe(true);
        expect(result.reasons.length).toBeGreaterThan(0);
    });

    test('label/color correspond to score range', () => {
        const high = scoreJob({
            title: 'Remote Full Stack Developer',
            content: 'javascript typescript react next.js node.js mongodb express aws docker redis remote india $120k',
        }, CONFIG);
        expect(high.label).toMatch(/Excellent|Strong/);

        const low = scoreJob({
            title: 'Office Manager',
            content: 'Microsoft Office, scheduling, admin',
        }, CONFIG);
        expect(low.label).toMatch(/Weak Match|Poor Match/);
    });
});
