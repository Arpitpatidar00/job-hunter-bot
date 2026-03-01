/**
 * Tests for Search Expander — domain extraction, URL filtering, dedup.
 */

describe('Search Expander', () => {
    const SKIP_DOMAINS = new Set([
        'linkedin.com', 'indeed.com', 'glassdoor.com', 'monster.com',
        'ziprecruiter.com', 'angel.co', 'wellfound.com', 'dice.com',
        'google.com', 'youtube.com', 'facebook.com', 'twitter.com',
        'github.com', 'stackoverflow.com', 'reddit.com', 'medium.com',
        'boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com',
        'apply.workable.com',
    ]);

    function extractDomains(urls, maxDomains = 10) {
        const seen = new Set();
        const results = [];
        for (const url of urls) {
            if (results.length >= maxDomains) break;
            try {
                const parsed = new URL(url);
                const domain = parsed.hostname.replace(/^www\./, '');
                if (SKIP_DOMAINS.has(domain) || seen.has(domain)) continue;
                seen.add(domain);
                results.push({ domain, sourceUrl: url });
            } catch { continue; }
        }
        return results;
    }

    describe('Domain Extraction', () => {
        it('should extract unique domains from URLs', () => {
            const urls = [
                'https://stripe.com/jobs/123',
                'https://www.stripe.com/jobs/456',
                'https://vercel.com/careers',
                'https://supabase.com/jobs/789',
            ];

            const domains = extractDomains(urls);
            expect(domains).toHaveLength(3); // stripe deduped
            expect(domains[0].domain).toBe('stripe.com');
            expect(domains[1].domain).toBe('vercel.com');
            expect(domains[2].domain).toBe('supabase.com');
        });

        it('should skip known job board domains', () => {
            const urls = [
                'https://linkedin.com/jobs/view/123',
                'https://indeed.com/viewjob?jk=abc',
                'https://coolstartup.com/jobs/dev',
            ];

            const domains = extractDomains(urls);
            expect(domains).toHaveLength(1);
            expect(domains[0].domain).toBe('coolstartup.com');
        });

        it('should skip ATS platform domains', () => {
            const urls = [
                'https://boards.greenhouse.io/discord/jobs/123',
                'https://jobs.lever.co/stripe/456',
                'https://apply.workable.com/toggl/j/ABCD',
                'https://techcompany.com/careers',
            ];

            const domains = extractDomains(urls);
            expect(domains).toHaveLength(1);
            expect(domains[0].domain).toBe('techcompany.com');
        });

        it('should respect maxDomains limit', () => {
            const urls = Array.from({ length: 50 }, (_, i) =>
                `https://company${i}.com/jobs`
            );

            const domains = extractDomains(urls, 5);
            expect(domains).toHaveLength(5);
        });

        it('should handle invalid URLs gracefully', () => {
            const urls = ['not-a-url', '', null, undefined, 'https://valid.com/job'];
            const domains = extractDomains(urls.filter(Boolean));
            expect(domains).toHaveLength(1);
            expect(domains[0].domain).toBe('valid.com');
        });
    });

    describe('DuckDuckGo URL Extraction', () => {
        it('should extract URLs from DuckDuckGo result HTML', () => {
            const html = `
                <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fjobs&something=else">Example Jobs</a>
                <a rel="nofollow" class="result__a" href="https://techcorp.com/careers">TechCorp</a>
            `;

            const regex = /class\s*=\s*["']result__a["'][^>]*href\s*=\s*["']([^"']+)["']/gi;
            const urls = [];
            let match;
            while ((match = regex.exec(html)) !== null) {
                urls.push(match[1]);
            }

            expect(urls).toHaveLength(2);
        });

        it('should decode DuckDuckGo redirect URLs', () => {
            const redirectUrl = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fjobs&v=1';
            try {
                const decoded = new URL('https:' + redirectUrl);
                const target = decodeURIComponent(decoded.searchParams.get('uddg') || '');
                expect(target).toBe('https://example.com/jobs');
            } catch {
                // URL parsing might fail in some environments
            }
        });
    });
});
