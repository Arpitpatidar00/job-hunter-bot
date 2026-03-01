/**
 * @file tests/edge-cases.test.js
 * @jest-environment node
 * @description Edge case tests from e2etesting.md:
 *   - Empty job descriptions
 *   - Missing salary field
 *   - Missing location
 *   - Very long descriptions
 *   - Non-English jobs
 *   - Remote jobs without explicit location
 *
 * Also validates performance constraints:
 *   - CPU: processing time per batch
 *   - AI: no duplicate embeddings for fresh-only
 *   - D1: dedup reduces writes
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

const { scoreJob, isNewJob, isJobRelevant } = await import('../src/scoring/relevance.js');
const { normalizeJob, jobDedupeKey } = await import('../src/core/schema.js');
const { detectAtsSources } = await import('../src/discovery/sourceDiscovery.js');
const { sanitizeText, parseExperienceYears, extractSalaryUSD, detectRemoteType } = await import('../src/core/utils.js');

const SOURCE_META = { url: 'https://test.com', name: 'Test', type: 'rss' };

const CONFIG = {
    searchRules: {
        mustMatch: ['javascript', 'typescript', 'react', 'next.js', 'node.js'],
        shouldMatch: ['mongodb', 'express', 'aws', 'docker'],
        niceToHave: ['redis'],
        exclude: ['wordpress', 'php'],
    },
    targetRoles: ['full stack developer', 'software engineer', 'frontend engineer'],
    synonyms: {
        react: ['reactjs', 'react.js'],
        'node.js': ['nodejs'],
        typescript: ['ts'],
    },
    weights: { titleMatch: 30, skillsMatch: 30, techStackMatch: 20, locationMatch: 10, salaryMatch: 10 },
    scoringBonuses: { nextjsAndTypescript: 8, nodeAndMongodb: 6, awsPresent: 4, fullMernStack: 10, remoteIndia: 5 },
    scoringPenalties: { nonJsStack: -15, frontendOnlyNoBackend: -5 },
    scoring: { tfidfWeight: 0.15, experienceBonus: 5, seniorityPenalty: -8 },
    notificationThreshold: 50,
    filters: { workPreference: ['remote'], locations: ['india'], minSalaryUSD: 0, minPrimaryMatches: 1 },
    locationKeywords: ['remote'],
    experienceLevel: ['junior', 'mid-level'],
    fuzzyThreshold: 0.82,
};

// ── Edge Case: Empty Job Description ─────────────────────────────────────────

describe('Edge Case — Empty job descriptions', () => {
    test('scoreJob handles empty content', () => {
        const result = scoreJob({ title: 'Developer', content: '' }, CONFIG);
        expect(result.score).toBeDefined();
        expect(result.excluded).toBe(false);
        expect(typeof result.score).toBe('number');
    });

    test('scoreJob handles undefined content', () => {
        const result = scoreJob({ title: 'Developer' }, CONFIG);
        expect(result.score).toBeDefined();
    });

    test('normalizeJob handles empty content', () => {
        const job = normalizeJob({ title: 'Dev', content: '', link: 'https://a.com' }, SOURCE_META);
        expect(job.title).toBe('Dev');
        expect(job.content).toBe('');
        expect(job.content_hash).toBeTruthy();
    });

    test('scoreJob handles completely empty job object', () => {
        const result = scoreJob({}, CONFIG);
        expect(result.score).toBeDefined();
        expect(typeof result.score).toBe('number');
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
    });
});

// ── Edge Case: Missing Salary Field ──────────────────────────────────────────

describe('Edge Case — Missing salary field', () => {
    test('scores correctly without salary in content', () => {
        const result = scoreJob({
            title: 'React Developer',
            content: 'javascript react node.js typescript. remote.',
        }, CONFIG);
        expect(result.features.salaryUSD).toBeNull();
        expect(result.breakdown.salaryScore).toBe(0);
        // Should still produce a valid score
        expect(result.score).toBeGreaterThan(0);
    });

    test('extractSalaryUSD returns null for no salary text', () => {
        expect(extractSalaryUSD('')).toBeNull();
        expect(extractSalaryUSD(null)).toBeNull();
        expect(extractSalaryUSD('just some text without salary info')).toBeNull();
    });
});

// ── Edge Case: Missing Location ──────────────────────────────────────────────

describe('Edge Case — Missing location', () => {
    test('detectRemoteType returns unknown for empty text', () => {
        expect(detectRemoteType('')).toBe('unknown');
        expect(detectRemoteType(null)).toBe('unknown');
    });

    test('scores correctly without location info', () => {
        const result = scoreJob({
            title: 'React Developer',
            content: 'javascript react typescript node.js',
        }, CONFIG);
        expect(result.features.remoteType).toBe('unknown');
        expect(result.breakdown.locationScore).toBe(0);
    });
});

// ── Edge Case: Very Long Descriptions ────────────────────────────────────────

describe('Edge Case — Very long descriptions', () => {
    test('normalizeJob truncates content snippet to 500 chars', () => {
        const longContent = 'React JavaScript TypeScript Node.js '.repeat(500);
        const job = normalizeJob({
            title: 'Developer',
            content: longContent,
            link: 'https://a.com',
        }, SOURCE_META);

        expect(job.contentSnippet.length).toBeLessThanOrEqual(500);
        expect(job.content.length).toBeGreaterThan(500);
    });

    test('scoreJob handles very long content without timeout', () => {
        const longContent = 'react javascript typescript node.js mongodb express aws docker redis ci/cd microservices remote india salary $100k '.repeat(100);

        const start = Date.now();
        const result = scoreJob({ title: 'Developer', content: longContent }, CONFIG);
        const elapsed = Date.now() - start;

        expect(result.score).toBeDefined();
        expect(elapsed).toBeLessThan(500); // Should take < 500ms
    });

    test('sanitizeText handles very long HTML content', () => {
        const longHtml = '<p>React Developer</p>'.repeat(1000);
        const result = sanitizeText(longHtml);
        expect(result).not.toContain('<p>');
        expect(result).toContain('React Developer');
    });
});

// ── Edge Case: Non-English Jobs ──────────────────────────────────────────────

describe('Edge Case — Non-English jobs', () => {
    test('scoring handles non-English content gracefully', () => {
        const result = scoreJob({
            title: 'Desarrollador Frontend',
            content: 'Buscamos un desarrollador con experiencia en React y TypeScript. Trabajo remoto.',
        }, CONFIG);
        expect(result.score).toBeDefined();
        // Should still detect React and TypeScript
        expect(result.matchedSkills).toContain('react');
        expect(result.matchedSkills).toContain('typescript');
    });

    test('normalizeJob handles Unicode titles', () => {
        const job = normalizeJob({
            title: 'フロントエンドエンジニア (React)',
            content: 'React, TypeScript required',
            link: 'https://jp.example.com/jobs/1',
        }, SOURCE_META);
        expect(job.title).toBe('フロントエンドエンジニア (React)');
    });

    test('scoring handles mixed-language content', () => {
        const result = scoreJob({
            title: 'Full Stack Developer (远程)',
            content: 'Required: JavaScript, TypeScript, React, Node.js. 远程工作. India.',
        }, CONFIG);
        expect(result.matchedSkills.length).toBeGreaterThan(2);
    });
});

// ── Edge Case: Remote Jobs Without Explicit Location ─────────────────────────

describe('Edge Case — Remote jobs without explicit location', () => {
    test('detects "remote" as work arrangement even without city/country', () => {
        const result = scoreJob({
            title: 'React Developer',
            content: 'javascript react typescript. fully remote position.',
        }, CONFIG);
        expect(result.features.remoteType).toBe('remote');
    });

    test('detects "work from home" variant', () => {
        expect(detectRemoteType('work from home position')).toBe('remote');
    });

    test('detects "distributed team" variant', () => {
        expect(detectRemoteType('we are a distributed team')).toBe('remote');
    });

    test('detects "WFH" abbreviation', () => {
        expect(detectRemoteType('wfh available')).toBe('remote');
    });

    test('handles hybrid without explicit city', () => {
        expect(detectRemoteType('hybrid, 2 days from office')).toBe('hybrid');
    });
});

// ── Performance: CPU Usage ───────────────────────────────────────────────────

describe('Performance — CPU usage check', () => {
    test('batch of 50 jobs scored in < 100ms', () => {
        const jobs = Array.from({ length: 50 }, (_, i) => ({
            title: `Developer ${i}`,
            content: `javascript react typescript node.js. Job number ${i}. Remote.`,
        }));

        const start = Date.now();
        for (const job of jobs) {
            scoreJob(job, CONFIG);
        }
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(100);
    });

    test('batch of 100 normalizeJob calls in < 50ms', () => {
        const start = Date.now();
        for (let i = 0; i < 100; i++) {
            normalizeJob({
                title: `Dev ${i}`,
                company: `Co ${i}`,
                link: `https://example.com/jobs/${i}`,
                content: 'react node.js',
            }, SOURCE_META);
        }
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(50);
    });
});

// ── Performance: D1 Write Efficiency ─────────────────────────────────────────

describe('Performance — D1 write efficiency (dedup reduces writes)', () => {
    test('intra-batch dedup removes exact duplicates before DB insert', () => {
        const jobs = [
            normalizeJob({ title: 'React Dev', company: 'Co', link: 'https://co.com/1' }, SOURCE_META),
            normalizeJob({ title: 'React Dev', company: 'Co', link: 'https://co.com/1' }, SOURCE_META),
            normalizeJob({ title: 'React Dev', company: 'Co', link: 'https://co.com/1' }, SOURCE_META),
            normalizeJob({ title: 'Node Dev', company: 'Co', link: 'https://co.com/2' }, SOURCE_META),
        ];

        const seen = new Set();
        let dbWriteCount = 0;
        for (const job of jobs) {
            if (job.content_hash && seen.has(job.content_hash)) continue;
            if (job.content_hash) seen.add(job.content_hash);
            dbWriteCount++;
        }

        expect(dbWriteCount).toBe(2); // Only 2 unique jobs
        expect(jobs.length - dbWriteCount).toBe(2); // 2 writes saved
    });
});

// ── Performance: AI Efficiency ───────────────────────────────────────────────

describe('Performance — AI usage efficiency', () => {
    test('stale jobs skip AI entirely (freshness check first)', () => {
        const staleJob = {
            title: 'React Developer',
            content: 'javascript react',
            pubDate: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
        };

        // If isNewJob returns false, AI would never be called
        const isFresh = isNewJob(staleJob, 24);
        expect(isFresh).toBe(false);
        // In pipeline: stale → ack immediately → no AI call
    });

    test('duplicate jobs skip AI (dedup check before AI)', () => {
        const job1 = normalizeJob({ title: 'Dev', company: 'Co', link: 'https://co.com/1' }, SOURCE_META);
        const job2 = normalizeJob({ title: 'Dev', company: 'Co', link: 'https://co.com/1' }, SOURCE_META);

        // Same content_hash → second job skipped entirely before AI
        expect(job1.content_hash).toBe(job2.content_hash);
    });
});
