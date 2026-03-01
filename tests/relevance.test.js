/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';

// Mock the logger to prevent actual file I/O during tests
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

const { scoreJob, isJobRelevant, isNewJob, timeAgo } = await import('../src/scoring/relevance.js');

/** Minimal config for scoring tests. */
const baseConfig = {
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
    notificationThreshold: 65,
    filters: { workPreference: ['remote'], locations: ['india'], minSalaryUSD: 25000, minPrimaryMatches: 3 },
    locationKeywords: ['remote'],
    fuzzyThreshold: 0.82,
};

// ──────────────────────────────────────────────────────────────────────
// scoreJob
// ──────────────────────────────────────────────────────────────────────

describe('scoreJob', () => {
    test('returns a score object with required fields', () => {
        const item = { title: 'Remote Software Engineer - React, Node.js, TypeScript', content: '' };
        const result = scoreJob(item, baseConfig);

        expect(result).toHaveProperty('score');
        expect(result).toHaveProperty('label');
        expect(result).toHaveProperty('color');
        expect(result).toHaveProperty('reasons');
        expect(result).toHaveProperty('matchedSkills');
        expect(result).toHaveProperty('excluded');
        expect(typeof result.score).toBe('number');
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
    });

    test('scores high for perfect MERN + remote match', () => {
        const item = {
            title: 'Remote Full Stack Developer',
            content: 'React, Node.js, TypeScript, MongoDB, Express, AWS, redis, ci/cd',
        };
        const result = scoreJob(item, baseConfig);
        expect(result.score).toBeGreaterThanOrEqual(70);
        expect(result.label).toMatch(/Excellent|Strong/);
    });

    test('returns score 0 and excluded=true for excluded stacks', () => {
        const item = { title: 'Remote WordPress Developer', content: 'PHP, WordPress' };
        const result = scoreJob(item, baseConfig);
        expect(result.score).toBe(0);
        expect(result.excluded).toBe(true);
    });

    test('scores low when no skills match', () => {
        const item = { title: 'Remote Graphic Designer', content: 'Photoshop, Illustrator, Figma' };
        const result = scoreJob(item, baseConfig);
        expect(result.score).toBeLessThan(40);
    });

    test('applies title match bonus when target role is in title', () => {
        const withRole = scoreJob(
            { title: 'Remote Software Engineer - React', content: 'javascript react node.js' },
            baseConfig
        );
        const withoutRole = scoreJob(
            { title: 'Remote Developer', content: 'javascript react node.js' },
            baseConfig
        );
        expect(withRole.score).toBeGreaterThan(withoutRole.score);
    });

    test('applies Next.js + TypeScript combo bonus', () => {
        const item = {
            title: 'Remote Full Stack Developer',
            content: 'next.js typescript react node.js',
        };
        const result = scoreJob(item, baseConfig);
        expect(result.reasons).toContainEqual(expect.stringContaining('Next.js + TypeScript'));
    });

    test('applies Node.js + MongoDB combo bonus', () => {
        const item = {
            title: 'Remote Full Stack Developer',
            content: 'node.js mongodb react javascript',
        };
        const result = scoreJob(item, baseConfig);
        expect(result.reasons).toContainEqual(expect.stringContaining('Node.js + MongoDB'));
    });

    test('applies penalty for non-JS primary stack in title', () => {
        const item = { title: 'Remote Python Developer', content: '' };
        const result = scoreJob(item, baseConfig);
        expect(result.reasons).toContainEqual(expect.stringContaining('Penalty'));
    });

    test('detects salary in content', () => {
        const item = {
            title: 'Remote Software Engineer',
            content: 'React, Node.js, TypeScript. Salary: $100k-$150k per year. remote',
        };
        const result = scoreJob(item, baseConfig);
        expect(result.reasons).toContainEqual(expect.stringContaining('Salary'));
    });

    test('matches synonyms (reactjs → react)', () => {
        const item = {
            title: 'Remote Software Engineer',
            content: 'reactjs nodejs typescript remote',
        };
        const result = scoreJob(item, baseConfig);
        expect(result.matchedSkills).toContain('react');
    });

    test('location/remote match adds score', () => {
        const withRemote = scoreJob(
            { title: 'Developer', content: 'react javascript remote node.js' },
            baseConfig
        );
        const withoutRemote = scoreJob(
            { title: 'Developer', content: 'react javascript node.js' },
            baseConfig
        );
        expect(withRemote.score).toBeGreaterThan(withoutRemote.score);
    });

    test('score is clamped between 0 and 100', () => {
        // Even with all bonuses, should never exceed 100
        const item = {
            title: 'Remote Full Stack Developer Software Engineer',
            content: 'react next.js typescript node.js mongodb express aws docker redis ci/cd microservices india salary: $200k',
        };
        const result = scoreJob(item, baseConfig);
        expect(result.score).toBeLessThanOrEqual(100);
        expect(result.score).toBeGreaterThanOrEqual(0);
    });
});

