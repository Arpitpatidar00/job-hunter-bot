<p align="center">
  <h1 align="center">🔍 Job Hunter Bot</h1>
  <p align="center">
    <strong>A Self-Expanding Job Discovery Engine Built on Cloudflare Workers</strong>
  </p>
  <p align="center">
    <em>Autonomous job intelligence that discovers sources, scores relevance, and delivers real-time alerts — running entirely on the free tier.</em>
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/database-D1%20SQLite-F38020?style=flat-square&logo=cloudflare" alt="D1">
  <img src="https://img.shields.io/badge/AI-Workers%20AI-F38020?style=flat-square&logo=cloudflare" alt="Workers AI">
  <img src="https://img.shields.io/badge/language-JavaScript-F7DF1E?style=flat-square&logo=javascript" alt="JavaScript">
  <img src="https://img.shields.io/badge/tests-325%20passing-brightgreen?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/license-ISC-blue?style=flat-square" alt="License">
</p>

---

## 🎯 What Is This?

**Job Hunter Bot** is not a traditional job scraper. It is a **self-expanding job discovery engine** — it starts with a handful of RSS feeds and ATS boards, then **autonomously discovers new job sources**, scores them by value, and optimizes its own crawling strategy over time.

Think of it as a job intelligence system that gets smarter and broader with every cycle.

### The Problem It Solves

| Traditional Job Bots | This Engine |
|---|---|
| Fixed list of sources | **Discovers new sources automatically** |
| Crawl everything equally | **Priority-based — high-value sources first** |
| Simple keyword matching | **Multi-layer scoring + AI semantic matching** |
| Alert spam | **Deduplication across sources + threshold tuning** |
| Expensive infrastructure | **Runs entirely on Cloudflare Free Tier** |
| Manual maintenance | **Self-healing — pauses dead sources, recovers from failures** |

---

## 🧠 How It Works — The 5-Layer Growth Model

The engine expands its internet coverage through 5 autonomous layers:

```
┌──────────────────────────────────────────────────────────────────┐
│                    🔎 LAYER 5: SEARCH EXPANSION                 │
│         DuckDuckGo niche queries → discover new companies       │
│                         (~70% niche coverage)                   │
├──────────────────────────────────────────────────────────────────┤
│                  🏗️ LAYER 4: CAREER PAGE DETECTION              │
│       Probe company domains → JSON-LD / HTML job extraction     │
│                         (~60% niche coverage)                   │
├──────────────────────────────────────────────────────────────────┤
│                  🔍 LAYER 3: AUTO ATS DISCOVERY                 │
│     Detect Greenhouse/Lever/Ashby/Workable URLs in job links    │
│                         (~40% niche coverage)                   │
├──────────────────────────────────────────────────────────────────┤
│                   🏢 LAYER 2: MANUAL ATS BOARDS                 │
│         Pre-configured ATS boards with structured APIs          │
│                         (~10% niche coverage)                   │
├──────────────────────────────────────────────────────────────────┤
│                     📡 LAYER 1: RSS BOOTSTRAP                   │
│              25 curated RSS feeds from job platforms             │
│                          (~5% niche coverage)                   │
└──────────────────────────────────────────────────────────────────┘
```

Each layer feeds into the next:
- **RSS feeds** yield job URLs → URLs analysed for **ATS patterns** → new ATS boards registered
- **ATS boards** yield company domains → domains probed for **career pages** → new sources registered
- **Search expansion** queries DuckDuckGo → discovers new companies → feeds into ATS detection + career probing
- **Intelligence layer** scores all sources → optimizes crawl frequency → drops dead weight

---

## 🏗️ Architecture

