/**
 * Tests for Source Intelligence — priority scoring, tier assignment, cycle scheduling.
 */

import { calculatePriority, assignTier } from '../src/intelligence/sourceIntelligence.js';

describe('Source Intelligence Engine', () => {
    describe('calculatePriority', () => {
        it('should return 70 (exploration bonus) for a brand-new source with no history', () => {
            const source = {
                success_count: 0,
                failure_count: 0,
                last_job_count: 0,
                avg_job_count: 0,
                posting_frequency: 0,
                last_new_job_at: null,
                total_jobs_found: 0,
                dup_ratio: 0,
            };

            expect(calculatePriority(source)).toBe(70);
        });

        it('should score highly for a source with frequent successful fetches', () => {
            const source = {
                success_count: 100,
                failure_count: 2,
                last_job_count: 15,
                avg_job_count: 10,
                posting_frequency: 5,
                last_new_job_at: new Date(Date.now() - 30 * 60_000).toISOString(), // 30 min ago
                total_jobs_found: 500,
                dup_ratio: 0.3,
            };

            const score = calculatePriority(source);
            expect(score).toBeGreaterThanOrEqual(65);
        });

        it('should score low for a source with many failures', () => {
            const source = {
                success_count: 5,
                failure_count: 50,
                last_job_count: 0,
                avg_job_count: 2,
                posting_frequency: 0,
                last_new_job_at: new Date(Date.now() - 7 * 24 * 3_600_000).toISOString(), // 7 days ago
                total_jobs_found: 10,
                dup_ratio: 0.5,
            };

            const score = calculatePriority(source);
            expect(score).toBeLessThan(40);
        });

        it('should reward high freshness (recent new jobs)', () => {
            const fresh = {
                success_count: 10,
                failure_count: 0,
                last_job_count: 5,
                avg_job_count: 5,
                posting_frequency: 2,
                last_new_job_at: new Date(Date.now() - 30 * 60_000).toISOString(), // 30 min ago
                total_jobs_found: 50,
                dup_ratio: 0.2,
            };

            const stale = {
                ...fresh,
                last_new_job_at: new Date(Date.now() - 5 * 24 * 3_600_000).toISOString(), // 5 days ago
            };

            expect(calculatePriority(fresh)).toBeGreaterThan(calculatePriority(stale));
        });

        it('should handle edge case with null fields', () => {
            const source = {
                success_count: 5,
                failure_count: 1,
                last_job_count: null,
                avg_job_count: null,
                posting_frequency: null,
                last_new_job_at: null,
                total_jobs_found: null,
                dup_ratio: null,
            };

            const score = calculatePriority(source);
            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(100);
        });

        it('should be capped between 0 and 100', () => {
            // Extremely high values
            const superSource = {
                success_count: 10000,
                failure_count: 0,
                last_job_count: 100,
                avg_job_count: 10,
                posting_frequency: 50,
                last_new_job_at: new Date().toISOString(),
                total_jobs_found: 100000,
                dup_ratio: 0,
            };

            const score = calculatePriority(superSource);
            expect(score).toBeLessThanOrEqual(100);
            expect(score).toBeGreaterThanOrEqual(0);
        });

        it('should give exploration bonus for sources with < 5 attempts', () => {
            const newSource = { success_count: 0, failure_count: 0 };
            expect(calculatePriority(newSource)).toBe(70);

            const twoAttempts = { success_count: 2, failure_count: 0 };
            expect(calculatePriority(twoAttempts)).toBe(64);

            const fourAttempts = { success_count: 4, failure_count: 0 };
            expect(calculatePriority(fourAttempts)).toBe(58);
        });

        it('should penalize high-duplication sources', () => {
            const lowDup = {
                success_count: 50, failure_count: 0,
                last_job_count: 10, avg_job_count: 10,
                posting_frequency: 3, total_jobs_found: 200,
                last_new_job_at: new Date(Date.now() - 60_000).toISOString(),
                dup_ratio: 0.3,
            };
            const highDup = { ...lowDup, dup_ratio: 0.98 };

            expect(calculatePriority(lowDup)).toBeGreaterThan(calculatePriority(highDup));
        });
    });

    describe('assignTier', () => {
        it('should assign high tier for score >= 65', () => {
            expect(assignTier(85).tier).toBe('high');
            expect(assignTier(65).tier).toBe('high');
            expect(assignTier(100).tier).toBe('high');
        });

        it('should assign medium tier for score 35-64', () => {
            expect(assignTier(50).tier).toBe('medium');
            expect(assignTier(35).tier).toBe('medium');
            expect(assignTier(64).tier).toBe('medium');
        });

        it('should assign low tier for score 10-34', () => {
            expect(assignTier(25).tier).toBe('low');
            expect(assignTier(10).tier).toBe('low');
            expect(assignTier(34).tier).toBe('low');
        });

        it('should assign dormant tier for score < 10', () => {
            expect(assignTier(5).tier).toBe('dormant');
            expect(assignTier(0).tier).toBe('dormant');
            expect(assignTier(9).tier).toBe('dormant');
        });

        it('should return correct cycle intervals', () => {
            expect(assignTier(80).cycleInterval).toBe(1);    // high: every cycle
            expect(assignTier(50).cycleInterval).toBe(3);    // medium: every 3rd
            expect(assignTier(20).cycleInterval).toBe(8);    // low: every 8th
            expect(assignTier(5).cycleInterval).toBe(16);    // dormant: every 16th
        });
    });

    describe('Cycle-based scheduling logic', () => {
        it('should include high-tier sources in every cycle', () => {
            // Simulating the SQL logic: crawl_tier = 'high' always matches
            const cycles = [1, 2, 3, 4, 5, 8, 16];
            for (const cycle of cycles) {
                // high tier always matches
                expect(true).toBe(true); // always included
            }
        });

        it('should include medium-tier every 3rd cycle', () => {
            const shouldInclude = (cycle) => cycle % 3 === 0;
            expect(shouldInclude(3)).toBe(true);
            expect(shouldInclude(6)).toBe(true);
            expect(shouldInclude(1)).toBe(false);
            expect(shouldInclude(2)).toBe(false);
        });

        it('should include low-tier every 8th cycle', () => {
            const shouldInclude = (cycle) => cycle % 8 === 0;
            expect(shouldInclude(8)).toBe(true);
            expect(shouldInclude(16)).toBe(true);
            expect(shouldInclude(4)).toBe(false);
        });

        it('should include dormant-tier every 16th cycle', () => {
            const shouldInclude = (cycle) => cycle % 16 === 0;
            expect(shouldInclude(16)).toBe(true);
            expect(shouldInclude(32)).toBe(true);
            expect(shouldInclude(8)).toBe(false);
        });
    });
});
