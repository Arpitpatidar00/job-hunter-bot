/**
 * @file tests/notificationQueue.test.js
 * @description Unit tests for the alert retry buffer.
 * @jest-environment node
 */
import { jest } from '@jest/globals';

// Mock notifications.js (ESM-compatible)
const mockSendAlert = jest.fn();
jest.unstable_mockModule('../src/notifications/notifications.js', () => ({
    sendAlert: mockSendAlert,
}));

// Mock logger
jest.unstable_mockModule('../src/core/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { queueFailedAlert, drainRetryQueue, getQueueStats } = await import('../src/notifications/notificationQueue.js');

// Simple in-memory KV mock
class MockKV {
    constructor() { this.store = new Map(); }
    async get(key) { return this.store.get(key) ?? null; }
    async put(key, val) { this.store.set(key, val); }
    async delete(key) { this.store.delete(key); }
    async list({ prefix }) {
        const keys = [];
        for (const k of this.store.keys()) {
            if (k.startsWith(prefix)) keys.push({ name: k });
        }
        return { keys };
    }
}

describe('Notification Retry Queue', () => {
    let kv, mockEnv, mockConfig;

    beforeEach(() => {
        kv = new MockKV();
        mockEnv = {};
        mockConfig = { dryRun: false };
        mockSendAlert.mockReset();
    });

    const dummyJob = { id: 'job-123', title: 'Test Job', company: 'Acme', link: 'http://a.com' };
    const dummyScore = { score: 90, label: 'High', color: '🟢', reasons: [], matchedSkills: [] };

    test('queueFailedAlert adds job to queue correctly', async () => {
        await queueFailedAlert(kv, dummyJob, dummyScore);

        const stats = await getQueueStats(kv);
        expect(stats.pending).toBe(1);
        expect(stats.items[0].title).toBe('Test Job');
        expect(stats.items[0].attempts).toBe(0);
    });

    test('queueFailedAlert does not duplicate existing entries', async () => {
        await queueFailedAlert(kv, dummyJob, dummyScore);

        // Simulating a second failure for the exact same job ID
        // e.g. from a different feed source overlapping
        await queueFailedAlert(kv, dummyJob, dummyScore);

        const stats = await getQueueStats(kv);
        expect(stats.pending).toBe(1); // Still 1
    });

    test('drainRetryQueue resends and removes on success', async () => {
        await queueFailedAlert(kv, dummyJob, dummyScore);
        expect((await getQueueStats(kv)).pending).toBe(1);

        // Simulate success send
        mockSendAlert.mockResolvedValue({ sent: 1, failed: 0, channels: ['Discord'] });

        const drainStats = await drainRetryQueue(kv, mockEnv, mockConfig);
        expect(drainStats.retried).toBe(1);
        expect(drainStats.succeeded).toBe(1);
        expect(drainStats.dropped).toBe(0);

        // Queue should be empty now
        expect((await getQueueStats(kv)).pending).toBe(0);
        expect(mockSendAlert).toHaveBeenCalledTimes(1);
    });

    test('drainRetryQueue resends and keeps in queue on failure', async () => {
        await queueFailedAlert(kv, dummyJob, dummyScore);

        // Simulate failed send
        mockSendAlert.mockRejectedValue(new Error('Network Error'));

        const drainStats = await drainRetryQueue(kv, mockEnv, mockConfig);
        expect(drainStats.retried).toBe(1);
        expect(drainStats.succeeded).toBe(0);
        expect(drainStats.dropped).toBe(0);

        // Still pending, attempts = 1
        const stats = await getQueueStats(kv);
        expect(stats.pending).toBe(1);
        expect(stats.items[0].attempts).toBe(1);
    });

    test('drainRetryQueue drops alert after 3 failed attempts (run 4)', async () => {
        await queueFailedAlert(kv, dummyJob, dummyScore);

        // Simulate failed sends
        mockSendAlert.mockRejectedValue(new Error('Discord 500'));

        await drainRetryQueue(kv, mockEnv, mockConfig); // Attempt 1
        await drainRetryQueue(kv, mockEnv, mockConfig); // Attempt 2
        await drainRetryQueue(kv, mockEnv, mockConfig); // Attempt 3

        // Still pending
        let stats = await getQueueStats(kv);
        expect(stats.items[0].attempts).toBe(3);
        expect(stats.pending).toBe(1);

        // Attempt 4 -> max retries exceeded, drop the item
        const finalDrain = await drainRetryQueue(kv, mockEnv, mockConfig);
        expect(finalDrain.retried).toBe(1);
        expect(finalDrain.dropped).toBe(1);

        stats = await getQueueStats(kv);
        expect(stats.pending).toBe(0); // Dropped
    });
});
