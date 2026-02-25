/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock the logger
jest.unstable_mockModule('../src/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const { loadSeenJobs, saveSeenJobs, markSeen, hasSeen } = await import('../src/storage.js');

const TMP_DIR = path.join(os.tmpdir(), 'job-hunter-test-' + Date.now());
const TEST_FILE = path.join(TMP_DIR, 'test_seen.json');

beforeAll(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

afterEach(() => {
    // Clean up test files
    for (const f of [TEST_FILE, `${TEST_FILE}.tmp`, `${TEST_FILE}.bak`]) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
});

describe('loadSeenJobs', () => {
    test('returns empty Map when file does not exist', () => {
        const map = loadSeenJobs(path.join(TMP_DIR, 'nonexistent.json'));
        expect(map).toBeInstanceOf(Map);
        expect(map.size).toBe(0);
    });

    test('loads new Map format (object with timestamps)', () => {
        const data = { 'job-1': 1700000000000, 'job-2': 1700000100000 };
        fs.writeFileSync(TEST_FILE, JSON.stringify(data));
        const map = loadSeenJobs(TEST_FILE);
        expect(map.size).toBe(2);
        expect(map.get('job-1')).toBe(1700000000000);
    });

    test('migrates legacy array format', () => {
        const data = ['job-a', 'job-b', 'job-c'];
        fs.writeFileSync(TEST_FILE, JSON.stringify(data));
        const map = loadSeenJobs(TEST_FILE);
        expect(map.size).toBe(3);
        expect(map.has('job-a')).toBe(true);
        expect(typeof map.get('job-a')).toBe('number');
    });

    test('returns empty Map for corrupt JSON', () => {
        fs.writeFileSync(TEST_FILE, '{broken json!!!');
        const map = loadSeenJobs(TEST_FILE);
        expect(map.size).toBe(0);
    });
});

describe('saveSeenJobs', () => {
    test('writes Map to file correctly', () => {
        const map = new Map([['job-x', 123], ['job-y', 456]]);
        saveSeenJobs(TEST_FILE, map);

        const raw = fs.readFileSync(TEST_FILE, 'utf8');
        const data = JSON.parse(raw);
        expect(data['job-x']).toBe(123);
        expect(data['job-y']).toBe(456);
    });

    test('creates backup file on subsequent saves', () => {
        const map1 = new Map([['old-job', 100]]);
        saveSeenJobs(TEST_FILE, map1);

        const map2 = new Map([['old-job', 100], ['new-job', 200]]);
        saveSeenJobs(TEST_FILE, map2);

        expect(fs.existsSync(`${TEST_FILE}.bak`)).toBe(true);
        const backupData = JSON.parse(fs.readFileSync(`${TEST_FILE}.bak`, 'utf8'));
        expect(backupData['old-job']).toBe(100);
        expect(backupData['new-job']).toBeUndefined();
    });
});

describe('markSeen / hasSeen', () => {
    test('marks a job as seen and can query it', () => {
        const map = new Map();
        expect(hasSeen(map, 'job-1')).toBe(false);
        markSeen(map, 'job-1');
        expect(hasSeen(map, 'job-1')).toBe(true);
    });

    test('markSeen stores a timestamp', () => {
        const map = new Map();
        const before = Date.now();
        markSeen(map, 'job-ts');
        const after = Date.now();
        const ts = map.get('job-ts');
        expect(ts).toBeGreaterThanOrEqual(before);
        expect(ts).toBeLessThanOrEqual(after);
    });
});