```
                    ┌─────────────────────┐
                    │    ⏰ Cron Trigger    │
                    │   (every 15 min)     │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   🧠 Intelligence    │
                    │   Source Selection   │
                    │  (priority-based)    │
                    └──────────┬──────────┘
                               │
              ┌────────────────▼────────────────┐
              │          📨 FEED_QUEUE           │
              │    (source configs to fetch)     │
              └────────────────┬────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │         🔄 FETCHER              │
              │  RSS │ Greenhouse │ Lever │      │
              │  Ashby │ Workable │ Career       │
              │  + ATS Discovery + Domain Queue  │
              └────────────────┬────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │          📨 JOB_QUEUE            │
              │     (normalized job objects)      │
              └────────────────┬────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │        📊 EVALUATOR             │
              │  Multi-layer scoring (0-100)     │
              │  + TF-IDF + AI semantic match    │
              │  + Feedback boosts               │
              └────────────────┬────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │          📨 ALERT_QUEUE          │
              │    (high-scoring job alerts)      │
              └────────────────┬────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │         🔔 SENDER               │
              │    Discord │ Telegram │ Email     │
              └─────────────────────────────────┘
```

### Event-Driven Queue Topology

The system uses **3 Cloudflare Queues** to decouple each stage:

| Queue | Purpose | Batch Size | Retries |
|-------|---------|------------|---------|
| `FEED_QUEUE` | Source configs → Fetcher | 10 | 1 |
| `JOB_QUEUE` | Raw jobs → Evaluator | 20 | 3 |
| `ALERT_QUEUE` | Scored jobs → Sender | 10 | 5 |

This ensures failures in one stage don't cascade to others, and retries happen automatically.

---

## 📊 Scoring Engine — Multi-Layer Job Evaluation

Every job goes through a **7-layer scoring pipeline** to produce a 0–100 relevance score:

| Layer | Weight | What It Measures |
|-------|--------|------------------|
| **Title Match** | 30% | Role alignment (fuzzy matching against 25 target roles) |
| **Skills Match** | 30% | Must-match, should-match, nice-to-have keyword detection |
| **Tech Stack** | 20% | Stack alignment bonuses (MERN +10, Next.js+TS +8) and penalties (non-JS -15) |
| **Location** | 10% | Remote/hybrid/on-site detection, geo-matching |
| **Salary** | 10% | USD salary extraction from free text |
| **TF-IDF** | Bonus | Rare skill terms boost (inverse document frequency) |
| **AI Semantic** | Bonus | Workers AI embedding cosine similarity |

### Scoring Features

- ✅ **Synonym resolution** — "ReactJS", "react.js", "React" all match
- ✅ **Fuzzy matching** — Handles typos and variations (threshold: 0.82)
- ✅ **Exclude list** — WordPress/PHP/Java jobs get score=0 instantly
- ✅ **Stack bonuses** — MERN stack detected = +10 points
- ✅ **Seniority detection** — Penalizes "10+ years" if targeting mid-level
- ✅ **Salary parsing** — Extracts USD from "$80k-$120k", "80,000 per year", etc.
- ✅ **Remote detection** — Detects "remote", "WFH", "distributed", "hybrid"
- ✅ **Feedback learning** — User thumbs-up/down adjusts future scoring

---

## 🧮 Intelligence Layer — Adaptive Crawling

Not all sources are equal. The engine scores every source and adjusts crawl frequency:

| Tier | Score Range | Crawl Frequency | Example |
|------|-------------|-----------------|---------|
| 🔴 **High** | 70–100 | Every 15 min | Active RSS feeds, busy Greenhouse boards |
| 🟡 **Medium** | 40–69 | ~1 hour | Stable ATS boards with weekly posts |
| 🔵 **Low** | 10–39 | ~3 hours | Career pages, infrequent posters |
| ⚫ **Dormant** | 0–9 | ~6 hours | Low-yield sources |

### Source Scoring Formula

```
Priority = (Yield × 0.30) + (Freshness × 0.25) + (Reliability × 0.25) + (Consistency × 0.10) + (Relevance × 0.10)
```

- **Yield** — How many new jobs per crawl
- **Freshness** — When was the last new job found
- **Reliability** — Success rate (successes / total attempts)
- **Consistency** — Regular posting patterns vs. sporadic
- **Relevance** — Percentage of jobs that pass the scoring threshold

### Self-Healing Behavior

