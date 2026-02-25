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
    },
}));

// Mock sanitize-html
jest.unstable_mockModule('sanitize-html', () => ({
    default: (html) => (html || '').replace(/<[^>]*>/g, '').trim(),
}));

const { retryWithBackoff, parseDate, sanitizeText, parseInterval, escapeRegex } = await import('../src/utils.js');

describe('retryWithBackoff', () => {
    test('succeeds on first attempt', async () => {
        const fn = jest.fn().mockResolvedValue('success');
        const result = await retryWithBackoff(fn, 3, 10);
        expect(result).toBe('success');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('retries and succeeds on later attempt', async () => {
        const fn = jest.fn()
            .mockRejectedValueOnce(new Error('fail 1'))
            .mockResolvedValue('success');
        const result = await retryWithBackoff(fn, 3, 10);
        expect(result).toBe('success');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    test('throws after all retries exhausted', async () => {
        const fn = jest.fn().mockRejectedValue(new Error('persistent fail'));
        await expect(retryWithBackoff(fn, 2, 10)).rejects.toThrow('persistent fail');
        expect(fn).toHaveBeenCalledTimes(2);
    });
});

describe('parseDate', () => {
    test('parses ISO 8601 date', () => {
        const d = parseDate('2024-01-15T10:30:00Z');
        expect(d).toBeInstanceOf(Date);
        expect(d.getFullYear()).toBe(2024);
    });

    test('parses RFC 2822 date', () => {
        const d = parseDate('Mon, 15 Jan 2024 10:30:00 GMT');
        expect(d).toBeInstanceOf(Date);
        expect(d.getFullYear()).toBe(2024);
    });

    test('returns null for invalid string', () => {
        const d = parseDate('not-a-date-at-all-xyz');
        expect(d).toBeNull();
    });

    test('returns null for empty/null input', () => {
        expect(parseDate(null)).toBeNull();
        expect(parseDate('')).toBeNull();
        expect(parseDate(undefined)).toBeNull();
    });
});

describe('sanitizeText', () => {
    test('strips HTML tags', () => {
        expect(sanitizeText('<b>Bold</b> text')).toBe('Bold text');
    });

    test('handles plain text', () => {
        expect(sanitizeText('Hello world')).toBe('Hello world');
    });

    test('returns empty string for null/undefined', () => {
        expect(sanitizeText(null)).toBe('');
        expect(sanitizeText(undefined)).toBe('');
    });
});

describe('parseInterval', () => {
    test('parses "30m" to 1800000ms', () => {
        expect(parseInterval('30m')).toBe(30 * 60 * 1000);
    });

    test('parses "1h" to 3600000ms', () => {
        expect(parseInterval('1h')).toBe(60 * 60 * 1000);
    });

    test('parses "2h30m" to combined ms', () => {
        expect(parseInterval('2h30m')).toBe(2 * 60 * 60 * 1000 + 30 * 60 * 1000);
    });

    test('parses "15m" correctly', () => {
        expect(parseInterval('15m')).toBe(15 * 60 * 1000);
    });

    test('passes through numeric input as-is', () => {
        expect(parseInterval(5000)).toBe(5000);
    });

    test('parses plain number string as ms', () => {
        expect(parseInterval('10000')).toBe(10000);
    });

    test('throws for invalid format', () => {
        expect(() => parseInterval('abc')).toThrow();
    });
});

describe('escapeRegex', () => {
    test('escapes special regex characters', () => {
        expect(escapeRegex('node.js')).toBe('node\\.js');
        expect(escapeRegex('c++')).toBe('c\\+\\+');
        expect(escapeRegex('a*b')).toBe('a\\*b');
    });

    test('leaves plain strings unchanged', () => {
        expect(escapeRegex('javascript')).toBe('javascript');
        expect(escapeRegex('react')).toBe('react');
    });
});
