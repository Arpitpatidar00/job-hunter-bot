/**
 * @file dedup.unit.test.js
 * @description Unit tests for src/core/dedup.js
 */

import {
    computeSimilarityHash,
    clusterDuplicates,
    cosineSimilarity,
    isDuplicateByEmbedding,
} from '../src/core/dedup.js';

// ── computeSimilarityHash ─────────────────────────────────────────────────────

describe('computeSimilarityHash', () => {
    test('returns consistent 8-char hex hash', () => {
        const hash = computeSimilarityHash('Senior React Developer', 'Acme Corp');
        expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });

    test('same company+title → same hash regardless of URL differences', () => {
        const hash1 = computeSimilarityHash('React Developer', 'Acme Corp');
        const hash2 = computeSimilarityHash('React Developer', 'Acme Corp');
        expect(hash1).toBe(hash2);
    });

    test('normalizes legal suffixes — "Acme Inc" === "Acme"', () => {
        const h1 = computeSimilarityHash('React Developer', 'Acme Inc');
        const h2 = computeSimilarityHash('React Developer', 'Acme');
        expect(h1).toBe(h2);
    });

    test('different companies → different hashes', () => {
        const h1 = computeSimilarityHash('Backend Engineer', 'Alpha Inc');
        const h2 = computeSimilarityHash('Backend Engineer', 'Beta Inc');
        expect(h1).not.toBe(h2);
    });

    test('handles empty strings without throwing', () => {
        expect(() => computeSimilarityHash('', '')).not.toThrow();
    });
});

// ── clusterDuplicates ─────────────────────────────────────────────────────────

describe('clusterDuplicates', () => {
    const makeJob = (title, company, url, pubDate = '2026-03-05T00:00:00Z') => ({
        title,
        company,
        link: url,
        pubDate,
        similarity_hash: computeSimilarityHash(title, company),
        content_hash: `hash-${url}`,
    });

    test('passes through single unique jobs unchanged', () => {
        const jobs = [
            makeJob('React Developer', 'Acme', 'https://a.com/1'),
            makeJob('Node.js Engineer', 'Beta', 'https://b.com/2'),
        ];
        const { uniqueJobs, duplicatesFound } = clusterDuplicates(jobs);
        expect(uniqueJobs).toHaveLength(2);
        expect(duplicatesFound).toBe(0);
    });

    test('clusters cross-source duplicates by similarity_hash', () => {
        const jobs = [
            makeJob('React Developer', 'Acme Inc', 'https://greenhouse.io/acme/1', '2026-03-01T00:00:00Z'),
            makeJob('React Developer', 'Acme',     'https://lever.co/acme/1',     '2026-03-02T00:00:00Z'),
        ];
        const { uniqueJobs, duplicatesFound } = clusterDuplicates(jobs);
        expect(uniqueJobs).toHaveLength(1);
        expect(duplicatesFound).toBe(1);
    });

    test('keeps earliest pubDate as canonical representative', () => {
        const jobs = [
            makeJob('React Developer', 'Acme', 'https://source1.com', '2026-03-02T00:00:00Z'),
            makeJob('React Developer', 'Acme', 'https://source2.com', '2026-03-01T00:00:00Z'), // earlier
        ];
        const { uniqueJobs } = clusterDuplicates(jobs);
        expect(uniqueJobs[0].link).toBe('https://source2.com');
    });

    test('handles empty input', () => {
        const { uniqueJobs, duplicatesFound } = clusterDuplicates([]);
        expect(uniqueJobs).toHaveLength(0);
        expect(duplicatesFound).toBe(0);
    });

    test('handles jobs without similarity_hash (falls back to computing it)', () => {
        const jobs = [
            { title: 'Engineer', company: 'Acme', link: 'https://x.com', pubDate: '' },
            { title: 'Engineer', company: 'Acme', link: 'https://y.com', pubDate: '' },
        ];
        const { uniqueJobs, duplicatesFound } = clusterDuplicates(jobs);
        expect(uniqueJobs).toHaveLength(1);
        expect(duplicatesFound).toBe(1);
    });
});

// ── cosineSimilarity ──────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
    test('identical vectors → similarity = 1', () => {
        const vec = [1, 0, 1, 0];
        expect(cosineSimilarity(vec, vec)).toBeCloseTo(1, 5);
    });

    test('orthogonal vectors → similarity = 0', () => {
        expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    });

    test('returns 0 for empty/mismatched vectors', () => {
        expect(cosineSimilarity([], [])).toBe(0);
        expect(cosineSimilarity([1, 2], [1])).toBe(0);
    });
});

// ── isDuplicateByEmbedding ────────────────────────────────────────────────────

describe('isDuplicateByEmbedding', () => {
    test('returns true when similarity ≥ threshold', () => {
        const vec = [1, 0, 0, 0];
        expect(isDuplicateByEmbedding(vec, vec, 0.88)).toBe(true);
    });

    test('returns false when similarity < threshold', () => {
        expect(isDuplicateByEmbedding([1, 0], [0, 1], 0.88)).toBe(false);
    });

    test('uses 0.88 as default threshold', () => {
        const a = [0.9, 0.1];
        const b = [0.8, 0.2];
        const sim = cosineSimilarity(a, b);
        expect(isDuplicateByEmbedding(a, b)).toBe(sim >= 0.88);
    });
});
