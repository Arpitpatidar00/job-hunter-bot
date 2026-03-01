/**
 * @file tests/sourceAbstraction.test.js
 * @description Unit tests for the source abstraction layer.
 *   - buildSourceList() merges feeds[] and sources[]
 *   - groupByType() groups correctly
 *   - Backward compatibility with legacy feed format
 */

import { buildSourceList, groupByType, validateConnectorSources } from '../src/connectors/base.js';

describe('buildSourceList — merge legacy feeds + new sources', () => {
    test('converts string feeds to RSS sources', () => {
        const config = {
            feeds: ['https://example.com/feed.rss', 'https://other.com/jobs.rss'],
            sources: [],
        };

        const result = buildSourceList(config);

        expect(result.length).toBe(2);
        expect(result[0].type).toBe('rss');
        expect(result[0].url).toBe('https://example.com/feed.rss');
        expect(result[0].enabled).toBe(true);
        expect(result[1].type).toBe('rss');
    });

    test('converts object feeds to RSS sources', () => {
        const config = {
            feeds: [{ url: 'https://example.com/feed.rss', name: 'Example' }],
            sources: [],
        };

        const result = buildSourceList(config);

        expect(result.length).toBe(1);
        expect(result[0].type).toBe('rss');
        expect(result[0].name).toBe('Example');
    });

    test('merges sources[] with feeds[] without duplicates', () => {
        const config = {
            feeds: ['https://example.com/feed.rss'],
            sources: [
                { type: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/testco/jobs', name: 'TestCo' },
            ],
        };

        const result = buildSourceList(config);

        expect(result.length).toBe(2);
        expect(result.map(s => s.type)).toEqual(expect.arrayContaining(['rss', 'greenhouse']));
    });

    test('deduplicates by URL', () => {
        const config = {
            feeds: ['https://example.com/feed.rss'],
            sources: [
                { type: 'rss', url: 'https://example.com/feed.rss', name: 'DupeSource' },
            ],
        };

        const result = buildSourceList(config);

        expect(result.length).toBe(1);
    });

    test('filters out disabled sources', () => {
        const config = {
            feeds: [],
            sources: [
                { type: 'greenhouse', url: 'https://example.com/1', name: 'Active', enabled: true },
                { type: 'greenhouse', url: 'https://example.com/2', name: 'Disabled', enabled: false },
            ],
        };

        const result = buildSourceList(config);

        expect(result.length).toBe(1);
        expect(result[0].name).toBe('Active');
    });

    test('handles empty config gracefully', () => {
        expect(buildSourceList({})).toEqual([]);
        expect(buildSourceList({ feeds: [], sources: [] })).toEqual([]);
    });
});

describe('groupByType', () => {
    test('groups sources by connector type', () => {
        const sources = [
            { type: 'rss', url: 'a' },
            { type: 'greenhouse', url: 'b' },
            { type: 'rss', url: 'c' },
            { type: 'lever', url: 'd' },
        ];

        const groups = groupByType(sources);

        expect(groups.get('rss').length).toBe(2);
        expect(groups.get('greenhouse').length).toBe(1);
        expect(groups.get('lever').length).toBe(1);
    });

    test('handles empty source list', () => {
        const groups = groupByType([]);
        expect(groups.size).toBe(0);
    });
});

describe('validateConnectorSources', () => {
    test('filters sources by type and enabled status', () => {
        const sources = [
            { type: 'greenhouse', url: 'https://a.com', name: 'A', enabled: true },
            { type: 'greenhouse', url: 'https://b.com', name: 'B', enabled: false },
            { type: 'lever', url: 'https://c.com', name: 'C', enabled: true },
            { type: 'greenhouse', url: '', name: 'D', enabled: true }, // missing URL
        ];

        const result = validateConnectorSources(sources, 'greenhouse');

        expect(result.length).toBe(1);
        expect(result[0].name).toBe('A');
    });

    test('returns empty array for no matching type', () => {
        const sources = [{ type: 'rss', url: 'https://x.com', name: 'X' }];
        expect(validateConnectorSources(sources, 'greenhouse')).toEqual([]);
    });
});
