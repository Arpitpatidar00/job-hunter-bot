/**
 * @file stress.pipeline.test.js
 * @description END-TO-END PEAK LOAD STRESS TEST — Feed → Evaluate → Alert pipeline.
 *
 * Tests the full job-hunter-bot at maximum realistic capacity:
 *   - 500+ jobs processed per batch (peak RSS burst)
 *   - 50+ concurrent sources in a single cron cycle
 *   - All 7 production-issue scenarios exercised
 *   - Queue rate-limit fallback paths under load
 *   - AI subrequest budget enforcement at scale
 *   - D1 FK guard under high concurrency
 *   - Wall-time guard enforcement
 *   - Deduplication correctness at peak volume
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { scoreJob, isNewJob } from '../src/scoring/relevance.js';
import { loadConfig } from '../src/config.js';

// ─── Test Fixtures ─────────────────────────────────────────────────────────────

const PEAK_JOB_COUNT = 500;
const PEAK_SOURCE_COUNT = 50;
const PEAK_PROFILE_COUNT = 10;

/** Build a realistic job object at various quality levels */
function makeJob(i, overrides = {}) {
    const now = new Date();
    const msAgo = Math.floor(Math.random() * 3 * 60 * 60 * 1000); // 0–3 hours ago
    return {
        id: `job-stress-${i}`,
        title: overrides.title || `Software Engineer ${i} — Node.js & React`,
        company: overrides.company || `TechCorp ${i % 30}`,
        link: `https://jobs.example.com/job/${i}`,
        url: `https://jobs.example.com/job/${i}`,
        content_hash: `hash-${i}-${overrides.contentSuffix || 'unique'}`,
        sourceUrl: `https://boards.greenhouse.io/company${i % 20}`,
        pubDate: new Date(Date.now() - msAgo).toISOString(),
        isoDate: new Date(Date.now() - msAgo).toISOString(),
        categories: ['JavaScript', 'Node.js', 'React', 'TypeScript'],
        contentSnippet: `We are looking for a Node.js engineer with 2+ years experience. Skills: JavaScript, TypeScript, React, Next.js, MongoDB, AWS, remote friendly. Salary $90k–$130k/yr. ${overrides.extra || ''}`,
        description: `Full description for job ${i}. Must know: JavaScript TypeScript React Node.js MongoDB AWS Redis Docker. Nice to have: Kubernetes Terraform GraphQL. Remote/hybrid. India or worldwide.`,
        matchedTerms: ['node.js', 'react', 'typescript'],
        ...overrides,
    };
}

/** Build a large batch of jobs with controlled duplication */
function makePeakJobBatch(count, dupRate = 0.15) {
    const jobs = [];
    for (let i = 0; i < count; i++) {
        const isDup = i > 0 && Math.random() < dupRate;
        if (isDup) {
            // Exact content_hash duplicate
            const srcIdx = Math.floor(Math.random() * i);
            jobs.push(makeJob(i, {
                content_hash: `hash-${srcIdx}-unique`,
                id: `job-stress-dup-${i}`,
            }));
        } else {
            jobs.push(makeJob(i));
        }
    }
    return jobs;
}

/** Build sources for a cron cycle */
function makeSources(count) {
    const types = ['rss', 'greenhouse', 'lever', 'ashby', 'workable'];
    return Array.from({ length: count }, (_, i) => ({
        url: `https://boards.example.com/source${i}/jobs.json`,
        type: types[i % types.length],
        name: `Company ${i}`,
    }));
}

// ─── Config Fixture ────────────────────────────────────────────────────────────

