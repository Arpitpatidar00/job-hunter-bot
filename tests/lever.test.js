/**
 * @file tests/lever.test.js
 * @description Unit tests for the Lever ATS connector normalization.
 */

import { normalizeJob } from '../src/core/schema.js';

const LEVER_SOURCE_META = { url: 'https://api.lever.co/v0/postings/testco', name: 'TestCo', type: 'lever' };

describe('Lever connector — job normalization', () => {
    test('normalizes a full Lever posting', () => {
        const posting = {
            id: 'abc-123',
            text: 'Full Stack Engineer',
            descriptionPlain: 'We need a full stack engineer proficient in Node.js and React.',
            categories: {
                department: 'Engineering',
                commitment: 'Full-time',
                location: 'Remote',
                team: 'Platform',
            },
            hostedUrl: 'https://jobs.lever.co/testco/abc-123',
            createdAt: 1740700000000,
            lists: [
                { text: 'Requirements', content: 'React, Node.js, TypeScript' },
            ],
        };

        const job = normalizeJob({
            id: `lever-${posting.id}`,
            title: posting.text,
            content: posting.descriptionPlain + ' Requirements React, Node.js, TypeScript',
            link: posting.hostedUrl,
            pubDate: new Date(posting.createdAt).toISOString(),
            isoDate: new Date(posting.createdAt).toISOString(),
            categories: ['Engineering', 'Full-time', 'Remote', 'Platform'],
            company: 'TestCo',
        }, LEVER_SOURCE_META);

        expect(job.id).toBe('lever-abc-123');
        expect(job.title).toBe('Full Stack Engineer');
        expect(job.sourceType).toBe('lever');
        expect(job.link).toBe('https://jobs.lever.co/testco/abc-123');
        expect(job.categories).toContain('Engineering');
        expect(job.categories).toContain('Remote');
    });

    test('handles Lever posting with minimal data', () => {
        const job = normalizeJob({
            id: 'lever-minimal',
            title: 'Developer',
            content: '',
            link: '',
        }, LEVER_SOURCE_META);

        expect(job.title).toBe('Developer');
        expect(job.sourceType).toBe('lever');
        expect(job.content).toBe('');
    });
});
