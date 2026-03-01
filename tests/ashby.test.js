/**
 * @file tests/ashby.test.js
 * @description Unit tests for the Ashby ATS connector normalization.
 */

import { normalizeJob } from '../src/core/schema.js';

const ASHBY_SOURCE_META = { url: 'https://api.ashbyhq.com/posting-api/job-board/testco', name: 'TestCo', type: 'ashby' };

describe('Ashby connector — job normalization', () => {
    test('normalizes a full Ashby job', () => {
        const ashbyJob = {
            id: 'ash-789',
            title: 'Backend Engineer',
            departmentName: 'Engineering',
            locationName: 'San Francisco, CA',
            publishedAt: '2026-02-28T12:00:00Z',
            descriptionPlain: 'Building APIs with Node.js and PostgreSQL.',
            jobUrl: 'https://jobs.ashbyhq.com/testco/ash-789',
            employmentType: 'Full-time',
            isRemote: true,
        };

        const job = normalizeJob({
            id: `ashby-${ashbyJob.id}`,
            title: ashbyJob.title,
            content: ashbyJob.descriptionPlain,
            link: ashbyJob.jobUrl,
            pubDate: ashbyJob.publishedAt,
            isoDate: ashbyJob.publishedAt,
            categories: ['Engineering', 'San Francisco, CA', 'Full-time', 'Remote'],
            company: 'TestCo',
        }, ASHBY_SOURCE_META);

        expect(job.id).toBe('ashby-ash-789');
        expect(job.title).toBe('Backend Engineer');
        expect(job.sourceType).toBe('ashby');
        expect(job.categories).toContain('Remote');
        expect(job.categories).toContain('Engineering');
    });

    test('handles Ashby job with no description', () => {
        const job = normalizeJob({
            id: 'ashby-empty',
            title: 'Engineer',
            content: '',
            link: 'https://jobs.ashbyhq.com/testco/empty',
        }, ASHBY_SOURCE_META);

        expect(job.title).toBe('Engineer');
        expect(job.content).toBe('');
        expect(job.sourceType).toBe('ashby');
    });
});