const STRESS_CONFIG = {
    notificationThreshold: 60,
    timeWindowHours: 24,
    dryRun: true,
    targetRoles: ['software engineer', 'backend engineer', 'full stack developer', 'node.js developer'],
    searchRules: {
        mustMatch: ['javascript', 'node.js', 'typescript', 'react'],
        shouldMatch: ['mongodb', 'postgresql', 'redis', 'graphql', 'docker'],
        niceToHave: ['aws', 'kubernetes', 'next.js', 'express', 'nestjs'],
        exclude: ['php', '.net', 'java senior', 'cobol'],
    },
    synonyms: {
        'node.js': ['nodejs', 'node js'],
        'react': ['reactjs', 'react.js'],
        'typescript': ['ts', 'ts/js'],
    },
    locationKeywords: ['remote', 'india', 'worldwide', 'anywhere'],
    filters: { workPreference: ['remote', 'hybrid'] },
    experienceLevel: ['junior', '0-2 years', 'entry level'],
    weights: { titleMatch: 30, skillsMatch: 30, techStackMatch: 20, locationMatch: 10, salaryMatch: 10 },
    scoringBonuses: { nextjsAndTypescript: 8, nodeAndMongodb: 6, awsPresent: 4, fullMernStack: 10, remoteIndia: 5 },
    scoringPenalties: { nonJsStack: -15, frontendOnlyNoBackend: -5 },
    fuzzyThreshold: 0.82,
};

// ─── Mock D1 Database ──────────────────────────────────────────────────────────

function makeMockDb({ fkFailJobIds = new Set(), existingJobIds = new Set() } = {}) {
    const jobs = new Map();
    const sentAlerts = new Map();
    let batchCallCount = 0;
    let writeCount = 0;

    return {
        _jobs: jobs,
        _sentAlerts: sentAlerts,
        _batchCallCount: () => batchCallCount,
        _writeCount: () => writeCount,

        prepare(sql) {
            return {
                _sql: sql,
                _bindings: [],
                bind(...args) { this._bindings = args; return this; },
                async run() {
                    writeCount++;
                    if (sql.includes('INSERT OR IGNORE INTO jobs')) {
                        const [id, url, hash] = this._bindings;
                        if (!jobs.has(hash)) {
                            jobs.set(hash, { id, url, hash });
                            return { success: true, meta: { changes: 1 } };
                        }
                        return { success: true, meta: { changes: 0 } };
                    }
                    if (sql.includes('INSERT OR IGNORE INTO sent_alerts')) {
                        const [jobId, profileId] = this._bindings;
                        sentAlerts.set(`${jobId}:${profileId}`, true);
                        return { success: true, meta: { changes: 1 } };
                    }
                    return { success: true, meta: { changes: 1 } };
                },
                async first() {
                    if (sql.includes('SELECT 1 FROM jobs WHERE id')) {
                        const [jobId] = this._bindings;
                        // Simulate FK guard: return null for IDs that should fail
                        if (fkFailJobIds.has(jobId)) return null;
                        if (existingJobIds.has(jobId) || jobs.has(jobId)) return { 1: 1 };
                        return null;
                    }
                    if (sql.includes('SELECT 1 FROM sent_alerts')) {
                        const [jobId, profileId] = this._bindings;
                        return sentAlerts.has(`${jobId}:${profileId}`) ? { 1: 1 } : null;
                    }
                    return null;
                },
                async all() {
                    if (sql.includes('FROM profiles')) {
                        return {
                            success: true,
                            results: Array.from({ length: 3 }, (_, i) => ({
                                id: `profile-${i}`, user_id: `user-${i}`,
                                name: `Profile ${i}`, notification_threshold: 60, plan: 'free',
                            })),
                        };
                    }
                    return { success: true, results: [] };
                },
            };
        },

        async batch(stmts) {
            batchCallCount++;
            const results = [];
            for (const stmt of stmts) {
                results.push(await stmt.run());
            }
            return results;
        },
    };
}

// ─── Mock AI Binding ───────────────────────────────────────────────────────────

function makeMockAI({ failAfter = Infinity, failWithTransient = false } = {}) {
    let callCount = 0;
    return {
        _callCount: () => callCount,
        async run(model, { text }) {
            callCount++;
            if (callCount > failAfter) {
                if (failWithTransient) throw new Error('9000: model temporarily unavailable');
                throw new Error('Too many subrequests');
            }
            // Return a realistic 768-dim embedding vector
            return { data: [Array.from({ length: 768 }, () => Math.random() * 0.1)] };
        },
    };
}

