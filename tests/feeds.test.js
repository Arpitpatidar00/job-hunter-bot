/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';

// Mock the logger
jest.unstable_mockModule('../src/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        evaluated: jest.fn(),
        skipped: jest.fn(),
        notified: jest.fn(),
    },
}));

// Mock sanitize-html
jest.unstable_mockModule('sanitize-html', () => ({
    default: (html) => (html || '').replace(/<[^>]*>/g, '').trim(),
}));

// Mock rss-parser
const mockParseURL = jest.fn();
jest.unstable_mockModule('rss-parser', () => ({
    default: class {
        parseURL = mockParseURL;
    },
}));

// Mock p-limit to run sequentially in tests
jest.unstable_mockModule('p-limit', () => ({
    default: () => (fn) => fn(),
}));

const { fetchAllFeeds } = await import('../src/feeds.js');

const baseConfig = {
    maxConcurrentFeeds: 3,
    maxRetries: 1,
};

afterEach(() => {
    mockParseURL.mockReset();
});

describe('fetchAllFeeds', () => {
    test('returns parsed items for successful feeds', async () => {
        mockParseURL.mockResolvedValue({
            items: [
                { title: 'Job 1', link: 'https://example.com/1', pubDate: '2024-01-01', guid: 'g1' },
                { title: 'Job 2', link: 'https://example.com/2', pubDate: '2024-01-02', guid: 'g2' },
            ],
        });

        const results = await fetchAllFeeds(['https://feed1.com/rss'], baseConfig);
        expect(results).toHaveLength(1);
        expect(results[0].items).toHaveLength(2);
        expect(results[0].items[0].title).toBe('Job 1');
        expect(results[0].error).toBeUndefined();
    });

    test('handles feed fetch errors gracefully', async () => {
        mockParseURL.mockRejectedValue(new Error('Network timeout'));

        const results = await fetchAllFeeds(['https://bad-feed.com/rss'], baseConfig);
        expect(results).toHaveLength(1);
        expect(results[0].items).toHaveLength(0);
        expect(results[0].error).toBe('Network timeout');
    });

    test('handles mix of successful and failed feeds', async () => {
        mockParseURL
            .mockResolvedValueOnce({
                items: [{ title: 'Good Job', link: 'https://x.com/1', guid: 'g1' }],
            })
            .mockRejectedValueOnce(new Error('Timeout'));

        const results = await fetchAllFeeds(
            ['https://good.com/rss', 'https://bad.com/rss'],
            baseConfig
        );

        expect(results).toHaveLength(2);
        expect(results[0].items).toHaveLength(1);
        expect(results[1].items).toHaveLength(0);
        expect(results[1].error).toBe('Timeout');
    });

    test('sanitizes HTML from item titles and content', async () => {
        mockParseURL.mockResolvedValue({
            items: [
                {
                    title: '<b>Bold</b> Title',
                    content: '<script>alert("xss")</script>Safe content',
                    link: 'https://x.com/1',
                    guid: 'g1',
                },
            ],
        });

        const results = await fetchAllFeeds(['https://feed.com/rss'], baseConfig);
        expect(results[0].items[0].title).toBe('Bold Title');
        expect(results[0].items[0].content).toBe('alert("xss")Safe content');
    });

    test('returns empty results for empty feed URLs array', async () => {
        const results = await fetchAllFeeds([], baseConfig);
        expect(results).toHaveLength(0);
    });
});