- 🔄 Source fails 3 times → score drops, tier downgrades
- 🔄 Source fails 10 times → **auto-disabled**
- 🔄 Source recovers → score improves, tier upgrades
- 🔄 Source yields nothing for weeks → crawl frequency reduces automatically
- 🔄 Source starts posting again → frequency increases within 1-2 cycles

---

## 🔐 Deduplication System

The engine uses a **dual-key deduplication** strategy to prevent duplicate alerts:

| Level | Mechanism | Purpose |
|-------|-----------|---------|
| **URL-based** | D1 UNIQUE constraint on `url` | Prevents same URL from being processed twice |
| **Content-based** | SHA-inspired `content_hash` | Catches same job reposted with different URL |
| **Cross-platform** | Normalized `title::company` key | Detects same job on RSS + ATS + Career page |
| **Intra-batch** | In-memory `Set<content_hash>` | Prevents duplicates within a single fetch batch |
| **Alert-level** | `sent_alerts` table per profile | Ensures each user sees each job exactly once |

---

## 📁 Project Structure

```
job-hunter-bot/
├── src/
│   ├── worker.js                  # Cloudflare Worker entry point
│   ├── config.js                  # Configuration loader
│   ├── env.ts                     # Environment validation (Zod)
│   │
│   ├── core/                      # Core infrastructure
│   │   ├── logger.js              # Structured logging
│   │   ├── utils.js               # Retry, sanitize, rate-limit, parsing
│   │   ├── schema.js              # Job normalization + dedup keys
│   │   └── batcher.js             # Batch processing utilities
│   │
│   ├── connectors/                # Data source connectors
│   │   ├── index.js               # Connector registry & runner
│   │   ├── base.js                # Shared fetch, rate-limit, source builder
│   │   ├── rss.js                 # RSS/Atom feed parser
│   │   ├── greenhouse.js          # Greenhouse ATS API
│   │   ├── lever.js               # Lever ATS API
│   │   ├── ashby.js               # Ashby ATS API
│   │   ├── workable.js            # Workable ATS API
│   │   └── careerPage.js          # Career page JSON-LD + HTML extraction
│   │
│   ├── discovery/                 # Source expansion engine
│   │   ├── sourceDiscovery.js     # ATS URL pattern detection
│   │   ├── careerDetector.js      # Domain probing for career pages
│   │   └── searchExpander.js      # DuckDuckGo search-based expansion
│   │
│   ├── intelligence/              # Adaptive crawl orchestration
│   │   ├── sourceIntelligence.js  # Priority scoring & tier assignment
│   │   ├── feedHealth.js          # Circuit breaker / health tracking
│   │   └── threshold.js           # Dynamic notification threshold
│   │
│   ├── scoring/                   # Job relevance evaluation
│   │   ├── relevance.js           # 7-layer scoring engine
│   │   └── feedback.js            # User feedback preference learning
│   │
│   ├── db/                        # D1 data access layer
│   │   ├── index.js               # Barrel export
│   │   ├── jobs.js                # Job CRUD & cleanup
│   │   ├── sources.js             # Source registry & metrics
│   │   ├── profiles.js            # Multi-tenant profiles & alerts
│   │   └── terms.js               # TF-IDF term frequency tracking
│   │
│   ├── notifications/             # Alert delivery
│   │   ├── notifications.js       # Discord / Telegram / Email
│   │   ├── notificationQueue.js   # Queue batching helpers
│   │   └── ai.js                  # Workers AI embeddings
│   │
│   └── storage/                   # KV state management
│       ├── storage.js             # KV read/write wrappers
│       ├── runLock.js             # Cron execution lock
│       └── feeds.js               # Feed state tracking
│
├── tests/                         # 24 test suites, 325 tests
├── migrations/                    # D1 schema migrations (6 versions)
├── config.json                    # Scoring rules, feeds, thresholds
├── wrangler.jsonc                 # Cloudflare Worker config
└── package.json
```

---

## ☁️ Cloudflare Free Tier Optimization

The entire system is designed to run on Cloudflare's **free plan**:

| Resource | Free Tier Limit | How We Stay Under |
|----------|----------------|-------------------|
| **Workers** | 100k req/day | Priority crawling reduces requests by 60-80% |
| **D1 Database** | 5M rows read/day | Dedup prevents unnecessary writes; stale cleanup |
| **KV Storage** | 100k reads/day | Cycle counter + seen jobs cache |
| **Queues** | 1M messages/month | Batched dispatching, smart source selection |
| **Workers AI** | 10k neurons/day | Only applied after structured score passes threshold |
| **CPU Time** | 10ms/invocation | 200 jobs scored in <200ms |

### Resource Optimization Strategies

1. **Priority-based crawling** — Only high-value sources crawled every 15 min
2. **Circuit breaker** — Failing sources paused automatically (60-min cooldown)
3. **Intra-batch dedup** — Prevents redundant D1 writes within a fetch cycle
4. **Stale job cleanup** — Auto-deletes jobs >30 days old to prevent table bloat
5. **Rate-limited discovery** — Max 3 searches + 5 career probes per cycle
6. **Freshness filter** — Jobs older than 24h skipped before AI scoring

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Cloudflare Account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) v4+

### 1. Clone & Install

```bash
git clone https://github.com/your-username/job-hunter-bot.git
cd job-hunter-bot
npm install
```

### 2. Create Cloudflare Resources

```bash
# Login to Cloudflare
npx wrangler login

# Create D1 Database
npx wrangler d1 create job-hunter-db

# Create KV Namespace
npx wrangler kv namespace create SEEN_JOBS

# Create Queues
npx wrangler queues create feed-queue
npx wrangler queues create job-queue
npx wrangler queues create alert-queue
```

Update `wrangler.jsonc` with the IDs returned by these commands.

### 3. Apply Database Migrations

```bash
# Local development
npx wrangler d1 migrations apply job-hunter-db --local

# Production
npx wrangler d1 migrations apply job-hunter-db
```

### 4. Configure

Edit `config.json` to customize:

```jsonc
{
  "feeds": [/* your RSS feed URLs */],
  "searchRules": {
    "mustMatch": ["your", "core", "skills"],
    "shouldMatch": ["bonus", "skills"],
    "exclude": ["unwanted", "frameworks"]
  },
  "targetRoles": ["your target job titles"],
  "notificationThreshold": 50,  // 0-100, higher = more selective
  "filters": {
    "workPreference": ["remote"],
    "locations": ["your", "preferred", "locations"],
    "minSalaryUSD": 25000
  }
}
```

### 5. Set Secrets

```bash
# Discord Webhook (recommended)
npx wrangler secret put DISCORD_WEBHOOK_URL

# Telegram Bot (optional)
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

### 6. Run

```bash
# Local development
npm run dev

# Deploy to production
npm run deploy