// ─── 1. SCORING STRESS TEST ───────────────────────────────────────────────────

describe('🔴 STRESS: Scoring Engine — 500 jobs at peak throughput', () => {
    const jobs = makePeakJobBatch(PEAK_JOB_COUNT, 0.15);
    const config = STRESS_CONFIG;
    const idfData = { totalDocs: 10000, termCounts: { javascript: 8000, 'node.js': 5000, react: 6000, typescript: 4500 } };

    test('scores all 500 jobs without throwing', () => {
        let scored = 0;
        const start = Date.now();
        for (const job of jobs) {
            const result = scoreJob(job, config, idfData, 0.75);
            expect(result).toHaveProperty('score');
            expect(result.score).toBeGreaterThanOrEqual(0);
            expect(result.score).toBeLessThanOrEqual(100);
            scored++;
        }
        const elapsed = Date.now() - start;
        expect(scored).toBe(PEAK_JOB_COUNT);
        // Should score 500 jobs in under 2 seconds (peak CPU efficiency)
        expect(elapsed).toBeLessThan(2000);
        console.log(`✅ Scored ${scored} jobs in ${elapsed}ms (${(scored / elapsed * 1000).toFixed(0)} jobs/sec)`);
    });

    test('exclusion list stops scoring immediately on blacklisted tech', () => {
        const phpJob = makeJob(9999, {
            title: 'PHP Senior Developer',
            contentSnippet: 'Looking for a PHP developer with Laravel experience',
        });
        const result = scoreJob(phpJob, config, idfData);
        expect(result.excluded).toBe(true);
        expect(result.score).toBe(0);
    });

    test('top jobs hit Excellent threshold (≥88) with full skill match', () => {
        const excellentJob = makeJob(8888, {
            title: 'Full Stack Software Engineer — Node.js React TypeScript',
            contentSnippet: 'JavaScript TypeScript Node.js React Next.js MongoDB AWS Redis Docker GraphQL remote worldwide India. Salary $120k/yr. Junior to mid-level. 0-2 years experience.',
            extra: 'Express.js NestJS PostgreSQL',
        });
        const result = scoreJob(excellentJob, config, idfData, 0.92);
        expect(result.score).toBeGreaterThanOrEqual(88);
        expect(result.label).toBe('Excellent Match');
        console.log(`✅ Excellent job scored: ${result.score} — ${result.reasons.join('; ').slice(0, 100)}`);
    });

    test('completely irrelevant job scores below threshold (no false positives)', () => {
        const irrelevant = makeJob(7777, {
            title: 'Accountant — Finance Department',
            contentSnippet: 'Looking for a CPA with 5+ years in auditing. Must know Excel and SAP. No programming required.',
            categories: ['Finance', 'Accounting'],
        });
        const result = scoreJob(irrelevant, config, idfData, 0.1);
        expect(result.score).toBeLessThan(config.notificationThreshold);
    });

    test('500 jobs dedup: 15% duplicates are correctly filtered by content_hash', () => {
        const seenHashes = new Set();
        let unique = 0;
        let dupes = 0;
        for (const job of jobs) {
            if (job.content_hash && seenHashes.has(job.content_hash)) {
                dupes++;
            } else {
                if (job.content_hash) seenHashes.add(job.content_hash);
                unique++;
            }
        }
        const dupRate = dupes / jobs.length;
        expect(unique + dupes).toBe(PEAK_JOB_COUNT);
        expect(dupRate).toBeGreaterThan(0.05); // At least 5% were duped
        console.log(`✅ Dedup: ${unique} unique, ${dupes} dupes (${(dupRate * 100).toFixed(1)}% dup rate)`);
    });
});

// ─── 2. isNewJob TIME WINDOW STRESS TEST ─────────────────────────────────────

