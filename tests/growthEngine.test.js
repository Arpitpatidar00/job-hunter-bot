/**
 * @file growthEngine.test.js
 * @description Unit tests for src/intelligence/growthEngine.js
 */

import {
    detectSkillSpikes,
    detectHiringSurge,
    scoreCompanyMomentum,
    persistGrowthSignals,
    runGrowthEngineCycle,
} from '../src/intelligence/growthEngine.js';

// ── Mock D1 Database ──────────────────────────────────────────────────────────

function makeDb(rows = []) {
    return {
        prepare: () => ({
            all: async () => ({ success: true, results: rows }),
            run: async () => ({ success: true }),
            bind: function(..._) { return this; },
        }),
        batch: async () => {},
    };
}

// ── detectSkillSpikes ─────────────────────────────────────────────────────────

describe('detectSkillSpikes', () => {
    test('returns empty array when no daily_metrics rows', async () => {
        const db = makeDb([]);
        const spikes = await detectSkillSpikes(db);
        expect(spikes).toEqual([]);
    });

    test('detects a skill with >20% week-over-week growth', async () => {
        const today = new Date().toISOString().slice(0, 10);

        // Build 2 weeks of data: last week skill has 10, this week has 15 (+50%)
        const rows = [];
        for (let d = 0; d < 14; d++) {
            const date = new Date();
            date.setDate(date.getDate() - d);
            const dateStr = date.toISOString().slice(0, 10);
            const count = d < 7 ? 15 : 10; // this week=15, last week=10
            rows.push({ date: dateStr, skill_counts: JSON.stringify({ 'TypeScript': count }) });
        }

        const db = makeDb(rows);
        const spikes = await detectSkillSpikes(db);
        const tsSpike = spikes.find(s => s.skill === 'TypeScript');
        expect(tsSpike).toBeDefined();
        expect(tsSpike.growthPct).toBeGreaterThanOrEqual(20);
    });

    test('does not flag skills with declining or stable counts', async () => {
        // This week: 5 occurrences/day.  Last week: 20 occurrences/day.
        // Growth = (35–140)/140 = –75% — definitively not a spike.
        const rows = [];
        for (let d = 0; d < 14; d++) {
            const date = new Date();
            date.setDate(date.getDate() - d);
            const count = d < 7 ? 5 : 20; // this week lower than last week
            rows.push({ date: date.toISOString().slice(0, 10), skill_counts: JSON.stringify({ 'React': count }) });
        }

        const db = makeDb(rows);
        const spikes = await detectSkillSpikes(db);
        const reactSpike = spikes.find(s => s.skill === 'React');
        expect(reactSpike).toBeUndefined();
    });

    test('flags brand-new skills appearing this week with ≥5 occurrences', async () => {
        const rows = [];
        for (let d = 0; d < 7; d++) {
            const date = new Date();
            date.setDate(date.getDate() - d);
            rows.push({ date: date.toISOString().slice(0, 10), skill_counts: JSON.stringify({ 'Bun': 6 }) });
        }
        const db = makeDb(rows);
        const spikes = await detectSkillSpikes(db);
        const bunSpike = spikes.find(s => s.skill === 'Bun');
        expect(bunSpike).toBeDefined();
    });
});

// ── detectHiringSurge ─────────────────────────────────────────────────────────

describe('detectHiringSurge', () => {
    test('returns empty array when no rows', async () => {
        const db = makeDb([]);
        const surges = await detectHiringSurge(db);
        expect(surges).toEqual([]);
    });

    test('maps DB rows to HiringSurge objects', async () => {
        const db = makeDb([
            { company: 'Acme Corp', job_count: 8, last_post_at: '2026-03-05T00:00:00Z' },
            { company: 'Beta Ltd',  job_count: 5, last_post_at: '2026-03-04T00:00:00Z' },
        ]);
        const surges = await detectHiringSurge(db);
        expect(surges).toHaveLength(2);
        expect(surges[0].company).toBe('Acme Corp');
        expect(surges[0].jobCount).toBe(8);
    });
});

// ── scoreCompanyMomentum ──────────────────────────────────────────────────────

describe('scoreCompanyMomentum', () => {
    test('returns 0-100 range', () => {
        const score = scoreCompanyMomentum({ jobCount: 10, lastPostAt: new Date().toISOString() });
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
    });

    test('very recent post + high count → high score', () => {
        const score = scoreCompanyMomentum({
            jobCount: 20,
            lastPostAt: new Date().toISOString(), // just now
        });
        expect(score).toBeGreaterThan(60);
    });

    test('old post + few jobs → lower score', () => {
        const oldDate = new Date();
        oldDate.setDate(oldDate.getDate() - 30);
        const score = scoreCompanyMomentum({ jobCount: 5, lastPostAt: oldDate.toISOString() });
        expect(score).toBeLessThan(50);
    });
});

// ── persistGrowthSignals ──────────────────────────────────────────────────────

describe('persistGrowthSignals', () => {
    test('returns counts of saved items', async () => {
        const db = {
            prepare: () => ({ bind: function(..._) { return this; }, all: async () => ({ success: true, results: [] }) }),
            batch: async () => {},
        };

        const spikes = [{ skill: 'TypeScript', thisWeekCount: 15, lastWeekCount: 10, growthPct: 50 }];
        const surges = [{ company: 'Acme', jobCount: 8, lastPostAt: new Date().toISOString() }];

        const result = await persistGrowthSignals(db, spikes, surges);
        expect(result.spikesSaved).toBe(1);
        expect(result.surgesSaved).toBe(1);
    });

    test('handles empty arrays without throwing', async () => {
        const db = { prepare: () => ({ bind: function() { return this; } }), batch: async () => {} };
        await expect(persistGrowthSignals(db, [], [])).resolves.toEqual({ spikesSaved: 0, surgesSaved: 0 });
    });
});

// ── runGrowthEngineCycle ──────────────────────────────────────────────────────

describe('runGrowthEngineCycle', () => {
    test('returns all four fields', async () => {
        const db = makeDb([]);
        const result = await runGrowthEngineCycle(db);
        expect(result).toHaveProperty('skillSpikes');
        expect(result).toHaveProperty('hiringSurges');
        expect(result).toHaveProperty('spikesSaved');
        expect(result).toHaveProperty('surgesSaved');
    });
});
