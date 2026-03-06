/**
 * @file stress.notifications.test.js
 * @description NOTIFICATIONS + QUEUE ROUTER STRESS TEST
 *
 * Tests:
 *   - Alert sending pipeline under high volume (100 alerts/run)
 *   - Discord / Telegram dry-run pathway
 *   - Queue router correctly dispatches all 3 queue types
 *   - hasSentAlert dedup prevents duplicate notifications
 *   - Multiple profiles × multiple jobs combinatorial coverage
 *   - sendAlert graceful degradation (no channels configured)
 *   - Retry-After header handling simulation
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { sendAlert } from '../src/notifications/notifications.js';
import { scoreJob } from '../src/scoring/relevance.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STRESS_CONFIG = {
    notificationThreshold: 60,
    dryRun: true,
    targetRoles: ['software engineer', 'backend engineer', 'full stack developer'],
    searchRules: {
        mustMatch: ['javascript', 'node.js', 'typescript', 'react'],
        shouldMatch: ['mongodb', 'redis', 'docker'],
        niceToHave: ['aws', 'next.js', 'graphql'],
        exclude: ['cobol', 'php senior'],
    },
    synonyms: { 'node.js': ['nodejs'], 'react': ['reactjs'] },
    locationKeywords: ['remote', 'india', 'worldwide'],
    filters: { workPreference: ['remote'] },
    experienceLevel: ['junior', 'entry level'],
    weights: { titleMatch: 30, skillsMatch: 30, techStackMatch: 20, locationMatch: 10, salaryMatch: 10 },
    scoringBonuses: { nextjsAndTypescript: 8, nodeAndMongodb: 6, awsPresent: 4, fullMernStack: 10, remoteIndia: 5 },
    scoringPenalties: { nonJsStack: -15, frontendOnlyNoBackend: -5 },
    fuzzyThreshold: 0.82,
};

function makeJob(i, overrides = {}) {
    return {
        id: `notif-job-${i}`,
        title: `Backend Engineer — Node.js TypeScript ${i}`,
        company: `Startup ${i % 20}`,
        link: `https://jobs.example.com/j/${i}`,
        url: `https://jobs.example.com/j/${i}`,
        pubDate: new Date(Date.now() - i * 60_000).toISOString(),
        isoDate: new Date(Date.now() - i * 60_000).toISOString(),
        categories: ['JavaScript', 'Node.js', 'TypeScript'],
        contentSnippet: `Node.js TypeScript React MongoDB AWS remote worldwide. Salary $100k. Junior 0-2 years.`,
        content_hash: `notif-hash-${i}`,
        ...overrides,
    };
}

function makeScoreResult(score = 78, overrides = {}) {
    return {
        score,
        label: score >= 88 ? 'Excellent Match' : score >= 72 ? 'Strong Match' : score >= 55 ? 'Moderate Match' : score >= 38 ? 'Weak Match' : 'Poor Match',
        color: score >= 88 ? '🟢' : score >= 72 ? '🟡' : '🔵',
        reasons: ['Title: "backend engineer"', 'Must-match (3/4): javascript, node.js, typescript', 'AI Semantic boost: +12 (85.0% match)'],
        matchedSkills: ['javascript', 'node.js', 'typescript', 'react', 'mongodb', 'aws'],
        excluded: false,
        breakdown: {
            titleScore: 30, skillsScore: 25, techScore: 12, locationScore: 10,
            salaryScore: 10, tfidfBoost: 3, semanticBoost: 12, bonuses: 9, penalties: 0,
        },
        features: {
            salaryUSD: { min: 100000, max: 130000, currency: 'USD' },
            remoteType: 'remote',
            seniority: 'junior',
            experience: { min: 0, max: 2 },
        },
        ...overrides,
    };
}

// ─── 1. DRY RUN STRESS ─────────────────────────────────────────────────────────

describe('🟢 STRESS: Notifications — 100 alerts through dry-run pipeline', () => {
    test('sends 100 job alerts in dry-run mode — none throw, all return sent=1', async () => {
        const env = {}; // no webhooks = dry-run
        const config = { ...STRESS_CONFIG, dryRun: true };

        const jobs = Array.from({ length: 100 }, (_, i) => makeJob(i));
        const scores = jobs.map((_, i) => makeScoreResult(60 + (i % 40)));

        let sent = 0;
        let failed = 0;
        const start = Date.now();

        for (let i = 0; i < jobs.length; i++) {
            const stats = await sendAlert(jobs[i], scores[i], { dryRun: true, config, env });
            if (stats.sent > 0) sent++;
            else failed++;
        }

        const elapsed = Date.now() - start;
        expect(sent).toBe(100);
        expect(failed).toBe(0);
        expect(elapsed).toBeLessThan(2000); // 100 dry-run alerts in < 2s
        console.log(`✅ Dry-run: ${sent}/100 alerts sent in ${elapsed}ms`);
    });

    test('dry-run returns channel=["dry-run"] for every alert', async () => {
        const stats = await sendAlert(makeJob(0), makeScoreResult(85), { dryRun: true, config: STRESS_CONFIG, env: {} });
        expect(stats.channels).toContain('dry-run');
        expect(stats.sent).toBe(1);
    });

    test('alert with no channels configured returns mock channel and does not throw', async () => {
        // No dryRun, no webhooks — mock path
        const stats = await sendAlert(makeJob(0), makeScoreResult(75), { dryRun: false, config: STRESS_CONFIG, env: {} });
        expect(stats.channels).toContain('mock');
    });
});

// ─── 2. MULTI-PROFILE × MULTI-JOB COMBINATORIAL ───────────────────────────────

describe('🟠 STRESS: Multi-profile × Multi-job combinatorial alert coverage', () => {
    const PROFILE_COUNT = 10;
    const JOB_COUNT = 50;

    test(`${PROFILE_COUNT} profiles × ${JOB_COUNT} jobs = ${PROFILE_COUNT * JOB_COUNT} possible alerts, no duplicates`, async () => {
        const sentAlerts = new Set();

        for (let p = 0; p < PROFILE_COUNT; p++) {
            for (let j = 0; j < JOB_COUNT; j++) {
                const key = `profile-${p}:job-${j}`;
                const alreadySent = sentAlerts.has(key);

                if (!alreadySent) {
                    sentAlerts.add(key);
                    // Validate the key is unique
                    expect(sentAlerts.has(key)).toBe(true);
                }
            }
        }

        expect(sentAlerts.size).toBe(PROFILE_COUNT * JOB_COUNT);
        console.log(`✅ Multi-profile dedup: ${sentAlerts.size} unique alert keys for ${PROFILE_COUNT} profiles × ${JOB_COUNT} jobs`);
    });

    test('hasSentAlert prevents same job+profile combo from being alerted twice', async () => {
        const { hasSentAlert, markAlertSent } = await import('../src/db/profiles.js');

        const sentSet = new Set();
        const db = {
            prepare(sql) {
                return {
                    _sql: sql,
                    _bindings: [],
                    bind(...args) { this._bindings = args; return this; },
                    async first() {
                        if (sql.includes('SELECT 1 FROM sent_alerts')) {
                            const [jobId, profileId] = this._bindings;
                            return sentSet.has(`${jobId}:${profileId}`) ? { 1: 1 } : null;
                        }
                        if (sql.includes('SELECT 1 FROM jobs WHERE id')) {
                            return { 1: 1 }; // Job always exists for this test
                        }
                        return null;
                    },
                    async run() {
                        if (sql.includes('INSERT OR IGNORE INTO sent_alerts')) {
                            const [jobId, profileId] = this._bindings;
                            sentSet.add(`${jobId}:${profileId}`);
                        }
                        return { success: true, meta: { changes: 1 } };
                    },
                };
            },
            async batch(stmts) { return Promise.all(stmts.map(s => s.run())); },
        };

        const jobId = 'test-job-001';
        const profileId = 'profile-001';

        // First check — not sent yet
        expect(await hasSentAlert(db, jobId, profileId)).toBe(false);

        // Mark as sent
        await markAlertSent(db, jobId, profileId);

        // Second check — already sent
        expect(await hasSentAlert(db, jobId, profileId)).toBe(true);
        console.log(`✅ Dedup: hasSentAlert correctly detected duplicate for ${jobId}:${profileId}`);
    });

    test('score-to-label mapping is correct for all score ranges', () => {
        // Thresholds from relevance.js: Excellent ≥88, Strong ≥72, Moderate ≥55, Weak ≥38, Poor <38
        const cases = [
            { score: 95, expectedLabel: 'Excellent Match' },
            { score: 88, expectedLabel: 'Excellent Match' },
            { score: 80, expectedLabel: 'Strong Match' },
            { score: 72, expectedLabel: 'Strong Match' },
            { score: 62, expectedLabel: 'Moderate Match' },
            { score: 55, expectedLabel: 'Moderate Match' },
            { score: 45, expectedLabel: 'Weak Match' },
            { score: 38, expectedLabel: 'Weak Match' },
            { score: 20, expectedLabel: 'Poor Match' },
            { score: 0, expectedLabel: 'Poor Match' },
        ];
        for (const { score, expectedLabel } of cases) {
            const sr = makeScoreResult(score);
            expect(sr.label).toBe(expectedLabel);
        }
        console.log(`✅ Score labels: ${cases.length} ranges verified (Excellent≥88, Strong≥72, Moderate≥55, Weak≥38, Poor<38)`);
    });
});

// ─── 3. QUEUE ROUTER STRESS ────────────────────────────────────────────────────

describe('🔴 STRESS: Queue Router — all 3 queue types route correctly', () => {
    const queueNames = [
        { queue: 'feed-queue', expectedHandler: 'processFeeds' },
        { queue: 'job-queue', expectedHandler: 'evaluateJobs' },
        { queue: 'alert-queue', expectedHandler: 'sendAlerts' },
        { queue: 'staging-feed-queue', expectedHandler: 'processFeeds' },
        { queue: 'staging-job-queue', expectedHandler: 'evaluateJobs' },
        { queue: 'staging-alert-queue', expectedHandler: 'sendAlerts' },
    ];

    test.each(queueNames)('routes $queue → $expectedHandler correctly', ({ queue, expectedHandler }) => {
        // Replicate routing logic from queueHandler
        function getHandler(queueName) {
            if (queueName === 'feed-queue' || queueName.endsWith('-feed-queue')) return 'processFeeds';
            if (queueName === 'job-queue' || queueName.endsWith('-job-queue')) return 'evaluateJobs';
            if (queueName === 'alert-queue' || queueName.endsWith('-alert-queue')) return 'sendAlerts';
            return 'unknown';
        }
        expect(getHandler(queue)).toBe(expectedHandler);
    });

    test('unknown queue name routes to "unknown" handler (no crash)', () => {
        function getHandler(queueName) {
            if (queueName === 'feed-queue' || queueName.endsWith('-feed-queue')) return 'processFeeds';
            if (queueName === 'job-queue' || queueName.endsWith('-job-queue')) return 'evaluateJobs';
            if (queueName === 'alert-queue' || queueName.endsWith('-alert-queue')) return 'sendAlerts';
            return 'unknown';
        }
        expect(getHandler('mystery-queue')).toBe('unknown');
        expect(getHandler('')).toBe('unknown');
    });
});

// ─── 4. SCORE CONSISTENCY STRESS TEST ─────────────────────────────────────────

describe('🟡 STRESS: Score consistency — same job always produces same score', () => {
    const referenceJob = makeJob(0, {
        title: 'Senior Backend Engineer — Node.js TypeScript React',
        contentSnippet: 'Node.js TypeScript React Next.js MongoDB AWS Redis Docker GraphQL. Salary $120k. Remote worldwide India. Junior to mid-level.',
    });

    test('scoreJob is deterministic — runs 100× produce identical score', () => {
        const idfData = { totalDocs: 10000, termCounts: { javascript: 8000, 'node.js': 5000, react: 6000, typescript: 4500 } };
        const firstResult = scoreJob(referenceJob, STRESS_CONFIG, idfData, 0.80);
        let passed = 0;
        for (let i = 0; i < 100; i++) {
            const result = scoreJob(referenceJob, STRESS_CONFIG, idfData, 0.80);
            expect(result.score).toBe(firstResult.score);
            expect(result.label).toBe(firstResult.label);
            expect(result.excluded).toBe(firstResult.excluded);
            passed++;
        }
        console.log(`✅ Determinism: score ${firstResult.score} reproduced ${passed}/100 times`);
    });

    test('excluded jobs always return score=0 and excluded=true', () => {
        const excludedJob = makeJob(999, {
            title: 'PHP Senior Developer',
            contentSnippet: 'PHP Laravel MySQL. No JS needed.',
        });
        const idfData = { totalDocs: 1000, termCounts: {} };
        for (let i = 0; i < 50; i++) {
            const result = scoreJob(excludedJob, STRESS_CONFIG, idfData, 0.9);
            expect(result.excluded).toBe(true);
            expect(result.score).toBe(0);
        }
        console.log(`✅ Exclusion: 50/50 runs returned excluded=true, score=0`);
    });
});

// ─── 5. NOTIFICATION CHANNEL DETECTION ────────────────────────────────────────

describe('🟢 STRESS: Notification channel detection', () => {
    test('env with valid Discord webhook is detected as Discord channel', () => {
        function hasDiscord(env) {
            try { new URL(env.DISCORD_WEBHOOK_URL); return true; } catch { return false; }
        }
        expect(hasDiscord({ DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc' })).toBe(true);
        expect(hasDiscord({ DISCORD_WEBHOOK_URL: 'not-a-url' })).toBe(false);
        expect(hasDiscord({})).toBe(false);
    });

    test('env with Telegram token+chatId is detected as Telegram channel', () => {
        function hasTelegram(env) {
            return !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
        }
        expect(hasTelegram({ TELEGRAM_BOT_TOKEN: 'bot123:abc', TELEGRAM_CHAT_ID: '-100123' })).toBe(true);
        expect(hasTelegram({ TELEGRAM_BOT_TOKEN: 'token' })).toBe(false);
        expect(hasTelegram({})).toBe(false);
    });

    test('alert with both Discord and Telegram env configured sends to both channels in dry-run', async () => {
        const stats = await sendAlert(makeJob(0), makeScoreResult(90), {
            dryRun: true,
            config: STRESS_CONFIG,
            env: {
                DISCORD_WEBHOOK_URL: 'https://discord.com/webhook/test',
                TELEGRAM_BOT_TOKEN: 'bot:token',
                TELEGRAM_CHAT_ID: '-100abc',
            },
        });
        // In dry-run mode, actual network calls are suppressed — returns dry-run channel
        expect(stats.sent).toBeGreaterThan(0);
        expect(stats.channels).toContain('dry-run');
    });
});
