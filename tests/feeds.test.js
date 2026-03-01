/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';

// Mock the logger
jest.unstable_mockModule('../src/core/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        evaluated: jest.fn(),
        skipped: jest.fn(),
        notified: jest.fn(),
    },
}));

// Mock the connector registry so we don't need fetch/HTMLRewriter
const mockRunAllConnectors = jest.fn();
jest.unstable_mockModule('../src/connectors/index.js', () => ({
    runAllConnectors: mockRunAllConnectors,
}));

const { fetchAllFeeds } = await import('../src/storage/feeds.js');

afterEach(() => {
    mockRunAllConnectors.mockReset();
});

describe('fetchAllFeeds', () => {
    test('returns parsed items for successful feeds', async () => {
        mockRunAllConnectors.mockResolvedValue({
            jobs: [
                { title: 'Job 1', link: 'https://example.com/1' },
                { title: 'Job 2', link: 'https://example.com/2' },
            ],
            feedStats: [{
                type: 'rss',
                url: 'https://feed1.com/rss',
                name: 'feed1.com',
                count: 2,
                error: null,
                items: [
                    { title: 'Job 1', link: 'https://example.com/1' },
                    { title: 'Job 2', link: 'https://example.com/2' },
                ],
            }],
        });

        const results = await fetchAllFeeds(['https://feed1.com/rss'], {});
        expect(results).toHaveLength(1);
        expect(results[0].items).toHaveLength(2);
        expect(results[0].items[0].title).toBe('Job 1');
        expect(results[0].error).toBeUndefined();
    });

    test('handles feed fetch errors gracefully', async () => {
        mockRunAllConnectors.mockResolvedValue({
            jobs: [],
            feedStats: [{
                type: 'rss',
                url: 'https://bad-feed.com/rss',
                name: 'bad-feed.com',
                count: 0,
                error: 'Network timeout',
                items: [],
            }],
        });

        const results = await fetchAllFeeds(['https://bad-feed.com/rss'], {});
        expect(results).toHaveLength(1);
        expect(results[0].items).toHaveLength(0);
        expect(results[0].error).toBe('Network timeout');
    });

    test('handles mix of successful and failed feeds', async () => {
        mockRunAllConnectors.mockResolvedValue({
            jobs: [{ title: 'Good Job', link: 'https://x.com/1' }],
            feedStats: [
                { type: 'rss', url: 'https://good.com/rss', name: 'good.com', count: 1, error: null, items: [{ title: 'Good Job', link: 'https://x.com/1' }] },
                { type: 'rss', url: 'https://bad.com/rss', name: 'bad.com', count: 0, error: 'Timeout', items: [] },
            ],
        });

        const results = await fetchAllFeeds(['https://good.com/rss', 'https://bad.com/rss'], {});
        expect(results).toHaveLength(2);
        expect(results[0].items).toHaveLength(1);
        expect(results[1].items).toHaveLength(0);
        expect(results[1].error).toBe('Timeout');
    });

    test('returns empty results for empty feed URLs array', async () => {
        mockRunAllConnectors.mockResolvedValue({
            jobs: [],
            feedStats: [],
        });

        const results = await fetchAllFeeds([], {});
        expect(results).toHaveLength(0);
    });

    test('passes feed URLs to connector via merged config', async () => {
        mockRunAllConnectors.mockResolvedValue({ jobs: [], feedStats: [] });

        const urls = ['https://a.com/rss', 'https://b.com/rss'];
        await fetchAllFeeds(urls, { someOption: true });

        expect(mockRunAllConnectors).toHaveBeenCalledWith(
            expect.objectContaining({
                feeds: urls,
                someOption: true,
            }),
        );
    });
});
