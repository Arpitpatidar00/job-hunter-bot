/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../src/core/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        evaluated: jest.fn(),
        notified: jest.fn(),
    },
}));

const { hasSeen, markSeen } = await import('../src/storage/storage.js');

/**
 * Simple in-memory KV mock matching Cloudflare KV namespace interface.
 */
class MockKV {
    constructor() { this.store = new Map(); }
    async get(key) { return this.store.get(key) ?? null; }
    async put(key, val, _opts) { this.store.set(key, val); }
    async delete(key) { this.store.delete(key); }
}

describe('hasSeen (KV-based)', () => {
    test('returns { seen: false } for unseen job', async () => {
        const kv = new MockKV();
        const result = await hasSeen(kv, 'job-1');
        expect(result.seen).toBe(false);
    });

    test('returns { seen: true, reason: "url" } after markSeen', async () => {
        const kv = new MockKV();
        await markSeen(kv, 'job-1', { title: 'React Dev', company: 'Acme' });
        const result = await hasSeen(kv, 'job-1', { title: 'React Dev', company: 'Acme' });
        expect(result.seen).toBe(true);
        expect(result.reason).toBe('url');
    });

    test('content-hash dedup catches cross-platform duplicates', async () => {
        const kv = new MockKV();
        const job1 = { title: 'React Developer', company: 'Acme' };
        const job2 = { title: 'React Developer', company: 'Acme' };

        await markSeen(kv, 'guid-from-source-a', job1);

        // Same job, different ID (from a different feed)
        const result = await hasSeen(kv, 'guid-from-source-b', job2);
        expect(result.seen).toBe(true);
        expect(result.reason).toBe('content-hash');
    });

    test('different jobs are not falsely detected as duplicates', async () => {
        const kv = new MockKV();
        await markSeen(kv, 'job-a', { title: 'React Dev', company: 'Acme' });
        const result = await hasSeen(kv, 'job-b', { title: 'Node.js Engineer', company: 'Beta Corp' });
        expect(result.seen).toBe(false);
    });

    test('handles missing job object gracefully', async () => {
        const kv = new MockKV();
        const result = await hasSeen(kv, 'job-1');
        expect(result.seen).toBe(false);
    });
});

describe('markSeen (KV-based)', () => {
    test('stores both url key and content-hash key', async () => {
        const kv = new MockKV();
        await markSeen(kv, 'job-123', { title: 'Dev', company: 'Co' });

        // URL key should exist
        expect(await kv.get('seen:job-123')).not.toBeNull();

        // Content-hash key should also exist (starts with 'seen:hash:')
        const keys = [...kv.store.keys()];
        const hashKey = keys.find(k => k.startsWith('seen:hash:'));
        expect(hashKey).toBeDefined();
    });

    test('does not throw on null job object', async () => {
        const kv = new MockKV();
        await expect(markSeen(kv, 'job-1')).resolves.not.toThrow();
    });
});
