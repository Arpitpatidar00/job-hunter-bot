/**
 * @file tests/feedHealth.test.js
 * @description Unit tests for circuit breaker logic.
 */

import { recordFeedResult, isFeedCircuitOpen, getFeedHealthReport, resetFeedCircuit } from '../src/intelligence/feedHealth.js';

// Simple in-memory KV mock
class MockKV {
    constructor() { this.store = new Map(); }
    async get(key) { return this.store.get(key) || null; }
    async put(key, val) { this.store.set(key, val); }
    async delete(key) { this.store.delete(key); }
}

describe('Feed Health & Circuit Breaker', () => {
    let kv;
    const url = 'https://example.com/rss';

    beforeEach(() => { kv = new MockKV(); });

    test('recordFeedResult tracks successes and latency', async () => {
        await recordFeedResult(kv, url, { success: true, latencyMs: 500 });
        await recordFeedResult(kv, url, { success: true, latencyMs: 1500 });

        const report = await getFeedHealthReport(kv, [url]);
        expect(report).toHaveLength(1);
        expect(report[0].successRate).toBe(100);
        expect(report[0].avgLatencyMs).toBe(1000); // (500 + 1500) / 2
        expect(report[0].circuitOpen).toBe(false);
    });

    test('circuit opens after 5 consecutive failures', async () => {
        for (let i = 0; i < 4; i++) {
            await recordFeedResult(kv, url, { success: false });
        }
        expect(await isFeedCircuitOpen(kv, url)).toBe(false); // 4 failures = still closed

        // 5th failure trips it
        await recordFeedResult(kv, url, { success: false });
        expect(await isFeedCircuitOpen(kv, url)).toBe(true);

        const report = await getFeedHealthReport(kv, [url]);
        expect(report[0].circuitOpen).toBe(true);
        expect(report[0].successRate).toBe(0);
    });

    test('circuit resets after 1 success', async () => {
        // Cause 5 failures
        for (let i = 0; i < 5; i++) await recordFeedResult(kv, url, { success: false });
        expect(await isFeedCircuitOpen(kv, url)).toBe(true); // Open

        // 1 success
        await recordFeedResult(kv, url, { success: true });
        expect(await isFeedCircuitOpen(kv, url)).toBe(false); // Closed (recovering)

        const report = await getFeedHealthReport(kv, [url]);
        expect(report[0].consecutiveFailures).toBe(0);
        expect(report[0].successRate).toBe(17); // 1 success out of 6 attempts
    });

    test('resetFeedCircuit manually closes circuit and resets consecutive count', async () => {
        for (let i = 0; i < 5; i++) await recordFeedResult(kv, url, { success: false });
        expect(await isFeedCircuitOpen(kv, url)).toBe(true); // Open

        await resetFeedCircuit(kv, url);
        expect(await isFeedCircuitOpen(kv, url)).toBe(false);

        const report = await getFeedHealthReport(kv, [url]);
        expect(report[0].consecutiveFailures).toBe(0); // Manual reset wipes consecutive
    });
});
