/**
 * @file tests/workable.test.js
 * @description Unit tests for the Workable ATS connector normalization.
 */

import { normalizeJob } from '../src/core/schema.js';

const WORKABLE_SOURCE_META = { url: 'https://apply.workable.com/api/v3/accounts/testco/jobs', name: 'TestCo', type: 'workable' };

describe('Workable connector — job normalization', () => {
    test('normalizes a full Workable job', () => {
        const wJob = {
            id: 'wk-456',
            title: 'Frontend React Developer',
            shortDescription: 'Join us as a React developer.',
            description: '<p>Build beautiful UIs with React and TypeScript.</p>',
            department: 'Product',
            location: { city: 'Berlin', country: 'Germany', remote: true },
            published: '2026-02-28T08:00:00Z',
            shortcode: 'WK456',
            url: 'https://apply.workable.com/testco/j/WK456/',
        };

        const job = normalizeJob({
            id: `workable-${wJob.id}`,
            title: wJob.title,
            content: 'Build beautiful UIs with React and TypeScript.',
            link: wJob.url,
            pubDate: wJob.published,
            isoDate: wJob.published,
            categories: ['Product', 'Berlin', 'Germany', 'Remote'],
            company: 'TestCo',
        }, WORKABLE_SOURCE_META);

        expect(job.id).toBe('workable-wk-456');
        expect(job.title).toBe('Frontend React Developer');
        expect(job.sourceType).toBe('workable');
        expect(job.categories).toContain('Remote');
        expect(job.categories).toContain('Product');
    });

    test('handles Workable job without location', () => {
        const job = normalizeJob({
            id: 'workable-noloc',
            title: 'Developer',
            content: '',
        }, WORKABLE_SOURCE_META);

        expect(job.title).toBe('Developer');
        expect(job.sourceType).toBe('workable');
    });
});
