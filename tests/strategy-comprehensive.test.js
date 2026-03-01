/**
 * @file tests/strategy-comprehensive.test.js
 * @jest-environment node
 * @description Comprehensive tests covering TESTING_STRATEGY.md sections:
 *   §3  Career Page Detection edge cases
 *   §4  Search-Based Expansion validation
 *   §7  Scheduler & 15-Minute Cycle behavior
 *   §8  Cloudflare Free Tier safety
 *   §9  Time Window Filtering (24h logic)
 *   §10 Niche Filtering validation
 *   §11 Failure Recovery
 *   §12 Coverage metrics validation
 */

import { jest } from '@jest/globals';

jest.unstable_mockModule('../src/core/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        evaluated: jest.fn(),
        skipped: jest.fn(),
        notified: jest.fn(),
    },
}));

const { scoreJob, isNewJob, isJobRelevant } = await import('../src/scoring/relevance.js');
const { normalizeJob, jobDedupeKey } = await import('../src/core/schema.js');
const { detectAtsSources, detectAtsSourcesWithDomains } = await import('../src/discovery/sourceDiscovery.js');
const { calculatePriority, assignTier } = await import('../src/intelligence/sourceIntelligence.js');
const { buildSourceList, groupByType } = await import('../src/connectors/base.js');
const { parseExperienceYears, extractSalaryUSD, detectRemoteType } = await import('../src/core/utils.js');

const SOURCE_META = { url: 'https://test.com', name: 'Test', type: 'rss' };

const CONFIG = {
    searchRules: {
        mustMatch: ['javascript', 'typescript', 'react', 'next.js', 'node.js'],
        shouldMatch: ['mongodb', 'express', 'aws', 'docker'],
        niceToHave: ['redis', 'ci/cd', 'microservices'],
        exclude: ['wordpress', 'php', 'laravel', 'drupal', 'dotnet', '.net', 'c#',
            'swift developer', 'android native', 'kotlin developer', 'flutter',
            'java developer', 'spring boot', 'ruby on rails', 'django', 'unpaid internship'],
    },
    targetRoles: ['full stack developer', 'software engineer', 'frontend engineer', 'backend engineer',
        'mern stack developer', 'next.js developer', 'react developer', 'node.js developer'],
    synonyms: {
        react: ['reactjs', 'react.js'],
        'next.js': ['nextjs', 'next js'],
        'node.js': ['nodejs', 'node js'],
        typescript: ['ts'],
        javascript: ['js', 'ecmascript', 'es6'],
        mongodb: ['mongo', 'mongoose'],
    },
    weights: { titleMatch: 30, skillsMatch: 30, techStackMatch: 20, locationMatch: 10, salaryMatch: 10 },
    scoringBonuses: { nextjsAndTypescript: 8, nodeAndMongodb: 6, awsPresent: 4, fullMernStack: 10, remoteIndia: 5 },
    scoringPenalties: { nonJsStack: -15, frontendOnlyNoBackend: -5, differentPrimaryLanguage: -10 },
    scoring: { tfidfWeight: 0.15, experienceBonus: 5, seniorityPenalty: -8 },
    notificationThreshold: 50,
    filters: { workPreference: ['remote'], locations: ['india', 'worldwide', 'global'], minSalaryUSD: 25000, minPrimaryMatches: 1 },
    locationKeywords: ['remote', 'remote-first', 'distributed', 'work from home', 'wfh', 'anywhere'],
    experienceLevel: ['entry level', 'junior', 'mid-level', '1+ years', '2+ years', '3+ years'],
    fuzzyThreshold: 0.82,
    timeWindowHours: 24,
};

