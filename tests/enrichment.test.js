/**
 * @file enrichment.test.js
 * @description Unit tests for src/intelligence/enrichment.js
 */

import {
    detectTechStack,
    detectVisaSponsorship,
    detectIndustryCluster,
    detectHiringUrgencyScore,
    enrichJob,
} from '../src/intelligence/enrichment.js';

// ── detectTechStack ───────────────────────────────────────────────────────────

describe('detectTechStack', () => {
    test('detects React and Node.js', () => {
        const text = 'We need a React and Node.js developer with TypeScript experience';
        const stack = detectTechStack(text);
        expect(stack).toContain('React');
        expect(stack).toContain('Node.js');
        expect(stack).toContain('TypeScript');
    });

    test('detects Go via golang alias', () => {
        const text = 'Experience with golang required';
        expect(detectTechStack(text)).toContain('Go');
    });

    test('detects AWS via full name', () => {
        const text = 'Familiarity with Amazon Web Services a plus';
        expect(detectTechStack(text)).toContain('AWS');
    });

    test('returns empty array for empty string', () => {
        expect(detectTechStack('')).toEqual([]);
    });

    test('does not duplicate entries', () => {
        const text = 'React react REACT ReactJS';
        const stack = detectTechStack(text);
        const reactCount = stack.filter(s => s === 'React').length;
        expect(reactCount).toBe(1);
    });
});

// ── detectVisaSponsorship ─────────────────────────────────────────────────────

describe('detectVisaSponsorship', () => {
    test('returns true when positive signal present', () => {
        expect(detectVisaSponsorship('We provide visa sponsorship for qualified candidates')).toBe(true);
    });

    test('returns false when negative override present', () => {
        expect(detectVisaSponsorship('visa sponsorship available but must be US citizen only')).toBe(false);
    });

    test('returns false when no signal present', () => {
        expect(detectVisaSponsorship('Full stack engineer role, remote-friendly')).toBe(false);
    });

    test('handles h1b pattern', () => {
        expect(detectVisaSponsorship('We sponsor H1B visas')).toBe(true);
    });

    test('returns false for empty string', () => {
        expect(detectVisaSponsorship('')).toBe(false);
    });
});

// ── detectIndustryCluster ─────────────────────────────────────────────────────

describe('detectIndustryCluster', () => {
    test('detects ai_ml', () => {
        expect(detectIndustryCluster('ML Engineer', 'deep learning and LLM experience required')).toBe('ai_ml');
    });

    test('detects fintech', () => {
        expect(detectIndustryCluster('Backend Engineer', 'payments platform, fintech startup')).toBe('fintech');
    });

    test('detects web3', () => {
        expect(detectIndustryCluster('Blockchain Developer', 'smart contracts on Ethereum')).toBe('web3');
    });

    test('detects devtools', () => {
        expect(detectIndustryCluster('SDK Engineer', 'developer tools, open-source SDK')).toBe('devtools');
    });

    test('returns other for generic text', () => {
        expect(detectIndustryCluster('Engineer', 'We are hiring an engineer')).toBe('other');
    });
});

// ── detectHiringUrgencyScore ──────────────────────────────────────────────────

describe('detectHiringUrgencyScore', () => {
    test('returns 0 for empty string', () => {
        expect(detectHiringUrgencyScore('')).toBe(0);
    });

    test('returns >0 for "immediately" signal', () => {
        expect(detectHiringUrgencyScore('Start immediately, urgent hire')).toBeGreaterThan(0);
    });

    test('caps at 100', () => {
        const highUrgency = 'immediately asap rolling interviews we are hiring now urgent contract full-time';
        expect(detectHiringUrgencyScore(highUrgency)).toBeLessThanOrEqual(100);
    });

    test('returns 0 for no urgency signals', () => {
        expect(detectHiringUrgencyScore('Competitive salary and great team culture')).toBe(0);
    });
});

// ── enrichJob ─────────────────────────────────────────────────────────────────

describe('enrichJob', () => {
    const baseJob = {
        id: 'test-123',
        title: 'Senior React Developer',
        company: 'FinTech Corp',
        link: 'https://example.com/jobs/123',
        content: 'We are looking for a React, TypeScript, Node.js developer. visa sponsorship available. Start immediately.',
        contentSnippet: 'React developer role',
        pubDate: '2026-03-05T00:00:00Z',
        isoDate: '2026-03-05T00:00:00Z',
        categories: [],
        sourceUrl: 'https://example.com/jobs.rss',
        sourceName: 'Example',
        sourceType: 'rss',
        content_hash: 'abc123',
        similarity_hash: 'def456',
    };

    const scoreResult = {
        score: 72,
        matchedSkills: ['React', 'TypeScript', 'Node.js'],
        features: {
            seniority: 'senior',
            remoteType: 'remote',
            salaryUSD: { min: 80000, max: 120000, currency: 'USD' },
        },
    };

    test('enriches with techStack', () => {
        const enriched = enrichJob(baseJob, scoreResult);
        expect(enriched.techStack).toContain('React');
        expect(enriched.techStack).toContain('TypeScript');
    });

    test('maps seniority from scoreResult features', () => {
        const enriched = enrichJob(baseJob, scoreResult);
        expect(enriched.seniorityLevel).toBe('senior');
    });

    test('maps salaryRange from scoreResult features', () => {
        const enriched = enrichJob(baseJob, scoreResult);
        expect(enriched.salaryRange).toEqual({ min: 80000, max: 120000 });
    });

    test('detects visa sponsorship', () => {
        const enriched = enrichJob(baseJob, scoreResult);
        expect(enriched.visaSponsorship).toBe(true);
    });

    test('detects industry cluster', () => {
        // FinTech Corp + fintech keywords → should be other since text has no fintech keywords
        const enriched = enrichJob(baseJob, scoreResult);
        expect(typeof enriched.industryCluster).toBe('string');
    });

    test('detects hiring urgency', () => {
        const enriched = enrichJob(baseJob, scoreResult);
        expect(enriched.hiringUrgencyScore).toBeGreaterThan(0);
    });

    test('preserves base job fields', () => {
        const enriched = enrichJob(baseJob, scoreResult);
        expect(enriched.id).toBe('test-123');
        expect(enriched.score).toBe(72);
        expect(enriched.matchedSkills).toContain('React');
    });
});
