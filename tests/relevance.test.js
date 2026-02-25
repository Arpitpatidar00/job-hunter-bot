/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';

// Mock the logger to prevent actual file I/O during tests
jest.unstable_mockModule('../src/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

// Mock sanitize-html to avoid full dep in tests
jest.unstable_mockModule('sanitize-html', () => ({
    default: (html) => (html || '').replace(/<[^>]*>/g, '').trim(),
}));

const { isJobRelevant, isNewJob } = await import('../src/relevance.js');

const baseConfig = {
    profileKeywords: ['javascript', 'react', 'node.js', 'full-stack', 'software engineer'],
    locationKeywords: ['remote'],
    fuzzyThreshold: 0.8,
    regexKeywords: [],
};

describe('isJobRelevant', () => {
    test('matches exact keyword + location', () => {
        const item = { title: 'Remote JavaScript Developer', content: '' };
        expect(isJobRelevant(item, baseConfig)).toBe(true);
    });

    test('matches case-insensitively', () => {
        const item = { title: 'REMOTE REACT Developer Needed', content: '' };
        expect(isJobRelevant(item, baseConfig)).toBe(true);
    });

    test('returns false when location keyword is missing', () => {
        const item = { title: 'JavaScript Developer (On-site)', content: '' };
        expect(isJobRelevant(item, baseConfig)).toBe(false);
    });

    test('returns false when no skill keywords match', () => {
        const item = { title: 'Remote Graphic Designer', content: 'Looking for a Photoshop expert' };
        expect(isJobRelevant(item, baseConfig)).toBe(false);
    });

    test('matches keyword in content/contentSnippet', () => {
        const item = {
            title: 'Remote Developer Wanted',
            content: '',
            contentSnippet: 'We need someone with react experience',
        };
        expect(isJobRelevant(item, baseConfig)).toBe(true);
    });

    test('fuzzy matches close variations', () => {
        const item = { title: 'Remote Javascritp Developer', content: '' }; // typo in "javascript"
        const config = { ...baseConfig, fuzzyThreshold: 0.7 };
        expect(isJobRelevant(item, config)).toBe(true);
    });

    test('does not fuzzy match distant words at high threshold', () => {
        const item = { title: 'Remote Python Developer', content: '' };
        expect(isJobRelevant(item, baseConfig)).toBe(false);
    });

    test('matches regex keywords when provided', () => {
        const item = { title: 'Remote Developer', content: 'Experience with Go or Rust' };
        const config = { ...baseConfig, profileKeywords: [], regexKeywords: ['\\b(go|rust)\\b'] };
        expect(isJobRelevant(item, config)).toBe(true);
    });

    test('handles items with no title or content gracefully', () => {
        const item = {};
        expect(isJobRelevant(item, baseConfig)).toBe(false);
    });

    test('matches multi-word keywords like "software engineer"', () => {
        const item = { title: 'Remote Software Engineer Position', content: '' };
        expect(isJobRelevant(item, baseConfig)).toBe(true);
    });
});

describe('isNewJob', () => {
    test('returns true for job posted within time window', () => {
        const item = { pubDate: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }; // 2 hours ago
        expect(isNewJob(item, 24)).toBe(true);
    });

    test('returns false for job posted outside time window', () => {
        const item = { pubDate: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() }; // 48 hours ago
        expect(isNewJob(item, 24)).toBe(false);
    });

    test('returns false when pubDate is missing', () => {
        expect(isNewJob({}, 24)).toBe(false);
    });

    test('returns false for invalid date string', () => {
        expect(isNewJob({ pubDate: 'not-a-date' }, 24)).toBe(false);
    });

    test('respects configurable time window', () => {
        const item = { pubDate: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() }; // 5 hours ago
        expect(isNewJob(item, 4)).toBe(false);
        expect(isNewJob(item, 6)).toBe(true);
    });

    test('handles RFC 2822 date format', () => {
        const item = { pubDate: new Date(Date.now() - 1 * 60 * 60 * 1000).toUTCString() }; // 1 hour ago
        expect(isNewJob(item, 24)).toBe(true);
    });

    test('falls back to isoDate when pubDate is missing', () => {
        const item = { isoDate: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }; // 2 hours ago
        expect(isNewJob(item, 24)).toBe(true);
    });
});