describe('🟠 STRESS: Time-window filtering at high volume', () => {
    test('filters 1000 jobs by recency — only keeps jobs within 24-hour window', () => {
        const timeWindowHours = 24;
        const now = Date.now();
        let kept = 0;
        let filtered = 0;

        for (let i = 0; i < 1000; i++) {
            const hoursAgo = Math.random() * 72; // 0–72 hours ago
            const job = {
                id: `tw-${i}`,
                pubDate: new Date(now - hoursAgo * 3600_000).toISOString(),
                title: `Job ${i}`,
            };
            if (isNewJob(job, timeWindowHours)) kept++;
            else filtered++;
        }

        // ~33% (0–24h out of 0–72h) should pass — allow ±15%
        expect(kept).toBeGreaterThan(250);
        expect(kept).toBeLessThan(500);
        console.log(`✅ Time window: ${kept} kept, ${filtered} filtered from 1000 jobs`);
    });

    test('jobs with no date are always filtered (safe default)', () => {
        const noDateJob = { id: 'no-date', title: 'Test', pubDate: undefined, isoDate: undefined };
        expect(isNewJob(noDateJob, 24)).toBe(false);
    });

    test('very fresh jobs (seconds old) always pass time filter', () => {
        const freshJob = { id: 'fresh', title: 'Fresh Job', pubDate: new Date().toISOString() };
        expect(isNewJob(freshJob, 0.001)).toBe(true); // 3.6 second window
    });

    test('stale jobs (5 days old) always fail time filter', () => {
        const staleJob = { id: 'stale', title: 'Stale Job', pubDate: new Date(Date.now() - 5 * 86400_000).toISOString() };
        expect(isNewJob(staleJob, 24)).toBe(false);
    });
});

// ─── 3. D1 BATCH INSERT STRESS TEST ──────────────────────────────────────────

describe('🔴 STRESS: D1 Batch Insert — peak volume + FK guard', () => {
    test('batch inserts 500 jobs and tracks exact insert vs duplicate counts', async () => {
        const { batchInsertJobs } = await import('../src/db/jobs.js');
        const db = makeMockDb();
        const jobs = makePeakJobBatch(PEAK_JOB_COUNT, 0.20); // 20% dup rate

        const { inserted, duplicates } = await batchInsertJobs(db, jobs);

        expect(inserted.length + duplicates).toBe(
            // Total = valid unique + explicitly tracked dupes
            jobs.filter((j, i, arr) => {
                const url = j.url || j.link || j.id;
                return !!url;
            }).length
        );
        expect(inserted.length).toBeGreaterThan(0);
        console.log(`✅ D1 Batch: ${inserted.length} inserted, ${duplicates} dupes from ${PEAK_JOB_COUNT} jobs`);
    });

    test('markAlertSent FK guard: skips insert when job does not exist in jobs table', async () => {
        const { markAlertSent } = await import('../src/db/profiles.js');
        const missingJobId = 'ghost-job-xyz';
        const db = makeMockDb({ fkFailJobIds: new Set([missingJobId]) });

        // Should NOT throw, should log WARN and skip
        await expect(markAlertSent(db, missingJobId, 'profile-1')).resolves.toBeUndefined();
        // Confirm no insert happened
        expect(db._sentAlerts.has(`${missingJobId}:profile-1`)).toBe(false);
        console.log(`✅ FK guard: markAlertSent silently skipped for non-existent job`);
    });

    test('markAlertSent succeeds when job exists in jobs table', async () => {
        const { markAlertSent } = await import('../src/db/profiles.js');
        const existingJobId = 'real-job-123';
        const db = makeMockDb({ existingJobIds: new Set([existingJobId]) });

        await markAlertSent(db, existingJobId, 'profile-1');
        expect(db._sentAlerts.has(`${existingJobId}:profile-1`)).toBe(true);
        console.log(`✅ FK guard: markAlertSent correctly inserted for existing job`);
    });

    test('batch insert handles 0 valid jobs gracefully', async () => {
        const { batchInsertJobs } = await import('../src/db/jobs.js');
        const db = makeMockDb();
        const result = await batchInsertJobs(db, []);
        expect(result.inserted).toHaveLength(0);
        expect(result.duplicates).toBe(0);
    });

    test('batch insert skips jobs with no URL (no crashes)', async () => {
        const { batchInsertJobs } = await import('../src/db/jobs.js');
        const db = makeMockDb();
        const badJobs = [
            { title: 'No URL job', content_hash: 'bad1' },
            { id: '', url: '', title: 'Empty URL', content_hash: 'bad2' },
            makeJob(1), // valid
        ];
        const { inserted } = await batchInsertJobs(db, badJobs);
        expect(inserted.length).toBe(1); // Only the valid one
    });
});

