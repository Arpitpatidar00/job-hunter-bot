/**
 * @file tests/threshold.test.js
 * @description Unit tests for dynamic threshold logic.
 */

import { recordJobScore, computeWindowStats, getEffectiveThreshold } from '../src/intelligence/threshold.js';

// Simple in-memory KV mock for testing
class MockKV {
    constructor() { this.store = new Map(); }
    async get(key) { return this.store.get(key) || null; }
    async put(key, val) { this.store.set(key, val); }
    async delete(key) { this.store.delete(key); }
}

describe('Dynamic Threshold Engine', () => {
    let kv;
    beforeEach(() => { kv = new MockKV(); });

    test('recordJobScore keeps rolling window under 200', async () => {
        for (let i = 0; i < 205; i++) {
            await recordJobScore(kv, i);
        }

        const raw = await kv.get('thresh:window');
        const window = JSON.parse(raw);
        expect(window).toHaveLength(200);
        expect(window[0]).toBe(5); // oldest 5 dropped
        expect(window[199]).toBe(204);
    });

    test('computeWindowStats gets correct mean, p75, p90', async () => {
        // Add 1 to 100
        for (let i = 1; i <= 100; i++) await recordJobScore(kv, i);

        const stats = await computeWindowStats(kv);
        expect(stats.sampleSize).toBe(100);
        expect(stats.mean).toBe(51); // (1+100)/2 = 50.5 -> 51
        expect(stats.p75).toBe(76);
        expect(stats.p90).toBe(91);
    });

    test('getEffectiveThreshold returns base config if no context', async () => {
        const t = await getEffectiveThreshold(kv, 50); // no context
        expect(t.effective).toBe(50);
        expect(t.adjusted).toBe(false);
    });

    test('getEffectiveThreshold raises bar if matches > 8', async () => {
        const t = await getEffectiveThreshold(kv, 50, { matchedLastRun: 15 });
        expect(t.effective).toBe(52); // 50 + 2
        expect(t.adjusted).toBe(true);

        // Verify it was saved
        const effective2 = await getEffectiveThreshold(kv, 50, { matchedLastRun: 5 });
        expect(effective2.effective).toBe(52); // didn't change because matches=5 is within target [1, 8]
    });

    test('getEffectiveThreshold lowers bar if matches < 1', async () => {
        const t = await getEffectiveThreshold(kv, 50, { matchedLastRun: 0 });
        expect(t.effective).toBe(48); // 50 - 2
        expect(t.adjusted).toBe(true);
    });

    test('guardrails max 75', async () => {
        await kv.put('thresh:effective', '74');
        const t = await getEffectiveThreshold(kv, 50, { matchedLastRun: 20 });
        expect(t.effective).toBe(75); // Should cap at 75, not go to 76
    });

    test('guardrails min 35', async () => {
        await kv.put('thresh:effective', '36');
        const t = await getEffectiveThreshold(kv, 50, { matchedLastRun: 0 });
        expect(t.effective).toBe(35); // Should bottom at 35, not 34
    });
});
