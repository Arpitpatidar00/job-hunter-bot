/**
 * @file tests/batcher.test.js
 * @description Unit tests for feed batch splitting and cron interval offset logic.
 */

import { splitFeedsIntoBatches, getBatchId, selectBatch } from '../src/core/batcher.js';

describe('splitFeedsIntoBatches', () => {
    test('splits evenly divisible counts', () => {
        const feeds = [1, 2, 3, 4, 5, 6];
        const batches = splitFeedsIntoBatches(feeds, 3);
        expect(batches).toHaveLength(3);
        expect(batches[0]).toEqual([1, 2]);
        expect(batches[1]).toEqual([3, 4]);
        expect(batches[2]).toEqual([5, 6]);
    });

    test('splits uneven counts', () => {
        const feeds = [1, 2, 3, 4, 5, 6, 7];
        const batches = splitFeedsIntoBatches(feeds, 3);
        expect(batches).toHaveLength(3);
        expect(batches[0]).toEqual([1, 2, 3]); // Math.ceil(7/3) = 3
        expect(batches[1]).toEqual([4, 5, 6]);
        expect(batches[2]).toEqual([7]);
    });

    test('handles less feeds than batch count', () => {
        const feeds = [1, 2];
        const batches = splitFeedsIntoBatches(feeds, 3);
        expect(batches).toHaveLength(2); // Only creates needed batches
        expect(batches[0]).toEqual([1]);
        expect(batches[1]).toEqual([2]);
    });

    test('handles empty or null feeds', () => {
        expect(splitFeedsIntoBatches([], 3)).toEqual([]);
        expect(splitFeedsIntoBatches(null, 3)).toEqual([]);
    });

    test('handles batch count <= 1', () => {
        const feeds = [1, 2];
        expect(splitFeedsIntoBatches(feeds, 1)).toEqual([[1, 2]]);
        expect(splitFeedsIntoBatches(feeds, 0)).toEqual([[1, 2]]);
    });
});

describe('getBatchId', () => {
    // Cron staggered offsets:
    // Batch 0: :00, :15, :30, :45
    // Batch 1: :05, :20, :35, :50
    // Batch 2: :10, :25, :40, :55

    function makeTime(minute) {
        const d = new Date('2026-01-01T00:00:00Z');
        d.setUTCMinutes(minute);
        return d.getTime();
    }

    test('assigns minute :00 to batch 0', () => {
        expect(getBatchId(makeTime(0), 3)).toBe(0);
        expect(getBatchId(makeTime(15), 3)).toBe(0);
        expect(getBatchId(makeTime(30), 3)).toBe(0);
        expect(getBatchId(makeTime(45), 3)).toBe(0);
    });

    test('assigns minute :05 to batch 1', () => {
        expect(getBatchId(makeTime(5), 3)).toBe(1);
        expect(getBatchId(makeTime(20), 3)).toBe(1);
        expect(getBatchId(makeTime(35), 3)).toBe(1);
        expect(getBatchId(makeTime(50), 3)).toBe(1);
    });

    test('assigns minute :10 to batch 2', () => {
        expect(getBatchId(makeTime(10), 3)).toBe(2);
        expect(getBatchId(makeTime(25), 3)).toBe(2);
        expect(getBatchId(makeTime(40), 3)).toBe(2);
        expect(getBatchId(makeTime(55), 3)).toBe(2);
    });

    test('handles safe max bounds', () => {
        // If someone passes a weird offset like :14, it should map safely
        expect(getBatchId(makeTime(14), 3)).toBeLessThan(3);
        expect(getBatchId(makeTime(14), 3)).toBeGreaterThanOrEqual(0);
    });
});

describe('selectBatch', () => {
    const feeds = ['A', 'B', 'C', 'D', 'E', 'F'];

    test('selects correct subset for minute 0', () => {
        const t = new Date('2026-01-01T00:00:00Z').getTime();
        const result = selectBatch(feeds, t, 3);
        expect(result.batchId).toBe(0);
        expect(result.batch).toEqual(['A', 'B']);
        expect(result.total).toBe(6);
    });

    test('fallback to full list if batching broken by weird data', () => {
        const t = new Date('2026-01-01T00:10:00Z').getTime(); // Batch 2
        // Say we only have 1 feed, so batch 2 doesn't exist. It should fallback to max available or empty.
        const result = selectBatch(['A'], t, 3);
        expect(result.batchId).toBe(0); // Clamped to max valid index
        expect(result.batch).toEqual(['A']);
    });
});