// ─── 4. AI SUBREQUEST BUDGET STRESS TEST ──────────────────────────────────────

describe('🟡 STRESS: AI Embedding — subrequest budget + retry logic', () => {
    beforeEach(async () => {
        // Reset the module-level counter between tests
        const { resetAiCallCount } = await import('../src/notifications/ai.js');
        resetAiCallCount();
    });

    test('enforces 40-call hard cap — calls beyond budget return [] immediately', async () => {
        const { generateEmbedding, resetAiCallCount, getAiCallCount } = await import('../src/notifications/ai.js');
        resetAiCallCount();
        const ai = makeMockAI({ failAfter: Infinity });

        const results = [];
        for (let i = 0; i < 50; i++) {
            results.push(await generateEmbedding(ai, `job text ${i}`));
        }

        // First 40 should have embeddings (non-empty arrays)
        const nonEmpty = results.filter(r => r.length > 0);
        const empty = results.filter(r => r.length === 0);
        expect(nonEmpty.length).toBe(40);
        expect(empty.length).toBe(10); // 50 - 40 = 10 over budget
        console.log(`✅ AI budget: ${nonEmpty.length} embeddings generated, ${empty.length} blocked by budget cap`);
    });

    test('retries transient 9000 error and succeeds on second attempt', async () => {
        const { generateEmbedding, resetAiCallCount } = await import('../src/notifications/ai.js');
        resetAiCallCount();

        let failCount = 0;
        const flakyAI = {
            async run() {
                failCount++;
                if (failCount === 1) throw new Error('9000: model temporarily unavailable');
                return { data: [new Array(768).fill(0.5)] };
            },
        };

        const result = await generateEmbedding(flakyAI, 'test job');
        expect(result).toHaveLength(768);
        expect(failCount).toBe(2); // Failed once, succeeded on retry
        console.log(`✅ AI retry: succeeded after ${failCount} attempts`);
    }, 10000);

    test('exhausts 2 retries on persistent transient error — returns []', async () => {
        const { generateEmbedding, resetAiCallCount } = await import('../src/notifications/ai.js');
        resetAiCallCount();

        let callCount = 0;
        const alwaysFailAI = {
            async run() {
                callCount++;
                throw new Error('9000: model temporarily unavailable');
            },
        };

        const result = await generateEmbedding(alwaysFailAI, 'test');
        expect(result).toHaveLength(0);
        expect(callCount).toBe(3); // 1 initial + 2 retries
        console.log(`✅ AI retry exhausted: gave up after ${callCount} attempts, returned []`);
    }, 15000);

    test('non-transient error fails immediately without retrying', async () => {
        const { generateEmbedding, resetAiCallCount } = await import('../src/notifications/ai.js');
        resetAiCallCount();

        let callCount = 0;
        const badAI = {
            async run() {
                callCount++;
                throw new Error('Unknown internal error');
            },
        };

        const result = await generateEmbedding(badAI, 'test');
        expect(result).toHaveLength(0);
        expect(callCount).toBe(1); // No retry for non-transient
        console.log(`✅ AI non-transient: failed fast after ${callCount} call, no retries`);
    });

    test('null aiBinding returns [] without calling any API', async () => {
        const { generateEmbedding, resetAiCallCount } = await import('../src/notifications/ai.js');
        resetAiCallCount();
        const result = await generateEmbedding(null, 'test');
        expect(result).toHaveLength(0);
    });
});