# Run tests
npm test
```

---

## 📈 Growth Trajectory

The engine's source coverage expands autonomously over time:

| Timeline | Sources | Coverage | What Happens |
|----------|---------|----------|--------------|
| **Day 1** | 25-45 | ~5% | RSS feeds + manual ATS boards bootstrap |
| **Week 1** | 50-100 | ~15% | Auto ATS discovery kicks in from job URLs |
| **Month 1** | 100-200 | ~30% | Career page detection starts probing domains |
| **Month 2** | 200-400 | ~50% | Search expansion discovers new companies |
| **Month 3+** | 500+ | ~70% | Self-sustaining growth loop stabilizes |

> **Important**: "Coverage" refers to niche-specific coverage (e.g., remote JS/TS roles), not the entire internet. The engine optimizes for depth within your defined niche, not breadth across all jobs.

---

## 🧪 Testing

The project includes **325 tests across 24 test suites** covering:

| Category | Tests | Coverage |
|----------|-------|----------|
| Scoring engine | 60+ | All 7 scoring layers, bonuses, penalties |
| Connectors | 40+ | RSS, Greenhouse, Lever, Ashby, Workable |
| Deduplication | 20+ | URL, content hash, cross-platform, intra-batch |
| Source discovery | 25+ | ATS detection, false positives, edge cases |
| Intelligence | 20+ | Priority scoring, tier assignment, cycling |
| Career detection | 15+ | JSON-LD extraction, HTML parsing |
| Search expansion | 15+ | Domain extraction, aggregator filtering |
| Edge cases | 40+ | Empty inputs, Unicode, long content, perf |
| E2E pipeline | 30+ | Happy path, irrelevant jobs, stale jobs, AI boost |
| Free tier safety | 10+ | CPU benchmarks, write reduction |

```bash
npm test                    # Run all tests
npm run test:watch          # Watch mode
```

---

## 🔧 Configuration Reference

### Scoring Weights

| Weight | Default | Description |
|--------|---------|-------------|
| `titleMatch` | 30 | How much job title matters |
| `skillsMatch` | 30 | Must-match keyword importance |
| `techStackMatch` | 20 | Stack alignment bonuses/penalties |
| `locationMatch` | 10 | Remote/location preference |
| `salaryMatch` | 10 | Salary threshold matching |

### Scoring Bonuses & Penalties

| Rule | Points | Trigger |
|------|--------|---------|
| Full MERN Stack | +10 | All of: MongoDB, Express, React, Node.js |
| Next.js + TypeScript | +8 | Both present |
| Node.js + MongoDB | +6 | Both present |
| AWS Present | +4 | AWS/Amazon Web Services mentioned |
| Remote + India | +5 | Both remote and India-friendly |
| Non-JS Stack | -15 | Primary language is not JavaScript/TypeScript |
| Frontend Only | -5 | React but no backend skills |
| Different Language | -10 | Java/Python/Ruby as primary language |

### Intelligence Cycle Intervals

| Task | Interval | Default |
|------|----------|---------|
| Priority recalculation | Every N cycles | 4 (1 hour) |
| Career page probing | Every N cycles | 12 (3 hours) |
| Search expansion | Every N cycles | 24 (6 hours) |
| Stale job cleanup | Every cycle | 30 days cutoff |

---

## 🛣️ API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | System health + secret validation |
| `/metrics` | GET | Source metrics, job counts, processing stats |
| `/trigger` | POST | Manually trigger a full crawl cycle |

---

## 🔮 Full Potential & Vision

This engine is designed to scale into a **complete job intelligence platform**:

### Current Capabilities
- ✅ Self-expanding multi-source job discovery
- ✅ 7-layer AI-enhanced scoring with semantic matching
- ✅ Priority-based adaptive crawling
- ✅ Multi-tenant profile support
- ✅ Cross-platform deduplication
- ✅ Circuit breaker self-healing
- ✅ Dynamic threshold tuning
- ✅ User feedback learning loop
- ✅ Real-time Discord/Telegram alerts
- ✅ 325 tests with comprehensive edge case coverage

### Future Potential

| Capability | Description |
|------------|-------------|
| **Resume Matching** | Upload resume → auto-generate scoring profile |
| **Company Intelligence** | Track companies across sources → build employer database |
| **Salary Analytics** | Aggregate salary data by role, location, stack |
| **Market Trends** | Track which skills are trending up/down over time |
| **Multi-User SaaS** | Each user gets their own scoring profile + alerts |
| **Browser Extension** | Score any job page in real-time |
| **LinkedIn Integration** | Auto-apply to high-scoring jobs |
| **Interview Prep** | AI-generated interview questions based on job description |
| **Competitor Analysis** | Track what competitors are hiring for |
| **Team Hiring** | Companies use it to find where competitors post jobs |

### Why This Architecture Enables It

1. **Event-driven queues** — Every stage is independently scalable
2. **Multi-tenant profiles** — Already supports multiple users with different preferences
3. **D1 relational database** — Rich querying, analytics, trend tracking
4. **Workers AI** — Semantic understanding built-in, expandable to summarization
5. **Priority system** — Resource usage stays constant even as sources grow 10x
6. **Modular codebase** — Each domain (`scoring/`, `discovery/`, `intelligence/`) is independently extendable

---

## 📝 License

ISC License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <strong>Built with ❤️ for developers who want their job search to work as hard as they do.</strong>
</p>
