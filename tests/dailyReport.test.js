/**
 * Tests for the Daily Intelligence Report module.
 * Covers: formatDailyReport, incrementDailyMetrics, getDailyReportData
 */

import { formatDailyReport } from '../src/intelligence/dailyReport.js';

// ── formatDailyReport ──────────────────────────────────────────────────────

describe('Daily Intelligence Report', () => {
    test('formatDailyReport produces a complete report with all sections', () => {
        const data = {
            date: '2026-03-01',
            today: {
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
                skill_counts: JSON.stringify({ 'react': 42, 'node.js': 38, 'next.js': 31, 'typescript': 28 }),
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
            prev: {
                new_sources_ats: 3,
                new_sources_career: 4,
                new_sources_search: 2,
                alerts_sent: 20,
                score_sum: 1400,
            },
            tiers: {
                high: { count: 34, avgScore: 82 },
                medium: { count: 58, avgScore: 55 },
                low: { count: 72, avgScore: 25 },
                dormant: { count: 22, avgScore: 5 },
            },
            sources: { total: 195, active: 186, disabled: 9 },
        };

        const report = formatDailyReport(data);

        // Check all major sections exist
        expect(report).toContain('JOB HUNTER BOT — DAILY INTELLIGENCE');
        expect(report).toContain('Mar 01, 2026');
        expect(report).toContain('GROWTH & EXPANSION');
        expect(report).toContain('CRAWL PERFORMANCE');
        expect(report).toContain('ALERT QUALITY');
        expect(report).toContain('SOURCE INTELLIGENCE');
        expect(report).toContain('MARKET SIGNALS');
        expect(report).toContain('RESOURCE SAFETY');

        // Growth
        expect(report).toContain('New Sources: +12');
        expect(report).toContain('ATS: +4');
        expect(report).toContain('Career: +5');
        expect(report).toContain('Search: +3');
        expect(report).toContain('Active Sources: 186');
        expect(report).toContain('Disabled: 9');

        // Crawl
        expect(report).toContain('Sources Scanned: 142');
        expect(report).toContain('Success Rate: 91%');
        expect(report).toContain('Raw Jobs: 684');
        expect(report).toContain('Unique Stored: 118');
        expect(report).toContain('Duplicates Filtered: 402');

        // Alerts
        expect(report).toContain('Alerts Sent: 27');
        expect(report).toContain('Delivery Failures: 0');
        expect(report).toContain('Highest Score: 92');

        // Intelligence tiers
        expect(report).toContain('High: 34');
        expect(report).toContain('Med: 58');
        expect(report).toContain('Low: 72');
        expect(report).toContain('Dormant: 22');

        // Market
        expect(report).toContain('Top Skill: react');
        expect(report).toContain('Remote Roles:');
        expect(report).toContain('Avg Salary:');

        // Resources
        expect(report).toContain('Worker Invocations: 8,420');
        expect(report).toContain('D1 Writes: 1,132');
        expect(report).toContain('AI Calls: 82');
        expect(report).toContain('Free Tier Usage:');
    });

    test('formatDailyReport handles empty/zero metrics gracefully', () => {
        const data = {
            date: '2026-03-01',
            today: {},
            prev: {},
            tiers: {},
            sources: { total: 0, active: 0, disabled: 0 },
        };

        const report = formatDailyReport(data);

        expect(report).toContain('JOB HUNTER BOT — DAILY INTELLIGENCE');
        expect(report).toContain('New Sources: +0');
        expect(report).toContain('Sources Scanned: 0');
        expect(report).toContain('Alerts Sent: 0');
        expect(report).toContain('No Data');
    });

    test('formatDailyReport shows quality index based on avg score', () => {
        // Excellent quality (avg 80)
        const dataExcellent = {
            date: '2026-03-01',
            today: { alerts_sent: 10, score_sum: 800, score_max: 95, unique_jobs_stored: 100 },
            prev: {}, tiers: {}, sources: { total: 10, active: 10, disabled: 0 },
        };
        expect(formatDailyReport(dataExcellent)).toContain('Excellent');

        // Moderate quality (avg 50)
        const dataModerate = {
            date: '2026-03-01',
            today: { alerts_sent: 10, score_sum: 500, score_max: 70 },
            prev: {}, tiers: {}, sources: { total: 10, active: 10, disabled: 0 },
        };
        expect(formatDailyReport(dataModerate)).toContain('Moderate');
    });

    test('formatDailyReport detects MERN stack from skill_counts', () => {
        const data = {
            date: '2026-03-01',
            today: {
                skill_counts: JSON.stringify({ 'mongodb': 5, 'express': 3, 'react': 8, 'node.js': 6 }),
                alerts_sent: 5, score_sum: 350, score_max: 85,
            },
            prev: {}, tiers: {}, sources: { total: 10, active: 10, disabled: 0 },
        };
        expect(formatDailyReport(data)).toContain('MERN');
    });

    test('formatDailyReport calculates resource safety levels', () => {
        // Safe (38%)
        const dataSafe = {
            date: '2026-03-01',
            today: { worker_invocations: 38000 },
            prev: {}, tiers: {}, sources: { total: 10, active: 10, disabled: 0 },
        };
        expect(formatDailyReport(dataSafe)).toContain('🟢');

        // High (85%)
        const dataHigh = {
            date: '2026-03-01',
            today: { worker_invocations: 85000 },
            prev: {}, tiers: {}, sources: { total: 10, active: 10, disabled: 0 },
        };
        expect(formatDailyReport(dataHigh)).toContain('🔴');
    });

    test('formatDailyReport does not crash when all metric fields are undefined', () => {
        // Simulates the exact false-zeros scenario: daily_metrics row has no data
        const data = {
            date: '2026-03-03',
            today: {
                // Only cycles_completed and worker_invocations set (as in the original issue)
                cycles_completed: 2,
                worker_invocations: 2,
            },
            prev: {},
            tiers: {},
            sources: { total: 45, active: 45, disabled: 0 },
        };

        // Should not throw — this was crashing when .toLocaleString() was called on undefined
        const report = formatDailyReport(data);

        expect(report).toContain('JOB HUNTER BOT — DAILY INTELLIGENCE');
        expect(report).toContain('Sources Scanned: 0');
        expect(report).toContain('Alerts Sent: 0');
        expect(report).toContain('Cycles Today: 2');
        expect(report).toContain('Worker Invocations: 2');
        // Ensure no 'undefined' or 'NaN' leaked into the report
        expect(report).not.toContain('undefined');
        expect(report).not.toContain('NaN');
    });

    test('formatDailyReport renders backfilled data correctly', () => {
        // Simulates ground-truth backfill: unique_jobs_stored and sources_scanned
        // filled from actual tables when daily_metrics showed zeros
        const data = {
            date: '2026-03-03',
            today: {
                worker_invocations: 2,
                cycles_completed: 2,
                unique_jobs_stored: 1889, // backfilled
                raw_jobs_found: 1889,     // backfilled
                sources_scanned: 45,      // backfilled
                crawl_successes: 45,      // backfilled
                _backfilled: true,
            },
            prev: { unique_jobs_stored: 1200 },
            tiers: {},
            sources: { total: 45, active: 45, disabled: 0 },
        };

        const report = formatDailyReport(data);

        expect(report).toContain('Unique Stored: 1,889');
        expect(report).toContain('Sources Scanned: 45');
        expect(report).toContain('Raw Jobs: 1,889');
        expect(report).toContain('Active');
        expect(report).not.toContain('undefined');
    });
});
