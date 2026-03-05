/**
 * @module config
 * @description Bot configuration — hardcoded for Cloudflare Workers (no filesystem access).
 * Previously loaded from config.json + CLI args; now exported as a frozen object.
 */

/**
 * Bot configuration (v3.1) — Cloudflare Workers.
 * Secrets (webhook URLs, tokens) come from the `env` binding at runtime.
 * @returns {Readonly<object>} Frozen, validated config object.
 */
export function loadConfig() {
    return Object.freeze({
        version: '3.1.0',
        feeds: [
            "https://jobscollider.com/remote-jobs.rss",
            "https://hireweb3.io/job/rss",
            "https://empllo.com/feeds/remote-engineering-jobs.rss",
            "https://empllo.com/feeds/remote-devops-jobs.rss",
            "https://www.smartremotejobs.com/feed/all.rss",
            "https://www.smartremotejobs.com/feed/software-development-remote-jobs.rss",
            "https://weworkremotely.com/remote-jobs.rss",
            "https://weworkremotely.com/categories/remote-programming-jobs.rss",
            "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss",
            "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
            "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss",
            "https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss",
            "https://remoteok.com/remote-dev-jobs.rss",
            "https://himalayas.app/jobs/rss",
            "https://4dayweek.io/rss",
            "https://app.vuejobs.com/feed/posts",
            "https://dribbble.com/jobs.rss",
            "https://hasjob.co/feed",
            "https://remoteok.io/remote-jobs.rss",
            "https://www.fossjobs.net/rss/all/",
            "https://cryptojobslist.com/jobs.rss",
            "https://cryptocurrencyjobs.co/index.xml",
            "https://jobspresso.co/feed/?post_type=job_listing",
            "https://remoteworkhub.com/feed/?post_type=job",
            "https://landing.jobs/feed?remote=true",
        ],

        // ── Multi-source ATS platforms (Phase 2) ─────────────────────────────
        sources: [
            // Greenhouse boards (public JSON API)
            { type: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/hashicorp/jobs', name: 'HashiCorp', enabled: true },
            { type: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/discord/jobs', name: 'Discord', enabled: true },
            { type: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/figma/jobs', name: 'Figma', enabled: true },
            { type: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/cloudflare/jobs', name: 'Cloudflare', enabled: true },
            { type: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/netlify/jobs', name: 'Netlify', enabled: true },
            { type: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/vercel/jobs', name: 'Vercel', enabled: true },
            { type: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/supabase/jobs', name: 'Supabase', enabled: true },
            { type: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/linear/jobs', name: 'Linear', enabled: true },
            { type: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/notion/jobs', name: 'Notion', enabled: true },
            { type: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/datadog/jobs', name: 'Datadog', enabled: true },
            { type: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/daboraio/jobs', name: 'dbt Labs', enabled: true },
            { type: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/grafanalabs/jobs', name: 'Grafana Labs', enabled: true },

            // Lever postings (public JSON API)
            { type: 'lever', url: 'https://api.lever.co/v0/postings/stripe', name: 'Stripe', enabled: true },
            { type: 'lever', url: 'https://api.lever.co/v0/postings/twitch', name: 'Twitch', enabled: true },
            { type: 'lever', url: 'https://api.lever.co/v0/postings/netlify', name: 'Netlify (Lever)', enabled: true },

            // Ashby (public posting API)
            { type: 'ashby', url: 'https://api.ashbyhq.com/posting-api/job-board/notion', name: 'Notion (Ashby)', enabled: true },
            { type: 'ashby', url: 'https://api.ashbyhq.com/posting-api/job-board/linear', name: 'Linear (Ashby)', enabled: true },
            { type: 'ashby', url: 'https://api.ashbyhq.com/posting-api/job-board/ramp', name: 'Ramp', enabled: true },

            // Workable (public jobs API)
            { type: 'workable', url: 'https://apply.workable.com/api/v3/accounts/pricehubble/jobs', name: 'PriceHubble', enabled: true },
            { type: 'workable', url: 'https://apply.workable.com/api/v3/accounts/toggl/jobs', name: 'Toggl', enabled: true },
        ],

        searchRules: {
            mustMatch: ["javascript", "typescript", "react", "next.js", "node.js"],
            shouldMatch: [
                "mongodb", "postgresql", "express", "graphql", "rest api",
                "aws", "docker", "tailwindcss", "prisma", "nestjs",
            ],
            niceToHave: [
                "redis", "ci/cd", "microservices", "system design", "nx monorepo",
                "kubernetes", "terraform", "github actions", "jest", "cypress",
            ],
            exclude: [
                "wordpress", "php", "laravel", "drupal", "dotnet", ".net", "c#",
                "swift developer", "android native", "kotlin developer", "flutter",
                "java developer", "spring boot", "ruby on rails", "django", "unpaid internship",
            ],
        },

        targetRoles: [
            "full stack developer", "full stack engineer", "fullstack developer", "fullstack engineer",
            "mern stack developer", "mern stack engineer", "next.js developer", "next.js engineer",
            "frontend engineer", "frontend developer", "frontend react developer",
            "backend engineer", "backend developer", "backend engineer node.js",
            "software engineer", "software developer", "web developer", "web engineer",
            "javascript developer", "javascript engineer", "typescript developer",
            "react developer", "react engineer", "node.js developer", "node.js engineer",
        ],

        experienceLevel: [
            "entry level", "junior", "associate", "mid-level", "mid",
            "sde 1", "sde 2", "1+ years", "2+ years", "3+ years", "4+ years",
        ],

        synonyms: {
            "react": ["reactjs", "react.js", "react js"],
            "next.js": ["nextjs", "next js", "next.js", "next"],
            "node.js": ["nodejs", "node js", "node.js", "node"],
            "typescript": ["ts", "typescript"],
            "javascript": ["js", "ecmascript", "es6", "es2015", "es2020", "es2022"],
            "mongodb": ["mongo", "mongoose", "mongodb atlas"],
            "postgresql": ["postgres", "psql", "pg"],
            "express": ["expressjs", "express.js"],
            "graphql": ["graph ql", "apollo graphql", "apollo"],
            "aws": ["amazon web services", "amazon cloud"],
            "docker": ["containerization", "containers"],
            "tailwindcss": ["tailwind", "tailwind css"],
            "nestjs": ["nest.js", "nest js"],
            "redis": ["redis cache", "elasticache"],
            "prisma": ["prisma orm"],
            "rest api": ["restful", "rest", "restful api"],
        },

        weights: {
            titleMatch: 30,
            skillsMatch: 30,
            techStackMatch: 20,
            locationMatch: 10,
            salaryMatch: 10,
        },

        scoringBonuses: {
            nextjsAndTypescript: 8,
            nodeAndMongodb: 6,
            awsPresent: 4,
            fullMernStack: 10,
            remoteIndia: 5,
        },

        scoringPenalties: {
            nonJsStack: -15,
            frontendOnlyNoBackend: -5,
            differentPrimaryLanguage: -10,
        },

        /** Scoring engine v2 tuning parameters */
        scoring: {
            /** TF-IDF keyword-density blending weight (0–1). */
            tfidfWeight: 0.15,
            /** Points added when detected seniority aligns with user's experienceLevel. */
            experienceBonus: 5,
            /** Points deducted when detected seniority is HIGHER than user's experienceLevel. */
            seniorityPenalty: -8,
        },

        notificationThreshold: 40,

        filters: {
            workPreference: ["remote", "remote-first", "distributed", "work from home", "wfh", "anywhere"],
            locations: ["india", "europe", "worldwide", "global", "anywhere"],
            minSalaryUSD: 25000,
            minPrimaryMatches: 1,
        },

        locationKeywords: ["remote", "remote-first", "distributed", "work from home", "wfh", "anywhere"],
        regexKeywords: [],

        pollIntervalMs: 900000,
        timeWindowHours: 24,
        fuzzyThreshold: 0.75,
        maxConcurrentFeeds: 5,
        maxRetries: 3,

        // ── Self-Expanding Engine Configuration ────────────────────────────────
        searchExpansion: {
            enabled: true,
            queries: [
                // Core role queries
                'remote next.js developer jobs',
                'node.js backend engineer remote',
                'typescript fullstack developer remote',
                'react developer remote worldwide',
                'javascript engineer remote india',
                'mern stack developer remote jobs',
                'full stack developer remote hiring',
                // Company-focused discovery
                'startup hiring remote javascript engineer',
                'series A startup remote developer openings',
                'Y Combinator company hiring engineers remote',
                // Technology-niche queries
                'graphql api developer remote',
                'serverless node.js engineer jobs',
                'headless cms developer remote react',
                // Regional diversity
                'remote developer jobs europe node.js',
                'software engineer remote APAC typescript',
            ],
            maxSearchesPerCycle: 5,
            maxDomainsPerSearch: 15,
        },

        crawlIntelligence: {
            enabled: true,
            /** Run priority recalculation every N cron cycles */
            recalcIntervalCycles: 4,
            /** Run search expansion every N cron cycles (was 24, now ~2 hours) */
            searchIntervalCycles: 8,
            /** Run career page probing every N cron cycles (was 12, now ~1.5 hours) */
            careerProbeIntervalCycles: 6,
            /** Max domains to probe per career detection cycle */
            maxCareerProbes: 10,
        },

        dryRun: false,
    });
}
