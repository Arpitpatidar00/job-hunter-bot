/**
 * @file tests/sourceDiscovery.test.js
 * @description Unit tests for the ATS source discovery layer.
 */

import { detectAtsSources } from '../src/discovery/sourceDiscovery.js';

describe('detectAtsSources — auto-detection from job URLs', () => {
    test('detects Greenhouse board from job URL', () => {
        const urls = ['https://boards.greenhouse.io/acmecorp/jobs/12345'];
        const result = detectAtsSources(urls);

        expect(result.length).toBe(1);
        expect(result[0].type).toBe('greenhouse');
        expect(result[0].url).toBe('https://boards-api.greenhouse.io/v1/boards/acmecorp/jobs');
        expect(result[0].name).toBe('Acmecorp');
        expect(result[0].discovery_origin).toBe('auto-detected');
    });

    test('detects Lever board from job URL', () => {
        const urls = ['https://jobs.lever.co/stripe/abc-123'];
        const result = detectAtsSources(urls);

        expect(result.length).toBe(1);
        expect(result[0].type).toBe('lever');
        expect(result[0].url).toBe('https://api.lever.co/v0/postings/stripe');
    });

    test('detects Ashby board from job URL', () => {
        const urls = ['https://jobs.ashbyhq.com/notion/xyz-789'];
        const result = detectAtsSources(urls);

        expect(result.length).toBe(1);
        expect(result[0].type).toBe('ashby');
        expect(result[0].url).toBe('https://api.ashbyhq.com/posting-api/job-board/notion');
    });

    test('detects Workable board from job URL', () => {
        const urls = ['https://apply.workable.com/toggl/j/WK123/'];
        const result = detectAtsSources(urls);

        expect(result.length).toBe(1);
        expect(result[0].type).toBe('workable');
        expect(result[0].url).toBe('https://apply.workable.com/api/v3/accounts/toggl/jobs');
    });

    test('deduplicates multiple URLs from same company', () => {
        const urls = [
            'https://boards.greenhouse.io/acme/jobs/111',
            'https://boards.greenhouse.io/acme/jobs/222',
            'https://boards.greenhouse.io/acme/jobs/333',
        ];
        const result = detectAtsSources(urls);

        expect(result.length).toBe(1);
        expect(result[0].type).toBe('greenhouse');
    });

    test('skips URLs already in knownSourceUrls', () => {
        const urls = ['https://boards.greenhouse.io/testco/jobs/1'];
        const known = new Set(['https://boards-api.greenhouse.io/v1/boards/testco/jobs']);
        const result = detectAtsSources(urls, known);

        expect(result.length).toBe(0);
    });

    test('handles non-ATS URLs gracefully', () => {
        const urls = [
            'https://weworkremotely.com/remote-jobs/123',
            'https://stackoverflow.com/jobs/456',
            'https://example.com',
        ];
        const result = detectAtsSources(urls);

        expect(result.length).toBe(0);
    });

    test('handles invalid/empty URLs gracefully', () => {
        const urls = ['', null, undefined, 'not-a-url', 'ftp://invalid'];
        const result = detectAtsSources(urls);

        expect(result.length).toBe(0);
    });

    test('detects multiple ATS types from mixed URLs', () => {
        const urls = [
            'https://boards.greenhouse.io/acme/jobs/1',
            'https://jobs.lever.co/stripe/abc',
            'https://jobs.ashbyhq.com/notion/xyz',
            'https://apply.workable.com/toggl/j/WK1/',
            'https://weworkremotely.com/jobs/5',
        ];
        const result = detectAtsSources(urls);

        expect(result.length).toBe(4);
        const types = result.map(r => r.type).sort();
        expect(types).toEqual(['ashby', 'greenhouse', 'lever', 'workable']);
    });
});
