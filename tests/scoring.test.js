/**
 * @file tests/scoring.test.js
 * @description Unit tests for Scoring Engine v2:
 *   - TF-IDF signal blending
 *   - Seniority detection & bonus application
 *   - Score breakdown structure
 *   - Feature extraction correctness
 */

import { scoreJob } from '../src/scoring/relevance.js';

const BASE_CONFIG = {
    searchRules: {
        mustMatch: ['javascript', 'react', 'typescript'],
        shouldMatch: ['node.js', 'mongodb'],
        niceToHave: ['docker', 'redis'],
        exclude: ['wordpress', 'php'],
    },
    targetRoles: ['frontend developer', 'react developer', 'full stack developer'],
    synonyms: {
        react: ['reactjs', 'react.js'],
        'node.js': ['nodejs', 'node js'],
        typescript: ['ts'],
    },
    weights: { titleMatch: 30, skillsMatch: 30, techStackMatch: 20, locationMatch: 10, salaryMatch: 10 },
    scoringBonuses: { nextjsAndTypescript: 8, nodeAndMongodb: 6, awsPresent: 4, fullMernStack: 10, remoteIndia: 5 },
    scoringPenalties: { nonJsStack: -15, frontendOnlyNoBackend: -5 },
    scoring: { tfidfWeight: 0.15, experienceBonus: 5, seniorityPenalty: -8 },
    filters: { workPreference: ['remote'], locations: ['india'], minSalaryUSD: 0, minPrimaryMatches: 1 },
    locationKeywords: ['remote'],
    experienceLevel: ['junior', 'mid-level', '1+ years', '2+ years', '3+ years'],
    notificationThreshold: 50,
    fuzzyThreshold: 0.82,
};

describe('Scoring Engine v2 — ScoreResult Structure', () => {
    const item = {
        title: 'React Developer',
        content: 'We are looking for a React developer with TypeScript and JavaScript skills. Remote work. Junior/mid-level.',
    };

    test('scoreJob returns all required fields', () => {
        const result = scoreJob(item, BASE_CONFIG);
        expect(result).toHaveProperty('score');
        expect(result).toHaveProperty('label');
        expect(result).toHaveProperty('color');
        expect(result).toHaveProperty('reasons');
        expect(result).toHaveProperty('matchedSkills');
        expect(result).toHaveProperty('excluded');
        expect(result).toHaveProperty('breakdown');
        expect(result).toHaveProperty('features');
    });

    test('breakdown has all sub-score fields', () => {
        const result = scoreJob(item, BASE_CONFIG);
        const { breakdown } = result;
        expect(breakdown).toHaveProperty('titleScore');
        expect(breakdown).toHaveProperty('skillsScore');
        expect(breakdown).toHaveProperty('techScore');
        expect(breakdown).toHaveProperty('locationScore');
        expect(breakdown).toHaveProperty('salaryScore');
        expect(breakdown).toHaveProperty('tfidfBoost');
        expect(breakdown).toHaveProperty('bonuses');
        expect(breakdown).toHaveProperty('penalties');
    });

    test('features has all extracted fields', () => {
        const result = scoreJob(item, BASE_CONFIG);
        const { features } = result;
        expect(features).toHaveProperty('experience');
        expect(features).toHaveProperty('salaryUSD');
        expect(features).toHaveProperty('remoteType');
        expect(features).toHaveProperty('seniority');
    });

    test('score is in range 0-100', () => {
        const result = scoreJob(item, BASE_CONFIG);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
    });
});

describe('Scoring Engine v2 — Exclusion', () => {
    test('excluded=true when blacklist term found', () => {
        const result = scoreJob({
            title: 'WordPress Developer',
            content: 'We need a PHP wordpress developer.',
        }, BASE_CONFIG);
        expect(result.excluded).toBe(true);
        expect(result.score).toBe(0);
    });
});

describe('Scoring Engine v2 — TF-IDF enhancement', () => {
    test('keyword-dense job gets tfidfBoost > 0', () => {
        const result = scoreJob({
            title: 'React Developer',
            content: 'React React React JavaScript TypeScript React developer needed. React experience required.',
        }, BASE_CONFIG);
        expect(result.breakdown.tfidfBoost).toBeGreaterThan(0);
    });

    test('keyword-sparse job gets tfidfBoost = 0', () => {
        const result = scoreJob({
            title: 'General Office Manager',
            content: 'We are a startup hiring an office manager.',
        }, BASE_CONFIG);
        expect(result.breakdown.tfidfBoost).toBe(0);
    });
});

describe('Scoring Engine v2 — Seniority detection', () => {
    test('junior role gives seniority=junior in features', () => {
        const result = scoreJob({
            title: 'Junior React Developer',
            content: 'Entry level position. React and JavaScript required.',
        }, BASE_CONFIG);
        expect(result.features.seniority).toBe('junior');
    });

    test('senior-only role gives seniority mismatch penalty', () => {
        const senior = scoreJob({
            title: 'Senior React Engineer',
            content: 'Senior level. Expert required. React and TypeScript.',
        }, BASE_CONFIG);
        // Penalty should be reflected in breakdown.bonuses being negative or lower
        expect(senior.breakdown.bonuses).toBeLessThan(5);
    });

    test('junior role matching user prefs gives experience bonus', () => {
        const junior = scoreJob({
            title: 'Junior React Developer',
            content: 'JavaScript TypeScript React developer. Entry level welcome. Remote.',
        }, BASE_CONFIG);
        // Should have a positive bonus from seniority match
        expect(junior.breakdown.bonuses).toBeGreaterThanOrEqual(5);
    });
});

describe('Scoring Engine v2 — Remote detection', () => {
    test('detects fully remote', () => {
        const result = scoreJob({
            title: 'Frontend React Developer',
            content: 'Fully remote. Work from anywhere. React JavaScript required.',
        }, BASE_CONFIG);
        expect(result.features.remoteType).toBe('remote');
    });

    test('detects hybrid', () => {
        const result = scoreJob({
            title: 'React Developer',
            content: 'Hybrid role. 3 days in office. React TypeScript required.',
        }, BASE_CONFIG);
        expect(result.features.remoteType).toBe('hybrid');
    });
});

describe('Scoring Engine v2 — Salary extraction', () => {
    test('detects USD salary range', () => {
        const result = scoreJob({
            title: 'React Developer',
            content: 'React TypeScript JavaScript. Salary $80k-$120k per year. Remote.',
        }, BASE_CONFIG);
        expect(result.features.salaryUSD).not.toBeNull();
        if (result.features.salaryUSD) {
            expect(result.features.salaryUSD.min).toBeGreaterThan(0);
        }
        expect(result.breakdown.salaryScore).toBeGreaterThan(0);
    });

    test('no salary when not present', () => {
        const result = scoreJob({
            title: 'React Developer',
            content: 'React TypeScript JavaScript. Remote.',
        }, BASE_CONFIG);
        expect(result.features.salaryUSD).toBeNull();
    });
});
