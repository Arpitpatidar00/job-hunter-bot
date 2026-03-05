/**
 * Correctness Tests for the Daily Intelligence Report.
 *
 * Validates that the report NEVER shows false zeros when real data exists.
 * Covers: getDailyReportData (with mock D1), formatDailyReport edge cases,
 * incrementDailyMetrics accumulation, and end-to-end data → format flow.
 */

import {
    formatDailyReport,
    getDailyReportData,
    incrementDailyMetrics,
} from '../src/intelligence/dailyReport.js';

// ── Mock D1 Database ───────────────────────────────────────────────────────

/**
 * Build a mock D1 database that simulates real D1 behavior:
 *  - Stores daily_metrics rows keyed by date
 *  - Supports INSERT OR IGNORE, UPDATE with SET x = x + ?, SELECT
 *  - Optionally supports source_registry and sent_alerts tables
 */
function createMockDB(options = {}) {
    const {
        dailyMetrics = {},       // { '2026-03-03': { sources_scanned: 10, ... } }
        jobs = [],               // [{ fetched_at, company, ... }]
        sourceRegistry = null,   // null = table doesn't exist; [] = empty; [{...}]
        sentAlerts = null,       // null = table doesn't exist; [] = empty; [{...}]
    } = options;

    // Deep clone to avoid mutation issues
    const metricsStore = JSON.parse(JSON.stringify(dailyMetrics));

    function createStatement(sql) {
        let boundValues = [];

        const stmt = {
            bind(...args) {
                boundValues = args;
                return stmt;
            },
            async run() {
                // INSERT OR IGNORE INTO daily_metrics
                if (sql.includes('INSERT OR IGNORE INTO daily_metrics')) {
                    const date = boundValues[0];
                    if (!metricsStore[date]) {
                        metricsStore[date] = {
                            sources_scanned: 0, crawl_successes: 0, crawl_failures: 0,
                            raw_jobs_found: 0, unique_jobs_stored: 0, duplicates_filtered: 0,
                            alerts_sent: 0, alert_failures: 0, score_sum: 0, score_max: 0,
                            new_sources_ats: 0, new_sources_career: 0, new_sources_search: 0,
                            new_domains_queued: 0, skill_counts: '{}',
                            remote_jobs: 0, hybrid_jobs: 0, onsite_jobs: 0,
                            salary_sum: 0, salary_count: 0,
                            worker_invocations: 0, d1_writes: 0, queue_messages: 0,
                            ai_calls: 0, cycles_completed: 0,
                        };
                    }
                    return { success: true };
                }
                // UPDATE daily_metrics SET skill_counts (handle BEFORE generic UPDATE)
                if (sql.includes('UPDATE daily_metrics SET skill_counts')) {
                    const date = boundValues[1];
                    const row = metricsStore[date];
                    if (row) row.skill_counts = boundValues[0];
                    return { success: true };
                }
                // UPDATE daily_metrics SET ...
                if (sql.includes('UPDATE daily_metrics SET')) {
                    const date = boundValues[boundValues.length - 1];
                    const row = metricsStore[date];
                    if (!row) return { success: true };

                    // Parse SET clauses from SQL — split on commas NOT inside parentheses
                    const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/s);
                    if (setMatch) {
                        const clauses = [];
                        let depth = 0, current = '';
                        for (const ch of setMatch[1]) {
                            if (ch === '(') depth++;
                            else if (ch === ')') depth--;
                            else if (ch === ',' && depth === 0) {
                                clauses.push(current.trim());
                                current = '';
                                continue;
                            }
                            current += ch;
                        }
                        if (current.trim()) clauses.push(current.trim());

                        let valIdx = 0;
                        for (const clause of clauses) {
                            const maxMatch = clause.match(/^(\w+)\s*=\s*MAX\(\1,\s*\?\)/);
                            const addMatch = clause.match(/^(\w+)\s*=\s*\1\s*\+\s*\?/);
                            if (maxMatch) {
                                const col = maxMatch[1];
                                row[col] = Math.max(row[col] || 0, boundValues[valIdx]);
                            } else if (addMatch) {
                                const col = addMatch[1];
                                row[col] = (row[col] || 0) + boundValues[valIdx];
                            }
                            valIdx++;
                        }
                    }
                    return { success: true };
                }
                return { success: true };
            },
            async first() {
                // SELECT skill_counts FROM daily_metrics
                if (sql.includes('SELECT skill_counts FROM daily_metrics')) {
                    const date = boundValues[0];
                    const row = metricsStore[date];
                    return row ? { skill_counts: row.skill_counts || '{}' } : null;
                }
                // SELECT * FROM daily_metrics
                if (sql.includes('SELECT * FROM daily_metrics')) {
                    const date = boundValues[0];
                    return metricsStore[date] || null;
                }
                return null;
            },
        };

        // For batch() — return results in the shape D1 expects
        stmt._execute = async () => {
            // Write operations: delegate to run() so the in-memory store is updated
            if (sql.includes('INSERT') || sql.includes('UPDATE')) {
                await stmt.run();
                return { results: [], success: true };
            }

            // SELECT * FROM daily_metrics WHERE date = ?
            if (sql.includes('SELECT * FROM daily_metrics')) {
                const date = boundValues[0];
                const row = metricsStore[date] || null;
                return { results: row ? [row] : [] };
            }

            // COUNT(*) FROM jobs WHERE date(fetched_at) = ?
            if (sql.includes('COUNT(*) as count FROM jobs WHERE date(fetched_at)')) {
                const date = boundValues[0];
                const count = jobs.filter(j => j.fetched_at?.startsWith(date)).length;
                return { results: [{ count }] };
            }

            // COUNT(DISTINCT company)
            if (sql.includes('COUNT(DISTINCT company)')) {
                const date = boundValues[0];
                const companies = new Set(
                    jobs.filter(j => j.fetched_at?.startsWith(date) && j.company)
                        .map(j => j.company)
                );
                return { results: [{ count: companies.size }] };
            }

            // source_registry queries
            if (sql.includes('source_registry')) {
                if (sourceRegistry === null) throw new Error('no such table: source_registry');
                if (sql.includes('crawl_tier')) {
                    const tierMap = {};
                    for (const s of sourceRegistry.filter(s => s.enabled)) {
                        const tier = s.crawl_tier || 'unknown';
                        if (!tierMap[tier]) tierMap[tier] = { scores: [], count: 0 };
                        tierMap[tier].count++;
                        tierMap[tier].scores.push(s.priority_score || 0);
                    }
                    const results = Object.entries(tierMap).map(([t, d]) => ({
                        crawl_tier: t,
                        count: d.count,
                        avg_score: d.scores.reduce((a, b) => a + b, 0) / d.scores.length,
                    }));
                    return { results };
                }
                if (sql.includes('COUNT(*)') && sql.includes('total')) {
                    const total = sourceRegistry.length;
                    const active = sourceRegistry.filter(s => s.enabled).length;
                    return { results: [{ total, active, disabled: total - active }] };
                }
                if (sql.includes('last_fetched_at')) {
                    const date = boundValues[0];
                    const count = sourceRegistry.filter(s => s.last_fetched_at?.startsWith(date)).length;
                    return { results: [{ count }] };
                }
            }

            // sent_alerts queries
            if (sql.includes('sent_alerts')) {
                if (sentAlerts === null) throw new Error('no such table: sent_alerts');
                const date = boundValues[0];
                const count = sentAlerts.filter(a => a.sent_at?.startsWith(date)).length;
                return { results: [{ count }] };
            }

            return { results: [] };
        };

        return stmt;
    }

    return {
        prepare(sql) {
            return createStatement(sql);
        },
        async batch(statements) {
            const results = [];
            for (const stmt of statements) {
                results.push(await stmt._execute());
            }
            return results;
        },
        _metricsStore: metricsStore,
    };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Daily Report Correctness', () => {

    // ── incrementDailyMetrics ──────────────────────────────────────────────

    describe('incrementDailyMetrics', () => {
        test('creates today\'s row and increments counters correctly', async () => {
            const db = createMockDB();
            await incrementDailyMetrics(db, {
                sources_scanned: 5,
                raw_jobs_found: 42,
                unique_jobs_stored: 30,
                duplicates_filtered: 12,
            });

            const todayKey = new Date().toISOString().split('T')[0];
            const row = db._metricsStore[todayKey];
            expect(row).toBeDefined();
            expect(row.sources_scanned).toBe(5);
            expect(row.raw_jobs_found).toBe(42);
            expect(row.unique_jobs_stored).toBe(30);
            expect(row.duplicates_filtered).toBe(12);
        });

        test('accumulates multiple increments correctly', async () => {
            const db = createMockDB();

            // First increment
            await incrementDailyMetrics(db, {
                sources_scanned: 10,
                raw_jobs_found: 50,
                crawl_successes: 8,
            });
            // Second increment
            await incrementDailyMetrics(db, {
                sources_scanned: 5,
                raw_jobs_found: 25,
                crawl_successes: 5,
            });

            const todayKey = new Date().toISOString().split('T')[0];
            const row = db._metricsStore[todayKey];
            expect(row.sources_scanned).toBe(15);
            expect(row.raw_jobs_found).toBe(75);
            expect(row.crawl_successes).toBe(13);
        });

        test('score_max uses MAX not addition', async () => {
            const db = createMockDB();

            await incrementDailyMetrics(db, { score_max: 85 });
            await incrementDailyMetrics(db, { score_max: 72 });
            await incrementDailyMetrics(db, { score_max: 95 });

            const todayKey = new Date().toISOString().split('T')[0];
            const row = db._metricsStore[todayKey];
            expect(row.score_max).toBe(95); // MAX, not 85+72+95
        });

        test('skips unknown columns without crashing', async () => {
            const db = createMockDB();
            // Should not throw
            await incrementDailyMetrics(db, {
                sources_scanned: 5,
                unknown_column: 999,
                another_bad_key: 42,
            });

            const todayKey = new Date().toISOString().split('T')[0];
            expect(db._metricsStore[todayKey].sources_scanned).toBe(5);
        });

        test('merges skill_counts JSON correctly', async () => {
            const db = createMockDB();

            await incrementDailyMetrics(db, {
                skill_counts: { react: 5, node: 3 },
            });
            await incrementDailyMetrics(db, {
                skill_counts: { react: 2, typescript: 4 },
            });

            const todayKey = new Date().toISOString().split('T')[0];
            const skills = JSON.parse(db._metricsStore[todayKey].skill_counts);
            expect(skills.react).toBe(7);
            expect(skills.node).toBe(3);
            expect(skills.typescript).toBe(4);
        });
    });

    // ── getDailyReportData ────────────────────────────────────────────────

    describe('getDailyReportData', () => {
        test('returns non-zero data when jobs exist in the jobs table', async () => {
            const today = new Date().toISOString().split('T')[0];
            const db = createMockDB({
                jobs: [
                    { fetched_at: `${today}T10:00:00Z`, company: 'Acme Corp' },
                    { fetched_at: `${today}T11:00:00Z`, company: 'Beta Inc' },
                    { fetched_at: `${today}T12:00:00Z`, company: 'Acme Corp' },
                ],
            });

            const data = await getDailyReportData(db, { reportDate: today });

            // Ground-truth backfill should kick in
            expect(data.today.unique_jobs_stored).toBe(3);
            expect(data.today.raw_jobs_found).toBeGreaterThan(0);
            expect(data.today.sources_scanned).toBe(2); // 2 distinct companies
            expect(data.today._backfilled).toBe(true);
        });

        test('survives when source_registry table does not exist', async () => {
            const today = new Date().toISOString().split('T')[0];
            const db = createMockDB({
                sourceRegistry: null, // table doesn't exist
                jobs: [
                    { fetched_at: `${today}T10:00:00Z`, company: 'TestCo' },
                ],
            });

            // Should NOT throw
            const data = await getDailyReportData(db, { reportDate: today });

            expect(data.today.unique_jobs_stored).toBe(1);
            expect(data.tiers).toEqual({});
            expect(data.sources.total).toBe(1); // backfilled from companies
        });

        test('survives when sent_alerts table does not exist', async () => {
            const today = new Date().toISOString().split('T')[0];
            const db = createMockDB({
                sentAlerts: null, // table doesn't exist
                jobs: [
                    { fetched_at: `${today}T10:00:00Z`, company: 'TestCo' },
                ],
            });

            // Should NOT throw
            const data = await getDailyReportData(db, { reportDate: today });
            expect(data.today.unique_jobs_stored).toBe(1);
        });

        test('uses daily_metrics data when it exists (no backfill needed)', async () => {
            const today = new Date().toISOString().split('T')[0];
            const db = createMockDB({
                dailyMetrics: {
                    [today]: {
                        sources_scanned: 50,
                        crawl_successes: 45,
                        crawl_failures: 5,
                        raw_jobs_found: 200,
                        unique_jobs_stored: 150,
                        duplicates_filtered: 50,
                        alerts_sent: 10,
                        score_sum: 750,
                        score_max: 92,
                    },
                },
                jobs: [
                    { fetched_at: `${today}T10:00:00Z`, company: 'TestCo' },
                ],
            });

            const data = await getDailyReportData(db, { reportDate: today });

            // Should use daily_metrics values, not backfill
            expect(data.today.sources_scanned).toBe(50);
            expect(data.today.unique_jobs_stored).toBe(150);
            expect(data.today.alerts_sent).toBe(10);
            expect(data.today._backfilled).toBeUndefined();
        });

        test('backfills previous day data from jobs table', async () => {
            const today = new Date().toISOString().split('T')[0];
            const prevDate = new Date(new Date(today + 'T00:00:00Z').getTime() - 86400_000)
                .toISOString().split('T')[0];

            const db = createMockDB({
                jobs: [
                    { fetched_at: `${today}T10:00:00Z`, company: 'Today Co' },
                    { fetched_at: `${prevDate}T10:00:00Z`, company: 'Yesterday Co' },
                    { fetched_at: `${prevDate}T11:00:00Z`, company: 'Yesterday Two' },
                ],
            });

            const data = await getDailyReportData(db, { reportDate: today });

            expect(data.prev.unique_jobs_stored).toBe(2); // 2 jobs from yesterday
        });

        test('includes source_registry tiers when table exists', async () => {
            const today = new Date().toISOString().split('T')[0];
            const db = createMockDB({
                sourceRegistry: [
                    { crawl_tier: 'high', enabled: true, priority_score: 85 },
                    { crawl_tier: 'high', enabled: true, priority_score: 90 },
                    { crawl_tier: 'medium', enabled: true, priority_score: 55 },
                    { crawl_tier: 'low', enabled: true, priority_score: 20 },
                    { crawl_tier: 'low', enabled: false, priority_score: 5 },
                ],
                jobs: [{ fetched_at: `${today}T10:00:00Z`, company: 'X' }],
            });

            const data = await getDailyReportData(db, { reportDate: today });

            expect(data.tiers.high).toBeDefined();
            expect(data.tiers.high.count).toBe(2);
            expect(data.tiers.medium.count).toBe(1);
            expect(data.sources.total).toBe(5);
            expect(data.sources.active).toBe(4);
            expect(data.sources.disabled).toBe(1);
        });
    });

    // ── formatDailyReport correctness ─────────────────────────────────────

    describe('formatDailyReport — correctness checks', () => {
        test('report with real data contains NO false zeros', () => {
            const data = {
                date: '2026-03-03',
                today: {
                    sources_scanned: 45,
                    crawl_successes: 42,
                    crawl_failures: 3,
                    raw_jobs_found: 200,
                    unique_jobs_stored: 150,
                    duplicates_filtered: 50,
                    alerts_sent: 8,
                    alert_failures: 1,
                    score_sum: 560,
                    score_max: 88,
                    new_sources_ats: 2,
                    new_sources_career: 1,
                    new_sources_search: 0,
                    remote_jobs: 80,
                    hybrid_jobs: 20,
                    onsite_jobs: 50,
                    salary_sum: 500000,
                    salary_count: 5,
                    worker_invocations: 500,
                    d1_writes: 200,
                    queue_messages: 50,
                    ai_calls: 20,
                    cycles_completed: 10,
                    skill_counts: JSON.stringify({ react: 30, node: 25, typescript: 20 }),
                },
                prev: {},
                tiers: { high: { count: 10, avgScore: 80 }, medium: { count: 20, avgScore: 50 } },
                sources: { total: 45, active: 42, disabled: 3 },
            };

            const report = formatDailyReport(data);

            // Core values must appear and be non-zero
            expect(report).toContain('Sources Scanned: 45');
            expect(report).toContain('Raw Jobs: 200');
            expect(report).toContain('Unique Stored: 150');
            expect(report).toContain('Duplicates Filtered: 50');
            expect(report).toContain('Alerts Sent: 8');
            expect(report).toContain('Active Sources: 42');
            expect(report).toContain('Disabled: 3');
            expect(report).toContain('Cycles Today: 10');

            // Must NOT contain any false zero indicators
            expect(report).not.toContain('Avg Score: 0');
            expect(report).not.toContain('Sources Scanned: 0');
            expect(report).not.toContain('undefined');
            expect(report).not.toContain('NaN');
        });

        test('avgScore shows score_max when alerts_sent is 0 but scoring happened', () => {
            const data = {
                date: '2026-03-03',
                today: {
                    alerts_sent: 0,
                    score_sum: 0,
                    score_max: 72,
                    unique_jobs_stored: 100,
                },
                prev: {},
                tiers: {},
                sources: { total: 10, active: 10, disabled: 0 },
            };

            const report = formatDailyReport(data);
            // Should show score_max as indicator instead of '0'
            expect(report).toContain('Avg Score: 72');
        });

        test('avgScore shows dash when jobs exist but no scoring data', () => {
            const data = {
                date: '2026-03-03',
                today: {
                    alerts_sent: 0,
                    score_sum: 0,
                    score_max: 0,
                    unique_jobs_stored: 500,
                },
                prev: {},
                tiers: {},
                sources: { total: 10, active: 10, disabled: 0 },
            };

            const report = formatDailyReport(data);
            expect(report).toContain('Avg Score: —');
        });

        test('report contains no undefined or NaN with minimal data', () => {
            const data = {
                date: '2026-03-03',
                today: { cycles_completed: 1 },
                prev: {},
                tiers: {},
                sources: { total: 0, active: 0, disabled: 0 },
            };

            const report = formatDailyReport(data);

            expect(report).not.toContain('undefined');
            expect(report).not.toContain('NaN');
            // All sections should still render
            expect(report).toContain('GROWTH & EXPANSION');
            expect(report).toContain('CRAWL PERFORMANCE');
            expect(report).toContain('ALERT QUALITY');
            expect(report).toContain('SOURCE INTELLIGENCE');
            expect(report).toContain('MARKET SIGNALS');
            expect(report).toContain('RESOURCE SAFETY');
        });

        test('percentage calculations stay within 0-100 bounds', () => {
            const data = {
                date: '2026-03-03',
                today: {
                    sources_scanned: 10,
                    crawl_successes: 10,  // 100%
                    raw_jobs_found: 1,
                    unique_jobs_stored: 1,
                    alerts_sent: 1,
                    score_sum: 90,
                    score_max: 90,
                },
                prev: {},
                tiers: {},
                sources: { total: 10, active: 10, disabled: 0 },
            };

            const report = formatDailyReport(data);

            expect(report).toContain('Success Rate: 100%');
            // Extract High-Value Yield percentage
            const yieldMatch = report.match(/High-Value Yield: ([\d.]+)%/);
            expect(yieldMatch).toBeTruthy();
            const yieldPct = parseFloat(yieldMatch[1]);
            expect(yieldPct).toBeGreaterThanOrEqual(0);
            expect(yieldPct).toBeLessThanOrEqual(100);
        });

        test('backfilled data produces a correct non-zero report', () => {
            const data = {
                date: '2026-03-03',
                today: {
                    unique_jobs_stored: 1889,
                    raw_jobs_found: 2457,
                    duplicates_filtered: 568,
                    sources_scanned: 45,
                    crawl_successes: 45,
                    worker_invocations: 50,
                    cycles_completed: 10,
                    _backfilled: true,
                },
                prev: { unique_jobs_stored: 1500 },
                tiers: {},
                sources: { total: 45, active: 45, disabled: 0 },
            };

            const report = formatDailyReport(data);

            expect(report).toContain('Unique Stored: 1,889');
            expect(report).toContain('Raw Jobs: 2,457');
            expect(report).toContain('Sources Scanned: 45');
            expect(report).toContain('Success Rate: 100%');
            // Quality should reflect volume (1889 >= 1000 → "High Volume — Active")
            expect(report).toContain('High Volume');
            expect(report).not.toContain('No Data');
            expect(report).not.toContain('undefined');
        });
    });

    // ── End-to-End: increment → fetch → format ────────────────────────────

    describe('End-to-End: increment → getDailyReportData → formatDailyReport', () => {
        test('full pipeline produces meaningful report from incremented metrics', async () => {
            const today = new Date().toISOString().split('T')[0];
            const db = createMockDB({
                jobs: [
                    { fetched_at: `${today}T10:00:00Z`, company: 'Acme' },
                    { fetched_at: `${today}T11:00:00Z`, company: 'Beta' },
                    { fetched_at: `${today}T12:00:00Z`, company: 'Gamma' },
                ],
            });

            // Simulate the worker pipeline
            await incrementDailyMetrics(db, {
                sources_scanned: 10,
                crawl_successes: 9,
                crawl_failures: 1,
                raw_jobs_found: 20,
                unique_jobs_stored: 3,
                duplicates_filtered: 17,
                remote_jobs: 2,
                onsite_jobs: 1,
                worker_invocations: 1,
                cycles_completed: 1,
            });

            await incrementDailyMetrics(db, {
                alerts_sent: 1,
                score_sum: 78,
                score_max: 78,
                ai_calls: 5,
            });

            const data = await getDailyReportData(db, { reportDate: today });
            const report = formatDailyReport(data);

            // Verify pipeline integrity
            expect(report).toContain('Sources Scanned: 10');
            expect(report).toContain('Raw Jobs: 20');
            expect(report).toContain('Unique Stored: 3');
            expect(report).toContain('Alerts Sent: 1');
            expect(report).toContain('Cycles Today: 1');
            expect(report).not.toContain('Sources Scanned: 0');
            expect(report).not.toContain('undefined');
            expect(report).not.toContain('NaN');
        });

        test('📊 PRINT FULL REPORT — visual verification', async () => {
            const today = new Date().toISOString().split('T')[0];
            const prevDate = new Date(new Date(today + 'T00:00:00Z').getTime() - 86400_000)
                .toISOString().split('T')[0];

            const db = createMockDB({
                dailyMetrics: {
                    [today]: {
                        sources_scanned: 142,
                        crawl_successes: 129,
                        crawl_failures: 13,
                        raw_jobs_found: 684,
                        unique_jobs_stored: 118,
                        duplicates_filtered: 402,
                        alerts_sent: 27,
                        alert_failures: 0,
                        score_sum: 2006.1,
                        score_max: 92,
                        new_sources_ats: 4,
                        new_sources_career: 5,
                        new_sources_search: 3,
                        new_domains_queued: 8,
                        skill_counts: JSON.stringify({
                            'react': 42, 'node.js': 38, 'next.js': 31, 'typescript': 28,
                            'mongodb': 18, 'express': 15, 'aws': 12
                        }),
                        remote_jobs: 84,
                        hybrid_jobs: 12,
                        onsite_jobs: 22,
                        salary_sum: 842000,
                        salary_count: 10,
                        worker_invocations: 8420,
                        d1_writes: 1132,
                        queue_messages: 3980,
                        ai_calls: 82,
                        cycles_completed: 96,
                    },
                    [prevDate]: {
                        new_sources_ats: 3,
                        new_sources_career: 4,
                        new_sources_search: 2,
                        alerts_sent: 20,
                        score_sum: 1400,
                        unique_jobs_stored: 95,
                    },
                },
                sourceRegistry: [
                    ...Array(34).fill(null).map(() => ({ crawl_tier: 'high', enabled: true, priority_score: 82 })),
                    ...Array(58).fill(null).map(() => ({ crawl_tier: 'medium', enabled: true, priority_score: 55 })),
                    ...Array(72).fill(null).map(() => ({ crawl_tier: 'low', enabled: true, priority_score: 25 })),
                    ...Array(22).fill(null).map(() => ({ crawl_tier: 'dormant', enabled: true, priority_score: 5 })),
                    ...Array(9).fill(null).map(() => ({ crawl_tier: 'dormant', enabled: false, priority_score: 0 })),
                ],
                sentAlerts: Array(27).fill(null).map(() => ({ sent_at: `${today}T15:00:00Z` })),
                jobs: Array(118).fill(null).map((_, i) => ({
                    fetched_at: `${today}T${String(10 + (i % 12)).padStart(2, '0')}:00:00Z`,
                    company: `Company${i % 30}`,
                })),
            });

            const data = await getDailyReportData(db, { reportDate: today });
            const report = formatDailyReport(data);

            // ╔═══════════════════════════════════════════════════════════════╗
            // ║  PRINT THE FULL REPORT TO TERMINAL FOR VISUAL VERIFICATION  ║
            // ╚═══════════════════════════════════════════════════════════════╝
            console.log('\n' + '═'.repeat(60));
            console.log('  📊 GENERATED DAILY REPORT (Test Output)');
            console.log('═'.repeat(60));
            console.log(report);
            console.log('═'.repeat(60) + '\n');

            // Basic sanity — the report was generated and is non-empty
            expect(report.length).toBeGreaterThan(500);
            expect(report).toContain('JOB HUNTER BOT — DAILY INTELLIGENCE');
            expect(report).not.toContain('undefined');
            expect(report).not.toContain('NaN');
        });
    });
});
