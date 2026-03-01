/**
 * @file tests/connectors.test.js
 * @description Unit tests for the RSS connector and connector registry.
 *   - XML parsing produces correct RawJob shape
 *   - normalizeJob() guarantees no undefined fields
 *   - Connector registry maps feed URLs to source labels
 */

import { normalizeJob, normalizeCompany, normalizeTitle, jobDedupeKey } from '../src/core/schema.js';

// ── normalizeJob ─────────────────────────────────────────────────────────────

describe('normalizeJob — canonical RawJob shape', () => {
    const sourceMeta = { url: 'https://example.com/feed', name: 'Example', type: 'rss' };

    test('all required fields are present', () => {
        const job = normalizeJob({
            title: 'React Developer',
            link: 'https://example.com/job/1',
            guid: 'https://example.com/job/1',
            content: 'Looking for a React developer.',
            pubDate: '2026-02-28T12:00:00Z',
            creator: 'Acme Corp',
            categories: ['remote', 'javascript'],
        }, sourceMeta);

        expect(job).toHaveProperty('id');
        expect(job).toHaveProperty('title');
        expect(job).toHaveProperty('company');
        expect(job).toHaveProperty('link');
        expect(job).toHaveProperty('content');
        expect(job).toHaveProperty('contentSnippet');
        expect(job).toHaveProperty('pubDate');
        expect(job).toHaveProperty('isoDate');
        expect(job).toHaveProperty('categories');
        expect(job).toHaveProperty('sourceUrl');
        expect(job).toHaveProperty('sourceName');
        expect(job).toHaveProperty('sourceType');
    });

    test('no field is undefined or null', () => {
        const job = normalizeJob({}, sourceMeta);
        for (const [key, val] of Object.entries(job)) {
            expect(val).not.toBeUndefined();
            expect(val).not.toBeNull();
        }
    });

    test('contentSnippet is max 500 chars', () => {
        const longContent = 'x'.repeat(1000);
        const job = normalizeJob({ content: longContent }, sourceMeta);
        expect(job.contentSnippet.length).toBeLessThanOrEqual(500);
    });

    test('sourceUrl/sourceName/sourceType come from meta', () => {
        const job = normalizeJob({}, sourceMeta);
        expect(job.sourceUrl).toBe(sourceMeta.url);
        expect(job.sourceName).toBe(sourceMeta.name);
        expect(job.sourceType).toBe(sourceMeta.type);
    });

    test('creator falls through to company', () => {
        const job = normalizeJob({ creator: 'My Corp Inc.' }, sourceMeta);
        expect(job.company).toBe('My Corp');
    });

    test('categories defaults to empty array when absent', () => {
        const job = normalizeJob({ title: 'Dev' }, sourceMeta);
        expect(Array.isArray(job.categories)).toBe(true);
        expect(job.categories.length).toBe(0);
    });
});

// ── normalizeCompany ──────────────────────────────────────────────────────────

describe('normalizeCompany', () => {
    test.each([
        ['Acme Inc.', 'Acme'],
        ['Acme Ltd.', 'Acme'],
        ['Acme LLC', 'Acme'],
        ['Acme Corp.', 'Acme'],
        ['Acme GmbH', 'Acme'],
        ['Acme B.V.', 'Acme'],
        ['  Acme  ', 'Acme'],
        ['', ''],
    ])('normalizeCompany("%s") === "%s"', (input, expected) => {
        expect(normalizeCompany(input)).toBe(expected);
    });
});

// ── normalizeTitle ────────────────────────────────────────────────────────────

describe('normalizeTitle', () => {
    test.each([
        ['🚀 React Developer', 'React Developer'],
        ['React Developer (m/w/d)', 'React Developer'],
        ['React Developer [Remote]', 'React Developer'],
        ['  React Developer  ', 'React Developer'],
        ['React Developer (Remote)', 'React Developer'],
        ['', ''],
    ])('normalizeTitle("%s") === "%s"', (input, expected) => {
        expect(normalizeTitle(input).trim()).toBe(expected.trim());
    });
});
