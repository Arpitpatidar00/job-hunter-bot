/**
 * @module config
 * @description Bot configuration — hardcoded for Cloudflare Workers (no filesystem access).
 * Previously loaded from config.json + CLI args; now exported as a frozen object.
 */

/**
 * Bot configuration (v3.2) — Cloudflare Workers.
 * Secrets (webhook URLs, tokens) come from the `env` binding at runtime.
 * @returns {Readonly<object>} Frozen, validated config object.
 */
export function loadConfig() {
  return Object.freeze({
    version: "3.2.0",
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

    // ── Multi-source ATS platforms ────────────────────────────────────────
    sources: [
      // ── Greenhouse (public JSON API) ──────────────────────────────────
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/hashicorp/jobs",
        name: "HashiCorp",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/discord/jobs",
        name: "Discord",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/figma/jobs",
        name: "Figma",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/cloudflare/jobs",
        name: "Cloudflare",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/netlify/jobs",
        name: "Netlify",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/vercel/jobs",
        name: "Vercel",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/supabase/jobs",
        name: "Supabase",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/linear/jobs",
        name: "Linear",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/notion/jobs",
        name: "Notion",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/datadog/jobs",
        name: "Datadog",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/daboraio/jobs",
        name: "dbt Labs",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/grafanalabs/jobs",
        name: "Grafana Labs",
        enabled: true,
      },
      // New Greenhouse companies (remote-friendly tech)
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/brex/jobs",
        name: "Brex",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/plaid/jobs",
        name: "Plaid",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/retool/jobs",
        name: "Retool",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/scale/jobs",
        name: "Scale AI",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/census/jobs",
        name: "Census",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/dbtlabs/jobs",
        name: "dbt Labs v2",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/vercel/jobs",
        name: "Vercel v2",
        enabled: false,
      }, // already above, skip
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/loom/jobs",
        name: "Loom",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/segment/jobs",
        name: "Segment",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/mixpanel/jobs",
        name: "Mixpanel",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/amplitude/jobs",
        name: "Amplitude",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/postman/jobs",
        name: "Postman",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/mongodb/jobs",
        name: "MongoDB",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/cockroachlabs/jobs",
        name: "CockroachDB",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/prismatic/jobs",
        name: "Prismatic",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/render/jobs",
        name: "Render",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/railway/jobs",
        name: "Railway",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/hasura/jobs",
        name: "Hasura",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/neon/jobs",
        name: "Neon DB",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/planetscale/jobs",
        name: "PlanetScale",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/convex/jobs",
        name: "Convex",
        enabled: true,
      },
      {
        type: "greenhouse",
        url: "https://boards-api.greenhouse.io/v1/boards/upstash/jobs",
        name: "Upstash",
        enabled: true,
      },

      // ── Lever (public JSON API) ──────────────────────────────────────
      {
        type: "lever",
        url: "https://api.lever.co/v0/postings/stripe",
        name: "Stripe",
        enabled: true,
      },
      {
        type: "lever",
        url: "https://api.lever.co/v0/postings/twitch",
        name: "Twitch",
        enabled: true,
      },
      {
        type: "lever",
        url: "https://api.lever.co/v0/postings/netlify",
        name: "Netlify (Lever)",
        enabled: true,
      },
      // New Lever companies
      {
        type: "lever",
        url: "https://api.lever.co/v0/postings/remote",
        name: "Remote.com",
        enabled: false,
      }, // 404
      {
        type: "lever",
        url: "https://api.lever.co/v0/postings/deel",
        name: "Deel",
        enabled: true,
      },
      {
        type: "lever",
        url: "https://api.lever.co/v0/postings/mercury",
        name: "Mercury",
        enabled: true,
      },
      {
        type: "lever",
        url: "https://api.lever.co/v0/postings/gusto",
        name: "Gusto",
        enabled: true,
      },
      {
        type: "lever",
        url: "https://api.lever.co/v0/postings/webflow",
        name: "Webflow",
        enabled: true,
      },
      {
        type: "lever",
        url: "https://api.lever.co/v0/postings/vercel",
        name: "Vercel (Lever)",
        enabled: true,
      },
      {
        type: "lever",
        url: "https://api.lever.co/v0/postings/lottiefiles",
        name: "LottieFiles",
        enabled: true,
      },
      {
        type: "lever",
        url: "https://api.lever.co/v0/postings/ditto",
        name: "Ditto",
        enabled: true,
      },
      {
        type: "lever",
        url: "https://api.lever.co/v0/postings/stytch",
        name: "Stytch",
        enabled: true,
      },
      {
        type: "lever",
        url: "https://api.lever.co/v0/postings/mintlify",
        name: "Mintlify",
        enabled: true,
      },

      // ── Ashby (public posting API — no key needed for public boards) ──
      {
        type: "ashby",
        url: "https://api.ashbyhq.com/posting-api/job-board/notion",
        name: "Notion (Ashby)",
        enabled: true,
      },
      {
        type: "ashby",
        url: "https://api.ashbyhq.com/posting-api/job-board/linear",
        name: "Linear (Ashby)",
        enabled: true,
      },
      {
        type: "ashby",
        url: "https://api.ashbyhq.com/posting-api/job-board/ramp",
        name: "Ramp",
        enabled: true,
      },
      // New Ashby companies
      {
        type: "ashby",
        url: "https://api.ashbyhq.com/posting-api/job-board/liveblocks",
        name: "Liveblocks",
        enabled: true,
      },
      {
        type: "ashby",
        url: "https://api.ashbyhq.com/posting-api/job-board/resend",
        name: "Resend",
        enabled: true,
      },
      {
        type: "ashby",
        url: "https://api.ashbyhq.com/posting-api/job-board/val-town",
        name: "Val Town",
        enabled: true,
      },
      {
        type: "ashby",
        url: "https://api.ashbyhq.com/posting-api/job-board/trigger",
        name: "Trigger.dev",
        enabled: true,
      },
      {
        type: "ashby",
        url: "https://api.ashbyhq.com/posting-api/job-board/inngest",
        name: "Inngest",
        enabled: true,
      },
      {
        type: "ashby",
        url: "https://api.ashbyhq.com/posting-api/job-board/raycast",
        name: "Raycast",
        enabled: true,
      },
      {
        type: "ashby",
        url: "https://api.ashbyhq.com/posting-api/job-board/fey",
        name: "Fey",
        enabled: true,
      },
      {
        type: "ashby",
        url: "https://api.ashbyhq.com/posting-api/job-board/sequence",
        name: "Sequence",
        enabled: true,
      },

      // ── Workable (public jobs API) ────────────────────────────────────
      {
        type: "workable",
        url: "https://apply.workable.com/api/v3/accounts/pricehubble/jobs",
        name: "PriceHubble",
        enabled: true,
      },
      {
        type: "workable",
        url: "https://apply.workable.com/api/v3/accounts/toggl/jobs",
        name: "Toggl",
        enabled: true,
      },
      // New Workable companies
      {
        type: "workable",
        url: "https://apply.workable.com/api/v3/accounts/superside/jobs",
        name: "Superside",
        enabled: true,
      },
      {
        type: "workable",
        url: "https://apply.workable.com/api/v3/accounts/coda/jobs",
        name: "Coda",
        enabled: true,
      },
      {
        type: "workable",
        url: "https://apply.workable.com/api/v3/accounts/lemon-io/jobs",
        name: "Lemon.io",
        enabled: true,
      },
      {
        type: "workable",
        url: "https://apply.workable.com/api/v3/accounts/whereby/jobs",
        name: "Whereby",
        enabled: true,
      },
    ],

    searchRules: {
      mustMatch: ["javascript", "typescript", "react", "next.js", "node.js"],
      shouldMatch: [
        "mongodb",
        "postgresql",
        "express",
        "graphql",
        "rest api",
        "aws",
        "docker",
        "tailwindcss",
        "prisma",
        "nestjs",
      ],
      niceToHave: [
        "redis",
        "ci/cd",
        "microservices",
        "system design",
        "nx monorepo",
        "kubernetes",
        "terraform",
        "github actions",
        "jest",
        "cypress",
      ],
      exclude: [
        "wordpress",
        "php",
        "laravel",
        "drupal",
        "dotnet",
        ".net",
        "c#",
        "swift developer",
        "android native",
        "kotlin developer",
        "flutter",
        "java developer",
        "spring boot",
        "ruby on rails",
        "django",
        "unpaid internship",
      ],
    },

    targetRoles: [
      "full stack developer",
      "full stack engineer",
      "fullstack developer",
      "fullstack engineer",
      "mern stack developer",
      "mern stack engineer",
      "next.js developer",
      "next.js engineer",
      "frontend engineer",
      "frontend developer",
      "frontend react developer",
      "backend engineer",
      "backend developer",
      "backend engineer node.js",
      "software engineer",
      "software developer",
      "web developer",
      "web engineer",
      "javascript developer",
      "javascript engineer",
      "typescript developer",
      "react developer",
      "react engineer",
      "node.js developer",
      "node.js engineer",
    ],

    experienceLevel: [
      "entry level",
      "junior",
      "associate",
      "mid-level",
      "mid",
      "sde 1",
      "sde 2",
      "1+ years",
      "2+ years",
      "3+ years",
      "4+ years",
    ],

    synonyms: {
      react: ["reactjs", "react.js", "react js"],
      "next.js": ["nextjs", "next js", "next.js", "next"],
      "node.js": ["nodejs", "node js", "node.js", "node"],
      typescript: ["ts", "typescript"],
      javascript: ["js", "ecmascript", "es6", "es2015", "es2020", "es2022"],
      mongodb: ["mongo", "mongoose", "mongodb atlas"],
      postgresql: ["postgres", "psql", "pg"],
      express: ["expressjs", "express.js"],
      graphql: ["graph ql", "apollo graphql", "apollo"],
      aws: ["amazon web services", "amazon cloud"],
      docker: ["containerization", "containers"],
      tailwindcss: ["tailwind", "tailwind css"],
      nestjs: ["nest.js", "nest js"],
      redis: ["redis cache", "elasticache"],
      prisma: ["prisma orm"],
      "rest api": ["restful", "rest", "restful api"],
      // MERN synonym group — fixes 0% relevance for fullstack roles
      mern: [
        "mern stack",
        "mean stack",
        "fullstack js",
        "full stack js",
        "full-stack javascript",
      ],
      fullstack: [
        "full stack",
        "full-stack",
        "fullstack developer",
        "full stack developer",
      ],
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
      workPreference: [
        "remote",
        "remote-first",
        "distributed",
        "work from home",
        "wfh",
        "anywhere",
      ],
      locations: ["india", "europe", "worldwide", "global", "anywhere"],
      minSalaryUSD: 25000,
      minPrimaryMatches: 1,
    },

    locationKeywords: [
      "remote",
      "remote-first",
      "distributed",
      "work from home",
      "wfh",
      "anywhere",
    ],
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
        // --- ATS board discovery (directly targets Greenhouse/Lever/Ashby URLs) ---
        // These surface actual ATS board URLs that sourceDiscovery.js can pattern-match
        "site:boards.greenhouse.io javascript developer remote",
        "site:boards.greenhouse.io react engineer remote hiring",
        "site:boards.greenhouse.io typescript fullstack remote",
        "site:jobs.lever.co javascript engineer remote",
        "site:jobs.lever.co node.js backend remote",
        "site:jobs.ashbyhq.com react developer remote",
        "site:jobs.ashbyhq.com fullstack javascript",
        "site:apply.workable.com remote javascript developer",

        // --- Company career page discovery ---
        // Surfaces company-owned career pages for careerDetector.js
        "remote javascript developer careers site:greenhouse.io OR site:lever.co",
        '"we are hiring" remote react developer site:.co OR site:.io',
        'remote next.js developer "apply now" startup',
        "series A startup hiring remote fullstack javascript engineer 2025",
        "Y Combinator company hiring remote node.js engineer",
        "remote-first company javascript typescript engineer openings",
        '"join our team" remote react node developer',
      ],
      maxSearchesPerCycle: 5,
      maxDomainsPerSearch: 15,
    },

    crawlIntelligence: {
      enabled: true,
      /** Run priority recalculation every N cron cycles */
      recalcIntervalCycles: 4,
      /** Run search expansion every N cron cycles — every ~1 hour (was 8 = ~2 hours) */
      searchIntervalCycles: 4,
      /** Run career page probing every N cron cycles — every ~1 hour (was 6 = ~1.5 hours) */
      careerProbeIntervalCycles: 4,
      /** Max domains to probe per career detection cycle (was 10) */
      maxCareerProbes: 20,
    },

    dryRun: false,
  });
}