// ──────────────────────────────────────────────────────────────────────
// isJobRelevant (legacy boolean)
// ──────────────────────────────────────────────────────────────────────

describe('isJobRelevant', () => {
    test('returns true for high-scoring job above threshold', () => {
        const item = {
            title: 'Remote Full Stack Developer',
            content: 'React, Node.js, TypeScript, MongoDB, Express, remote',
        };
        expect(isJobRelevant(item, baseConfig)).toBe(true);
    });

    test('returns false for excluded stack', () => {
        const item = { title: 'Remote WordPress Developer', content: 'PHP WordPress remote' };
        expect(isJobRelevant(item, baseConfig)).toBe(false);
    });

    test('returns false for low-scoring job', () => {
        const item = { title: 'Remote Graphic Designer', content: 'Figma Sketch remote' };
        expect(isJobRelevant(item, baseConfig)).toBe(false);
    });
});

// ──────────────────────────────────────────────────────────────────────
// isNewJob
// ──────────────────────────────────────────────────────────────────────

describe('isNewJob', () => {
    test('returns true for job posted within time window', () => {
        const item = { pubDate: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() };
        expect(isNewJob(item, 24)).toBe(true);
    });

    test('returns false for job posted outside time window', () => {
        const item = { pubDate: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() };
        expect(isNewJob(item, 24)).toBe(false);
    });

    test('returns false when pubDate is missing', () => {
        expect(isNewJob({}, 24)).toBe(false);
    });

    test('returns false for invalid date string', () => {
        expect(isNewJob({ pubDate: 'not-a-date' }, 24)).toBe(false);
    });

    test('respects configurable time window', () => {
        const item = { pubDate: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() };
        expect(isNewJob(item, 4)).toBe(false);
        expect(isNewJob(item, 6)).toBe(true);
    });

    test('handles RFC 2822 date format', () => {
        const item = { pubDate: new Date(Date.now() - 1 * 60 * 60 * 1000).toUTCString() };
        expect(isNewJob(item, 24)).toBe(true);
    });

    test('falls back to isoDate when pubDate is missing', () => {
        const item = { isoDate: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() };
        expect(isNewJob(item, 24)).toBe(true);
    });
});

// ──────────────────────────────────────────────────────────────────────
// timeAgo
// ──────────────────────────────────────────────────────────────────────

describe('timeAgo', () => {
    test('returns minutes ago for recent dates', () => {
        const d = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        expect(timeAgo(d)).toBe('15 minutes ago');
    });

    test('returns hours ago for older dates', () => {
        const d = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        expect(timeAgo(d)).toBe('3 hours ago');
    });

    test('returns days ago for much older dates', () => {
        const d = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        expect(timeAgo(d)).toBe('2 days ago');
    });

    test('returns Unknown for null/undefined', () => {
        expect(timeAgo(null)).toBe('Unknown');
        expect(timeAgo(undefined)).toBe('Unknown');
    });
});