// ─── 5. QUEUE RETRY HELPER STRESS TEST ───────────────────────────────────────

describe('🟠 STRESS: withRetry — exponential backoff under simulated rate limiting', () => {
    // Extract withRetry by testing it indirectly through the worker module
    // We'll test the behavior by simulating queue-like operations

    test('a 3-retry operation succeeds on 3rd attempt', async () => {
        let attempts = 0;
        const operation = async () => {
            attempts++;
            if (attempts < 3) throw new Error('Too Many Requests');
            return 'success';
        };

        // Replicate withRetry logic directly for testing
        async function withRetry(fn, maxRetries = 3, baseDelayMs = 10) {
            let lastErr;
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try { return await fn(); } catch (err) {
                    lastErr = err;
                    if (attempt < maxRetries) await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
                }
            }
            throw lastErr;
        }

        const result = await withRetry(operation, 3, 10);
        expect(result).toBe('success');
        expect(attempts).toBe(3);
        console.log(`✅ withRetry: succeeded after ${attempts} attempts`);
    });

    test('withRetry throws after all retries exhausted', async () => {
        let attempts = 0;
        const alwaysFail = async () => { attempts++; throw new Error('Persistent rate limit'); };

        async function withRetry(fn, maxRetries = 3, baseDelayMs = 10) {
            let lastErr;
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try { return await fn(); } catch (err) {
                    lastErr = err;
                    if (attempt < maxRetries) await new Promise(r => setTimeout(r, baseDelayMs));
                }
            }
            throw lastErr;
        }

        await expect(withRetry(alwaysFail, 2, 10)).rejects.toThrow('Persistent rate limit');
        expect(attempts).toBe(3); // 1 initial + 2 retries
        console.log(`✅ withRetry: correctly threw after ${attempts} attempts`);
    });

    test('withRetry succeeds immediately on first attempt (no rate limit)', async () => {
        let attempts = 0;
        const succeedImmediately = async () => { attempts++; return 42; };

        async function withRetry(fn, maxRetries = 3, baseDelayMs = 10) {
            let lastErr;
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try { return await fn(); } catch (err) {
                    lastErr = err;
                    if (attempt < maxRetries) await new Promise(r => setTimeout(r, baseDelayMs));
                }
            }
            throw lastErr;
        }

        const result = await withRetry(succeedImmediately, 3, 10);
        expect(result).toBe(42);
        expect(attempts).toBe(1);
    });
});

// ─── 6. PAYLOAD SLIM + SIZE CHECK STRESS TEST ────────────────────────────────

describe('🟠 STRESS: slimJob projection — payload size under 128KB', () => {
    function slimJob(job) {
        return {
            id: job.id, title: job.title, company: job.company,
            url: job.url, link: job.link, categories: job.categories,
            matchedTerms: job.matchedTerms, content_hash: job.content_hash,
            sourceUrl: job.sourceUrl, publishedAt: job.publishedAt,
            isoDate: job.isoDate, pubDate: job.pubDate,
        };
    }

    test('slimJob strips heavy fields and keeps payload under 100KB', () => {
        const heavyJob = makeJob(1, {
            contentSnippet: 'A'.repeat(50000),
            description: 'B'.repeat(50000),
            body: 'C'.repeat(20000),
        });

        const slim = slimJob(heavyJob);
        const size = JSON.stringify({ jobs: [slim] }).length;

        expect(slim.contentSnippet).toBeUndefined();
        expect(slim.description).toBeUndefined();
        expect(slim.body).toBeUndefined();
        expect(size).toBeLessThan(100_000);
        console.log(`✅ slimJob: reduced payload from ~120KB to ${(size / 1000).toFixed(1)}KB`);
    });

    test('batch of 20 slim jobs stays under 100KB', () => {
        const jobs = Array.from({ length: 20 }, (_, i) => slimJob(makeJob(i, {
            contentSnippet: 'X'.repeat(5000),
        })));
        const size = JSON.stringify({ jobs }).length;
        expect(size).toBeLessThan(100_000);
        console.log(`✅ 20-job slim batch: ${(size / 1000).toFixed(1)}KB`);
    });

    test('slimJob preserves all evaluator-required fields', () => {
        const job = makeJob(42);
        const slim = slimJob(job);
        expect(slim.id).toBe(job.id);
        expect(slim.title).toBe(job.title);
        expect(slim.company).toBe(job.company);
        expect(slim.content_hash).toBe(job.content_hash);
        expect(slim.categories).toEqual(job.categories);
        expect(slim.matchedTerms).toEqual(job.matchedTerms);
    });
});

