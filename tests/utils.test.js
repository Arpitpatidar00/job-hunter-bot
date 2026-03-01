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

const {
    retryWithBackoff,
    parseDate,
    sanitizeText,
    escapeRegex,
    compareTwoStrings,
    pLimit,
    parseExperienceYears,
    extractSalaryUSD,
    detectRemoteType,
} = await import('../src/core/utils.js');

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

    test('decodes HTML entities', () => {
        expect(sanitizeText('A &amp; B')).toBe('A & B');
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

describe('compareTwoStrings', () => {
    test('identical strings return 1', () => {
        expect(compareTwoStrings('react', 'react')).toBe(1);
    });

    test('different strings return < 1', () => {
        expect(compareTwoStrings('react', 'angular')).toBeLessThan(1);
    });

    test('similar strings return high similarity', () => {
        expect(compareTwoStrings('reactjs', 'react.js')).toBeGreaterThan(0.5);
    });
});

describe('pLimit', () => {
    test('limits concurrent execution', async () => {
        const limit = pLimit(2);
        const results = [];
        const task = (val) => () => new Promise(resolve => {
            setTimeout(() => {
                results.push(val);
                resolve(val);
            }, 10);
        });

        const promises = [limit(task(1)), limit(task(2)), limit(task(3))];
        await Promise.all(promises);
        expect(results).toHaveLength(3);
    });
});

describe('parseExperienceYears', () => {
    test('parses "2-5 years"', () => {
        const result = parseExperienceYears('requires 2-5 years of experience');
        expect(result).toEqual({ min: 2, max: 5 });
    });

    test('parses "3+ years"', () => {
        const result = parseExperienceYears('minimum 3+ years');
        expect(result).toEqual({ min: 3, max: null });
    });

    test('returns null when no experience found', () => {
        expect(parseExperienceYears('just a description')).toBeNull();
    });
});

describe('extractSalaryUSD', () => {
    test('parses $80k-$120k', () => {
        const result = extractSalaryUSD('Salary: $80k-$120k per year');
        expect(result).not.toBeNull();
        expect(result.min).toBe(80000);
        expect(result.max).toBe(120000);
    });

    test('returns null when no salary present', () => {
        expect(extractSalaryUSD('No salary info here')).toBeNull();
    });

    test('parses LPA salary', () => {
        const result = extractSalaryUSD('salary 15-25 LPA');
        expect(result).not.toBeNull();
        expect(result.currency).toBe('INR');
    });
});

describe('detectRemoteType', () => {
    test('detects "fully remote"', () => {
        expect(detectRemoteType('This is a fully remote position')).toBe('remote');
    });

    test('detects hybrid', () => {
        expect(detectRemoteType('hybrid role, 3 days in office')).toBe('hybrid');
    });

    test('detects onsite', () => {
        expect(detectRemoteType('This is an on-site position, no remote')).toBe('onsite');
    });

    test('returns unknown when no signals', () => {
        expect(detectRemoteType('We are hiring a developer')).toBe('unknown');
    });
});
