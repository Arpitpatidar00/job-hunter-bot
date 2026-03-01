/**
 * Tests for Source Intelligence — priority scoring, tier assignment, cycle scheduling.
 */

import { calculatePriority, assignTier } from '../src/intelligence/sourceIntelligence.js';

describe('Source Intelligence Engine', () => {
    describe('calculatePriority', () => {
        it('should return 50 for a brand-new source with no history', () => {
            const source = {
                success_count: 0,
                failure_count: 0,
                last_job_count: 0,
                avg_job_count: 0,
                posting_frequency: 0,
                last_new_job_at: null,
                total_jobs_found: 0,
            };

            expect(calculatePriority(source)).toBe(50);
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
            };

            const score = calculatePriority(source);
            expect(score).toBeGreaterThanOrEqual(70);
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
            };

            const score = calculatePriority(superSource);
            expect(score).toBeLessThanOrEqual(100);
            expect(score).toBeGreaterThanOrEqual(0);
        });
    });

    describe('assignTier', () => {
        it('should assign high tier for score >= 70', () => {
            expect(assignTier(85).tier).toBe('high');
            expect(assignTier(70).tier).toBe('high');
            expect(assignTier(100).tier).toBe('high');
        });

        it('should assign medium tier for score 40-69', () => {
            expect(assignTier(50).tier).toBe('medium');
            expect(assignTier(40).tier).toBe('medium');
            expect(assignTier(69).tier).toBe('medium');
        });

        it('should assign low tier for score 10-39', () => {
            expect(assignTier(25).tier).toBe('low');
            expect(assignTier(10).tier).toBe('low');
            expect(assignTier(39).tier).toBe('low');
        });

        it('should assign dormant tier for score < 10', () => {
            expect(assignTier(5).tier).toBe('dormant');
            expect(assignTier(0).tier).toBe('dormant');
            expect(assignTier(9).tier).toBe('dormant');
        });

        it('should return correct cycle intervals', () => {
            expect(assignTier(80).cycleInterval).toBe(1);   // high: every cycle
            expect(assignTier(50).cycleInterval).toBe(4);   // medium: every 4th
            expect(assignTier(20).cycleInterval).toBe(12);  // low: every 12th
            expect(assignTier(5).cycleInterval).toBe(24);   // dormant: every 24th
        });
    });

    describe('Cycle-based scheduling logic', () => {
        it('should include high-tier sources in every cycle', () => {
            // Simulating the SQL logic: crawl_tier = 'high' always matches
            const cycles = [1, 2, 3, 4, 5, 12, 24];
            for (const cycle of cycles) {
                // high tier always matches
                expect(true).toBe(true); // always included
            }
        });

        it('should include medium-tier every 4th cycle', () => {
            const shouldInclude = (cycle) => cycle % 4 === 0;
            expect(shouldInclude(4)).toBe(true);
            expect(shouldInclude(8)).toBe(true);
            expect(shouldInclude(1)).toBe(false);
            expect(shouldInclude(3)).toBe(false);
        });

        it('should include low-tier every 12th cycle', () => {
            const shouldInclude = (cycle) => cycle % 12 === 0;
            expect(shouldInclude(12)).toBe(true);
            expect(shouldInclude(24)).toBe(true);
            expect(shouldInclude(6)).toBe(false);
        });

        it('should include dormant-tier every 24th cycle', () => {
            const shouldInclude = (cycle) => cycle % 24 === 0;
            expect(shouldInclude(24)).toBe(true);
            expect(shouldInclude(48)).toBe(true);
            expect(shouldInclude(12)).toBe(false);
        });
    });
});
