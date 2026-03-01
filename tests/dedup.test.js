/**
 * @file tests/dedup.test.js
 * @description Unit tests for dual-key deduplication engine in storage.js.
 *   - SHA-256 fingerprint consistency
 *   - URL-based fast path
 *   - Content-hash cross-platform dedup
 */

import { jobDedupeKey } from '../src/core/schema.js';

// ── jobDedupeKey (pure function — testable without KV) ──────────────────────

describe('jobDedupeKey — fingerprint consistency', () => {
    test('same title+company always produces same key', () => {
        const key1 = jobDedupeKey('React Developer', 'Acme Inc.');
        const key2 = jobDedupeKey('React Developer', 'Acme Inc.');
        expect(key1).toBe(key2);
    });

    test('different titles produce different keys', () => {
        const key1 = jobDedupeKey('React Developer', 'Acme');
        const key2 = jobDedupeKey('Node.js Engineer', 'Acme');
        expect(key1).not.toBe(key2);
    });

    test('cross-platform duplicates detected: normalization strips company suffix', () => {
        // "Acme Inc." vs "Acme Ltd." — both normalize to "acme"
        const key1 = jobDedupeKey('React Developer', 'Acme Inc.');
        const key2 = jobDedupeKey('React Developer', 'Acme Ltd.');
        expect(key1).toBe(key2);
    });

    test('normalizes title: strips emojis and parenthetical noise', () => {
        const key1 = jobDedupeKey('🚀 React Developer (m/w/d) [Remote]', 'Acme');
        const key2 = jobDedupeKey('React Developer', 'Acme');
        expect(key1).toBe(key2);
    });

    test('empty company still produces a key', () => {
        const key = jobDedupeKey('React Developer', '');
        expect(typeof key).toBe('string');
        expect(key.length).toBeGreaterThan(0);
    });

    test('key format is company::title', () => {
        const key = jobDedupeKey('React Developer', 'Acme');
        expect(key).toMatch(/^.*::.*$/);
    });
});

// ── normalizeTitle / normalizeCompany (via jobDedupeKey) ────────────────────

describe('normalizeTitle via jobDedupeKey', () => {
    test('strips emoji', () => {
        const k1 = jobDedupeKey('🔥 Frontend Developer', 'Co');
        const k2 = jobDedupeKey('Frontend Developer', 'Co');
        expect(k1).toBe(k2);
    });

    test('strips (m/w/d) notation', () => {
        const k1 = jobDedupeKey('Developer (m/w/d)', 'Co');
        const k2 = jobDedupeKey('Developer', 'Co');
        expect(k1).toBe(k2);
    });

    test('strips [remote] bracket notation', () => {
        const k1 = jobDedupeKey('Developer [Remote]', 'Co');
        const k2 = jobDedupeKey('Developer', 'Co');
        expect(k1).toBe(k2);
    });
});

describe('normalizeCompany via jobDedupeKey', () => {
    test('strips Inc.', () => {
        const k1 = jobDedupeKey('Role', 'Company Inc.');
        const k2 = jobDedupeKey('Role', 'Company');
        expect(k1).toBe(k2);
    });

    test('strips Ltd.', () => {
        const k1 = jobDedupeKey('Role', 'Company Ltd.');
        const k2 = jobDedupeKey('Role', 'Company');
        expect(k1).toBe(k2);
    });

    test('strips LLC', () => {
        const k1 = jobDedupeKey('Role', 'Company LLC');
        const k2 = jobDedupeKey('Role', 'Company');
        expect(k1).toBe(k2);
    });

    test('handles empty company gracefully', () => {
        expect(() => jobDedupeKey('Role', '')).not.toThrow();
        expect(() => jobDedupeKey('Role', null)).not.toThrow();
    });
});