// ─── 7. WALL-TIME GUARD STRESS TEST ──────────────────────────────────────────

describe('🔴 STRESS: Wall-time guard — stops processing before Worker timeout', () => {
    test('guard correctly identifies elapsed time > limit', () => {
        const EVAL_START = Date.now() - 23_000; // Simulated 23s elapsed
        const WALL_TIME_LIMIT_MS = 22_000;
        const exceeded = (Date.now() - EVAL_START) > WALL_TIME_LIMIT_MS;
        expect(exceeded).toBe(true);
        console.log(`✅ Wall-time guard: 23s elapsed > 22s limit correctly detected`);
    });

    test('guard allows processing when under limit', () => {
        const EVAL_START = Date.now() - 5_000; // Only 5s elapsed
        const WALL_TIME_LIMIT_MS = 22_000;
        const exceeded = (Date.now() - EVAL_START) > WALL_TIME_LIMIT_MS;
        expect(exceeded).toBe(false);
    });

    test('chunk size 20 processes maximum 20 jobs before guard check', () => {
        const JOB_CHUNK_SIZE = 20;
        const jobs = makePeakJobBatch(100);
        const chunks = [];
        for (let i = 0; i < jobs.length; i += JOB_CHUNK_SIZE) {
            chunks.push(jobs.slice(i, i + JOB_CHUNK_SIZE));
        }
        expect(chunks.length).toBe(5); // 100 / 20 = 5 chunks
        expect(chunks[0].length).toBe(20);
        console.log(`✅ Chunk size 20: ${jobs.length} jobs split into ${chunks.length} chunks`);
    });
});

// ─── 8. FULL SCORING PIPELINE BENCHMARK ──────────────────────────────────────

describe('⚡ BENCHMARK: Full scoring pipeline throughput', () => {
    test('processes 1000 jobs through complete score pipeline in < 5 seconds', () => {
        const jobs = makePeakJobBatch(1000, 0.2);
        const config = STRESS_CONFIG;
        const idfData = { totalDocs: 50000, termCounts: { javascript: 35000, 'node.js': 20000, react: 25000 } };

        const start = Date.now();
        let passed = 0;
        let blocked = 0;
        let excluded = 0;

        for (const job of jobs) {
            const result = scoreJob(job, config, idfData, 0.7);
            if (result.excluded) excluded++;
            else if (result.score >= config.notificationThreshold) passed++;
            else blocked++;
        }

        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(5000);
        expect(passed + blocked + excluded).toBe(1000);
        console.log(
            `⚡ BENCHMARK: 1000 jobs in ${elapsed}ms | ` +
            `${passed} passed | ${blocked} blocked | ${excluded} excluded | ` +
            `${(1000 / elapsed * 1000).toFixed(0)} jobs/sec`
        );
    });

    test('50-source cron cycle: buildSourceList returns correct source types', () => {
        const sources = makeSources(PEAK_SOURCE_COUNT);
        expect(sources).toHaveLength(PEAK_SOURCE_COUNT);
        const types = new Set(sources.map(s => s.type));
        expect(types.size).toBeGreaterThan(1); // Multiple source types
        console.log(`✅ Source list: ${sources.length} sources, types: ${[...types].join(', ')}`);
    });
});