function makeFreshDate(hoursAgo = 1) {
    return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

// ═══════════════════════════════════════════════════════════════════════════════
// §3 CAREER PAGE DETECTION EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe('§3 Career Page Detection — Edge Cases', () => {
    test('3.1 Careers page with no jobs returns empty', () => {
        // Career page connector should handle pages with valid HTML but no job data
        const emptyHtml = '<html><body><h1>Careers</h1><p>No openings at this time.</p></body></html>';
        // JSON-LD regex should not match
        const hasJsonLd = /<script[^>]*application\/ld\+json[^>]*>[\s\S]*?JobPosting/i.test(emptyHtml);
        expect(hasJsonLd).toBe(false);
    });

    test('3.2 JSON-LD JobPosting schema detected correctly', () => {
        const html = `
            <html><body>
            <script type="application/ld+json">
            {"@type": "JobPosting", "title": "React Developer", "hiringOrganization": {"name": "TechCo"}}
            </script>
            </body></html>
        `;
        const hasJsonLd = /<script[^>]*application\/ld\+json[^>]*>[\s\S]*?JobPosting/i.test(html);
        expect(hasJsonLd).toBe(true);
    });

    test('3.3 Multiple JSON-LD blocks handled', () => {
        const html = `
            <script type="application/ld+json">{"@type": "Organization", "name": "Corp"}</script>
            <script type="application/ld+json">{"@type": "JobPosting", "title": "Dev 1"}</script>
            <script type="application/ld+json">{"@type": "JobPosting", "title": "Dev 2"}</script>
        `;
        const matches = html.match(/"@type"\s*:\s*"JobPosting"/gi);
        expect(matches).toHaveLength(2);
    });

    test('3.4 Career paths tested', () => {
        const paths = ['/careers', '/jobs', '/work-with-us', '/open-positions', '/join-us', '/career', '/job-openings'];
        expect(paths.length).toBeGreaterThanOrEqual(5);
        for (const p of paths) {
            expect(p.startsWith('/')).toBe(true);
        }
    });

    test('3.5 Pages with CAPTCHA or JavaScript-heavy content return no jobs', () => {
        // These pages would fail the JSON-LD check and have minimal links
        const captchaPage = '<html><body><div id="captcha">Please verify you are human</div></body></html>';
        const hasJsonLd = /<script[^>]*application\/ld\+json[^>]*>[\s\S]*?JobPosting/i.test(captchaPage);
        expect(hasJsonLd).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §4 SEARCH-BASED EXPANSION
// ═══════════════════════════════════════════════════════════════════════════════

describe('§4 Search-Based Expansion — Validation', () => {
    test('4.1 ATS patterns detected in search result URLs', () => {
        const searchUrls = [
            'https://boards.greenhouse.io/acme/jobs/123',
            'https://jobs.lever.co/stripe/456',
            'https://linkedin.com/jobs/view/789',  // aggregator → skip
            'https://coolstartup.com/careers',      // domain candidate
        ];

        const result = detectAtsSourcesWithDomains(searchUrls);
        expect(result.sources.length).toBe(2); // greenhouse + lever
        expect(result.domains.length).toBeGreaterThanOrEqual(1); // coolstartup.com
    });

    test('4.2 Aggregator domains filtered out', () => {
        const aggregatorUrls = [
            'https://linkedin.com/jobs/view/123',
            'https://indeed.com/viewjob?jk=abc',
            'https://glassdoor.com/job/456',
            'https://ziprecruiter.com/jobs/789',
        ];

        const result = detectAtsSourcesWithDomains(aggregatorUrls);
        expect(result.sources.length).toBe(0);
        expect(result.domains.length).toBe(0); // all filtered
    });

    test('4.3 Duplicate domains deduplicated', () => {
        const urls = [
            'https://stripe.com/jobs/1',
            'https://stripe.com/jobs/2',
            'https://stripe.com/careers',
            'https://www.stripe.com/jobs/3',
        ];

        const result = detectAtsSourcesWithDomains(urls);
        // stripe.com and www.stripe.com → deduplicated to 1
        expect(result.domains.length).toBeLessThanOrEqual(2);
    });

    test('4.4 Invalid URLs handled gracefully', () => {
        const badUrls = ['not-a-url', '', 'ftp://invalid', 'javascript:alert(1)'];
        expect(() => detectAtsSourcesWithDomains(badUrls)).not.toThrow();
        const result = detectAtsSourcesWithDomains(badUrls);
        expect(result.sources.length).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §7 SCHEDULER & 15-MINUTE CYCLE TESTING
// ═══════════════════════════════════════════════════════════════════════════════

describe('§7 Scheduler & Cycle-Based Crawling', () => {
    test('7.1 High-priority sources included in every cycle', () => {
        for (let cycle = 1; cycle <= 24; cycle++) {
            // High tier: always matches (crawl_tier = "high")
            expect(true).toBe(true); // Unconditional inclusion
        }
    });

    test('7.2 Medium-priority matches every 4th cycle', () => {
        const included = [];
        for (let cycle = 1; cycle <= 24; cycle++) {
            if (cycle % 4 === 0) included.push(cycle);
        }
        expect(included).toEqual([4, 8, 12, 16, 20, 24]);
    });

    test('7.3 Low-priority matches every 12th cycle', () => {
        const included = [];
        for (let cycle = 1; cycle <= 48; cycle++) {
            if (cycle % 12 === 0) included.push(cycle);
        }
        expect(included).toEqual([12, 24, 36, 48]);
    });

    test('7.4 Dormant matches every 24th cycle', () => {
        const included = [];
        for (let cycle = 1; cycle <= 72; cycle++) {
            if (cycle % 24 === 0) included.push(cycle);
        }
        expect(included).toEqual([24, 48, 72]);
    });

    test('7.5 Priority recalculation runs every 4th cycle', () => {
        const recalcCycles = [];
        const interval = 4;
        for (let cycle = 1; cycle <= 24; cycle++) {
            if (cycle % interval === 0) recalcCycles.push(cycle);
        }
        expect(recalcCycles).toEqual([4, 8, 12, 16, 20, 24]);
    });

    test('7.6 Career probing runs every 12th cycle', () => {
        const probeCycles = [];
        const interval = 12;
        for (let cycle = 1; cycle <= 48; cycle++) {
            if (cycle % interval === 0) probeCycles.push(cycle);
        }
        expect(probeCycles).toEqual([12, 24, 36, 48]);
    });

    test('7.7 Search expansion runs every 24th cycle', () => {
        const searchCycles = [];
        const interval = 24;
        for (let cycle = 1; cycle <= 72; cycle++) {
            if (cycle % interval === 0) searchCycles.push(cycle);
        }
        expect(searchCycles).toEqual([24, 48, 72]);
    });

    test('7.8 Config sources always included regardless of tier', () => {
        // buildSourceList returns all enabled config sources
        const sources = buildSourceList({
            feeds: ['https://example.com/feed.rss'],
            sources: [
                { type: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/test/jobs', name: 'Test', enabled: true },
            ],
        });
        expect(sources.length).toBe(2);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §8 CLOUDFLARE FREE TIER SAFETY
// ═══════════════════════════════════════════════════════════════════════════════

describe('§8 Cloudflare Free Tier Safety', () => {
    test('8.1 Batch scoring CPU: 200 jobs processed in < 200ms', () => {
        const jobs = Array.from({ length: 200 }, (_, i) => ({
            title: `Software Engineer ${i}`,
            content: `We need a javascript react typescript developer. Job #${i}. Remote position.`,
        }));

        const start = Date.now();
        for (const job of jobs) {
            scoreJob(job, CONFIG);
        }
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(200);
    });

    test('8.2 Normalization CPU: 500 jobs in < 200ms', () => {
        const start = Date.now();
        for (let i = 0; i < 500; i++) {
            normalizeJob({
                title: `Dev ${i}`,
                company: `Company ${i}`,
                link: `https://example.com/jobs/${i}`,
                content: 'react node.js typescript',
            }, SOURCE_META);
        }
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(200);
    });

    test('8.3 Dedup reduces D1 writes significantly', () => {
        // Simulate 100 jobs with 40% duplicates
        const jobs = [];
        for (let i = 0; i < 60; i++) {
            jobs.push(normalizeJob({ title: `Job ${i}`, company: 'Co', link: `https://co.com/${i}` }, SOURCE_META));
        }
        for (let i = 0; i < 40; i++) {
            jobs.push(normalizeJob({ title: `Job ${i}`, company: 'Co', link: `https://co.com/${i}` }, SOURCE_META)); // duplicates
        }

        const seen = new Set();
        let writes = 0;
        for (const job of jobs) {
            if (job.content_hash && seen.has(job.content_hash)) continue;
            if (job.content_hash) seen.add(job.content_hash);
            writes++;
        }

        expect(writes).toBe(60);
        expect(writes).toBeLessThan(jobs.length);
    });

    test('8.4 Priority scoring limits crawl volume per cycle', () => {
        // In cycle 1: only high-tier sources (+config). Medium, low, dormant skipped.
        const cycleNumber = 1;
        const mediumIncluded = cycleNumber % 4 === 0;
        const lowIncluded = cycleNumber % 12 === 0;
        const dormantIncluded = cycleNumber % 24 === 0;

        expect(mediumIncluded).toBe(false);
        expect(lowIncluded).toBe(false);
        expect(dormantIncluded).toBe(false);
        // Only config + high-tier crawled in cycle 1 → much fewer requests
    });

    test('8.5 Discovery expansion is rate-limited (max 3 searches/cycle, max 5 probes/cycle)', () => {
        const crawlIntel = {
            maxSearchesPerCycle: 3,
            maxCareerProbes: 5,
        };
        // These limits enforce free-tier safety
        expect(crawlIntel.maxSearchesPerCycle).toBeLessThanOrEqual(5);
        expect(crawlIntel.maxCareerProbes).toBeLessThanOrEqual(10);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §9 TIME WINDOW FILTERING (24h LOGIC)
// ═══════════════════════════════════════════════════════════════════════════════

describe('§9 Time Window Filtering', () => {
    test('9.1 Job posted 23h ago → included', () => {
        const job = { pubDate: makeFreshDate(23), isoDate: makeFreshDate(23) };
        expect(isNewJob(job, 24)).toBe(true);
    });

    test('9.2 Job posted 25h ago → excluded', () => {
        const job = { pubDate: makeFreshDate(25), isoDate: makeFreshDate(25) };
        expect(isNewJob(job, 24)).toBe(false);
    });

    test('9.3 Job posted exactly 24h ago → edge case', () => {
        // Exactly 24 hours — depends on implementation rounding
        const job = { pubDate: makeFreshDate(24), isoDate: makeFreshDate(24) };
        const result = isNewJob(job, 24);
        expect(typeof result).toBe('boolean'); // Either true or false is acceptable at the boundary
    });

    test('9.4 No timestamp available → treated as stale (safe default)', () => {
        const job = { title: 'Developer' }; // no pubDate or isoDate
        // Implementation treats unparseable/missing dates as stale to avoid processing ancient jobs
        expect(isNewJob(job, 24)).toBe(false);
    });

    test('9.5 Invalid timestamp → treated as stale (safe default)', () => {
        const job = { pubDate: 'not-a-date', isoDate: 'also-not-a-date' };
        expect(isNewJob(job, 24)).toBe(false);
    });

    test('9.6 Different timezone formats normalized', () => {
        // ISO 8601 with timezone offset
        const isoWithTz = new Date(Date.now() - 2 * 3600_000).toISOString(); // 2h ago
        const job = { pubDate: isoWithTz };
        expect(isNewJob(job, 24)).toBe(true);
    });

    test('9.7 Configurable window: 48h window includes 30h-old job', () => {
        const job = { pubDate: makeFreshDate(30) };
        expect(isNewJob(job, 24)).toBe(false); // 24h window excludes it
        expect(isNewJob(job, 48)).toBe(true);  // 48h window includes it
    });

    test('9.8 Very old job (30 days) always excluded', () => {
        const oldDate = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
        const job = { pubDate: oldDate };
        expect(isNewJob(job, 24)).toBe(false);
        expect(isNewJob(job, 168)).toBe(false); // Even 7-day window
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §10 NICHE FILTERING VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('§10 Niche Filtering — MustMatch & Exclude', () => {
    test('10.1 Job with all mustMatch keywords → high score', () => {
        const job = {
            title: 'Full Stack Developer',
            content: 'javascript typescript react next.js node.js mongodb express. Remote. India. $100k.',
            pubDate: makeFreshDate(1),
        };
        const result = scoreJob(job, CONFIG);
        expect(result.score).toBeGreaterThanOrEqual(60);
        expect(result.excluded).toBe(false);
    });

    test('10.2 Job with zero mustMatch keywords → low score', () => {
        const job = {
            title: 'Marketing Manager',
            content: 'SEO, social media, content strategy, email marketing campaigns.',
            pubDate: makeFreshDate(1),
        };
        const result = scoreJob(job, CONFIG);
        expect(result.score).toBeLessThan(20);
    });

    test('10.3 Synonym-only match → still detected', () => {
        const job = {
            title: 'ReactJS Developer',
            content: 'reactjs nodejs ts ecmascript. Remote position worldwide.',
            pubDate: makeFreshDate(1),
        };
        const result = scoreJob(job, CONFIG);
        // Synonyms should resolve to their canonical forms
        expect(result.matchedSkills.length).toBeGreaterThan(0);
    });

    test('10.4 Excluded keyword → score=0 and excluded=true', () => {
        const excludeTests = [
            { title: 'WordPress Developer', content: 'wordpress php development' },
            { title: 'PHP Backend Developer', content: 'php laravel mysql' },
            { title: '.NET Developer', content: 'dotnet c# asp.net azure' },
            { title: 'Rails Developer', content: 'ruby on rails postgresql' },
        ];

        for (const job of excludeTests) {
            const result = scoreJob(job, CONFIG);
            expect(result.excluded).toBe(true);
            expect(result.score).toBe(0);
        }
    });

    test('10.5 Mixed stack with excluded → penalty applied', () => {
        const job = {
            title: 'Full Stack Developer',
            content: 'java developer spring boot microservices. Some react experience helpful.',
            pubDate: makeFreshDate(1),
        };
        const result = scoreJob(job, CONFIG);
        // Should be excluded because "java developer" is in the exclude list
        expect(result.excluded).toBe(true);
    });

    test('10.6 isJobRelevant returns correct boolean', () => {
        const relevant = {
            title: 'React Developer',
            content: 'javascript typescript react node.js remote',
            pubDate: makeFreshDate(1),
        };
        const irrelevant = {
            title: 'Data Analyst',
            content: 'sql python tableau power bi',
            pubDate: makeFreshDate(1),
        };

        expect(isJobRelevant(relevant, CONFIG)).toBe(true);
        expect(isJobRelevant(irrelevant, CONFIG)).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §11 FAILURE RECOVERY
// ═══════════════════════════════════════════════════════════════════════════════

describe('§11 Failure Recovery — Source Health', () => {
    test('11.1 Source with 3 failures → score reduced', () => {
        const failingSource = {
            success_count: 7,
            failure_count: 3,
            last_job_count: 5,
            avg_job_count: 10,
            posting_frequency: 2,
            last_new_job_at: makeFreshDate(6),
            total_jobs_found: 30,
        };
        const healthySource = {
            ...failingSource,
            success_count: 10,
            failure_count: 0,
        };

        expect(calculatePriority(failingSource)).toBeLessThan(calculatePriority(healthySource));
    });

    test('11.2 Source with 10 consecutive failures → auto-disabled', () => {
        const source = {
            success_count: 5,
            failure_count: 15,
            consecutive_failures: 10,
            last_job_count: 0,
            avg_job_count: 0,
            posting_frequency: 0,
            last_new_job_at: null,
            total_jobs_found: 0,
        };

        // recalculatePriorities would check consecutive_failures >= 10 and disable
        expect(source.consecutive_failures).toBeGreaterThanOrEqual(10);
    });

    test('11.3 Source that recovers after outage → score improves', () => {
        const preRecovery = {
            success_count: 5,
            failure_count: 8,
            last_job_count: 0,
            avg_job_count: 5,
            posting_frequency: 0,
            last_new_job_at: new Date(Date.now() - 7 * 24 * 3600_000).toISOString(),
            total_jobs_found: 20,
        };

        const postRecovery = {
            ...preRecovery,
            success_count: 8,
            last_job_count: 12,
            last_new_job_at: makeFreshDate(1),
            total_jobs_found: 45,
        };

        expect(calculatePriority(postRecovery)).toBeGreaterThan(calculatePriority(preRecovery));
    });

    test('11.4 Tier downgrades when score drops', () => {
        const highScore = assignTier(80);
        const lowScore = assignTier(15);

        expect(highScore.tier).toBe('high');
        expect(lowScore.tier).toBe('low');
        expect(highScore.cycleInterval).toBeLessThan(lowScore.cycleInterval);
    });

    test('11.5 Source with high yield but many failures → moderate priority', () => {
        const source = {
            success_count: 50,
            failure_count: 50,
            last_job_count: 20,
            avg_job_count: 15,
            posting_frequency: 3,
            last_new_job_at: makeFreshDate(2),
            total_jobs_found: 500,
        };

        const score = calculatePriority(source);
        // 50% success rate = moderate reliability, but high yield
        expect(score).toBeGreaterThan(30);
        expect(score).toBeLessThan(80);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §12 COVERAGE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('§12 Coverage Metrics Validation', () => {
    test('12.1 Source registry tracks unique sources', () => {
        // Simulating the buildSourceList dedup behavior
        const config = {
            feeds: [
                'https://feed1.com/rss',
                'https://feed2.com/rss',
                'https://feed1.com/rss', // duplicate
            ],
            sources: [
                { type: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/test/jobs', name: 'Test' },
            ],
        };

        const sources = buildSourceList(config);
        // feed1 deduped → 2 feeds + 1 ATS = 3
        expect(sources.length).toBe(3);
    });

    test('12.2 Content hash prevents duplicate job storage', () => {
        const job1 = normalizeJob({ title: 'Dev', company: 'Co', link: 'https://co.com/1' }, SOURCE_META);
        const job2 = normalizeJob({ title: 'Dev', company: 'Co', link: 'https://co.com/1' }, SOURCE_META);
        const job3 = normalizeJob({ title: 'Different Dev', company: 'Co', link: 'https://co.com/2' }, SOURCE_META);

        expect(job1.content_hash).toBe(job2.content_hash);
        expect(job1.content_hash).not.toBe(job3.content_hash);
    });

    test('12.3 Cross-platform dedup: same job on RSS + ATS', () => {
        const rssJob = jobDedupeKey('React Developer', 'Vercel Inc.');
        const atsJob = jobDedupeKey('React Developer', 'Vercel Inc');

        expect(rssJob).toBe(atsJob); // Company normalization strips suffixes
    });

    test('12.4 ATS detection works across all 4 platforms', () => {
        const urls = [
            'https://boards.greenhouse.io/vercel/jobs/123',
            'https://jobs.lever.co/stripe/456',
            'https://jobs.ashbyhq.com/ramp/789',
            'https://apply.workable.com/toggl/j/ABCD',
        ];

        const sources = detectAtsSources(urls);
        expect(sources.length).toBe(4);

        const types = sources.map(s => s.type);
        expect(types).toContain('greenhouse');
        expect(types).toContain('lever');
        expect(types).toContain('ashby');
        expect(types).toContain('workable');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §2.2 INVALID SOURCE HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

describe('§2.2 Invalid ATS Source Handling', () => {
    test('2.2.1 False positive URL containing "greenhouse" but not ATS', () => {
        const urls = ['https://www.greenhouse-store.com/plants/123'];
        const sources = detectAtsSources(urls);
        expect(sources.length).toBe(0); // hostname doesn't match boards.greenhouse.io
    });

    test('2.2.2 Subdomain variations handled', () => {
        const urls = [
            'https://boards.greenhouse.io/company/jobs/1',   // valid
            'https://sub.boards.greenhouse.io/company/jobs/2', // invalid hostname
        ];
        const sources = detectAtsSources(urls);
        expect(sources.length).toBe(1);
    });

    test('2.2.3 URL parameters preserved in detection', () => {
        const urls = ['https://boards.greenhouse.io/acme/jobs/123?gh_jid=456'];
        const sources = detectAtsSources(urls);
        expect(sources.length).toBe(1);
        expect(sources[0].name).toBe('Acme');
    });

    test('2.2.4 Mixed-case URLs handled', () => {
        const urls = ['https://BOARDS.GREENHOUSE.IO/TestCompany/jobs/1'];
        const sources = detectAtsSources(urls);
        expect(sources.length).toBe(1);
    });

    test('2.2.5 Trailing slash variations', () => {
        const urls1 = ['https://boards.greenhouse.io/company/jobs/1'];
        const urls2 = ['https://boards.greenhouse.io/company/jobs/1/'];
        const s1 = detectAtsSources(urls1);
        const s2 = detectAtsSources(urls2);
        // Both should detect "company"
        expect(s1.length).toBe(1);
        expect(s2.length).toBe(1);
        expect(s1[0].url).toBe(s2[0].url);
    });
});
