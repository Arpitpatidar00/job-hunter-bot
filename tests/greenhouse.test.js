/**
 * @file tests/greenhouse.test.js
 * @description Unit tests for the Greenhouse ATS connector.
 */

// We test the normalizer logic by importing normalizeJob and simulating raw Greenhouse data

import { normalizeJob } from '../src/core/schema.js';

const GH_SOURCE_META = { url: 'https://boards-api.greenhouse.io/v1/boards/testco/jobs', name: 'TestCo', type: 'greenhouse' };

describe('Greenhouse connector — job normalization', () => {
    test('normalizes a full Greenhouse job object', () => {
        const ghJob = {
            id: 12345,
            title: 'Senior React Developer',
            content: '<p>We are looking for a React developer...</p>',
            updated_at: '2026-02-28T10:00:00Z',
            absolute_url: 'https://boards.greenhouse.io/testco/jobs/12345',
            location: { name: 'Remote' },
            departments: [{ name: 'Engineering' }],
        };

        const job = normalizeJob({
            id: `gh-${ghJob.id}`,
            title: ghJob.title,
            content: ghJob.content,
            link: ghJob.absolute_url,
            pubDate: ghJob.updated_at,
            isoDate: ghJob.updated_at,
            categories: ['Engineering', 'Remote'],
            company: 'TestCo',
        }, GH_SOURCE_META);

        expect(job.id).toBe('gh-12345');
        expect(job.title).toBe('Senior React Developer');
        expect(job.sourceType).toBe('greenhouse');
        expect(job.sourceName).toBe('TestCo');
        expect(job.link).toBe('https://boards.greenhouse.io/testco/jobs/12345');
        expect(job.categories).toContain('Engineering');
        expect(job.categories).toContain('Remote');
        expect(job.content_hash).toBeTruthy();
    });

    test('handles missing optional fields gracefully', () => {
        const job = normalizeJob({
            id: 'gh-99999',
            title: 'Developer',
            link: '',
            content: '',
        }, GH_SOURCE_META);

        expect(job.title).toBe('Developer');
        expect(job.company).toBe('');
        expect(job.content).toBe('');
        expect(job.categories).toEqual([]);
        expect(job.sourceType).toBe('greenhouse');
    });

    test('produces consistent content_hash for same job data', () => {
        const base = {
            id: 'gh-111',
            title: 'React Developer',
            company: 'TestCo',
            link: 'https://boards.greenhouse.io/testco/jobs/111',
        };

        const job1 = normalizeJob(base, GH_SOURCE_META);
        const job2 = normalizeJob(base, GH_SOURCE_META);

        expect(job1.content_hash).toBe(job2.content_hash);
    });

    test('different jobs produce different content_hash', () => {
        const job1 = normalizeJob({
            id: 'gh-1',
            title: 'React Developer',
            company: 'TestCo',
            link: 'https://boards.greenhouse.io/testco/jobs/1',
        }, GH_SOURCE_META);

        const job2 = normalizeJob({
            id: 'gh-2',
            title: 'Node.js Developer',
            company: 'TestCo',
            link: 'https://boards.greenhouse.io/testco/jobs/2',
        }, GH_SOURCE_META);

        expect(job1.content_hash).not.toBe(job2.content_hash);
    });
});
