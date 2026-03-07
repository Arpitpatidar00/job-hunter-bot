<p align="center">
  <h1 align="center">🔍 Job Hunter Bot</h1>
  <p align="center">
    <strong>Self-Expanding, Event-Driven Job Intelligence Engine</strong>
  </p>
  <p align="center">
    <em>Autonomous source discovery · BM25 TF-IDF scoring · Semantic AI validation · Runs entirely on Cloudflare's edge.</em>
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/database-D1%20SQLite-F38020?style=flat-square&logo=cloudflare" alt="D1">
  <img src="https://img.shields.io/badge/AI-Workers%20AI-F38020?style=flat-square&logo=cloudflare" alt="Workers AI">
  <img src="https://img.shields.io/badge/version-v3.1.0-blue?style=flat-square" alt="v3.1.0">
  <img src="https://img.shields.io/badge/language-JavaScript%20ESM-F7DF1E?style=flat-square&logo=javascript" alt="JavaScript">
  <img src="https://img.shields.io/badge/tests-80+%20assertions-brightgreen?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/license-ISC-blue?style=flat-square" alt="License">
</p>

---

## Project Strengths & Value Proposition

| Strength                      | Implementation Detail                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Stateful Serverless**       | Uses D1 (SQLite), KV, and Queues to build a long-running, stateful agent on an ephemeral V8 isolate runtime.                           |
| **Zero Dependencies**         | Only runtime dependency is `zod` for env validation. No Express, no Axios, no ORMs — pure `fetch()` + D1 SQL.                          |
| **Event-Driven Backpressure** | 3 Cloudflare Queues decouple fetch → evaluate → alert phases. Each queue has independent retry policies and batch sizes.               |
| **Self-Expanding Coverage**   | Starts with 71 hardcoded sources; autonomously discovers new ATS boards, career pages, and company domains via DuckDuckGo HTML search. |
| **Strict Deduplication**      | 5-layer dedup (URL UNIQUE, `content_hash` UNIQUE, `similarity_hash` clustering, intra-batch `Set`, per-profile `sent_alerts` table).   |
| **Circuit Breaker Pattern**   | Per-feed health tracking in KV with exponential backoff (5min→1hr), configurable `OPEN_THRESHOLD=10` consecutive failures.             |
| **Adaptive Threshold**        | Rolling window of 200 scores in KV auto-adjusts the notification threshold (±2 steps) to maintain 1–8 alerts per cron cycle.           |
| **Feedback Learning Loop**    | User interactions (clicked/saved/ignored) update KV-backed preference weights that adjust future scores by ±5 points.                  |

---

## Tech Stack & Architecture Rationale

| Component             | Technology                               | Why This Choice                                                                                                                   |
| --------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime**           | Cloudflare Workers (V8 Isolates)         | Sub-millisecond cold starts; 0ms idle cost; runs at edge PoPs globally.                                                           |
| **Relational State**  | Cloudflare D1 (SQLite)                   | ACID transactions for dedup; `INSERT OR IGNORE` atomicity; schema migrations via `wrangler d1 migrations`.                        |
| **Event Bus**         | Cloudflare Queues                        | At-least-once delivery; automatic retries (2/3/5 per queue); prevents subrequest exhaustion by spreading work across invocations. |
| **Cache & Cooldowns** | Cloudflare KV                            | Expiration TTLs for circuit breakers (`expirationTtl`); nanosecond reads for cycle counters and threshold windows.                |
| **Semantic Layer**    | Workers AI (`@cf/baai/bge-base-en-v1.5`) | 768-dimensional embeddings; computed on-edge; no external API keys; cosine similarity for role matching.                          |
| **Validation**        | Zod (runtime)                            | Schema validation for `env` bindings — catches misconfigured secrets before first fetch.                                          |
| **Testing**           | Jest + `--experimental-vm-modules`       | ESM import support for testing edge-native modules without transpilation.                                                         |

---

## Deep Technical Flow

### System Topology

```
                    ┌─────────────────────┐
                    │    ⏰ Cron Trigger    │
                    │  0,15,30,45 * * * *  │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  _scheduledImpl()    │
                    │  ├─ buildSourceList()│
                    │  ├─ getSourcesFor    │
                    │  │   Cycle()         │
                    │  ├─ recalculate      │
                    │  │   Priorities()    │
                    │  ├─ probeDomainsFor  │
                    │  │   Careers()       │
                    │  └─ runSearch        │
                    │      Expansion()     │
                    └──────────┬──────────┘
                               │
              ┌────────────────▼────────────────┐
              │          FEED_QUEUE              │
              │  (source configs, batch=5, r=2)  │
              └────────────────┬────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │       processFeeds()            │
              │  ├─ isFeedCircuitOpen()         │
              │  ├─ runAllConnectors()          │
              │  │   ├─ fetchRssFeeds()         │
              │  │   ├─ fetchGreenhouseJobs()   │
              │  │   ├─ fetchLeverJobs()        │
              │  │   ├─ fetchAshbyJobs()        │
              │  │   ├─ fetchWorkableJobs()     │
              │  │   └─ fetchCareerPageJobs()   │
              │  ├─ normalizeJob() + slimJob()  │
              │  ├─ batchInsertJobs()           │
              │  ├─ detectAtsSourcesWithDomains()│
              │  └─ recordFeedResult()          │
              └────────────────┬────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │          JOB_QUEUE               │
              │  (slimmed jobs, batch=5, r=3)    │
              └────────────────┬────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │       evaluateJobs()            │
              │  ├─ resetAiCallCount()          │
              │  ├─ getActiveProfiles()         │
              │  ├─ getPreferenceWeights()      │
              │  ├─ getEffectiveThreshold()     │
              │  ├─ generateEmbedding(profile)  │
              │  ├─ getGlobalTermFrequencies()  │
              │  ├─ for each job:               │
              │  │   ├─ isNewJob()              │
              │  │   ├─ generateEmbedding(job)  │
              │  │   ├─ scoreJob()              │
              │  │   ├─ applyFeedbackBoost()    │
              │  │   ├─ recordJobScore()        │
              │  │   └─ hasSentAlert() guard     │
              │  └─ threshold auto-adjust       │
              └────────────────┬────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │         ALERT_QUEUE              │
              │  (scored jobs, batch=5, r=5)     │
              └────────────────┬────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │        sendAlerts()             │
              │  ├─ hasSentAlert() verify        │
              │  ├─ sendAlert()                 │
              │  │   ├─ buildDiscordEmbed()     │
              │  │   └─ buildTelegramMessage()  │
              │  └─ markAlertSent()             │
              └─────────────────────────────────┘
```

### Worker Export Surface

The `src/worker.js` module exports three handlers to Cloudflare:

| Handler                      | Trigger                   | Function                                                                             |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `fetch(request, env, ctx)`   | HTTP requests             | Routes `/health`, `/metrics`, `/report`, `/trigger`                                  |
| `scheduled(event, env, ctx)` | Cron `0,15,30,45 * * * *` | Calls `_scheduledImpl()` wrapped in global try-catch                                 |
| `queue(batch, env, ctx)`     | Queue messages            | Routes via `queueHandler()` to `processFeeds()`, `evaluateJobs()`, or `sendAlerts()` |

### Direct Fallback Mechanism

When Cloudflare Queue rate limits are hit (`429 Too Many Requests`), the system degrades gracefully:

1. `withRetry(fn, maxRetries=3, baseDelayMs=500)` attempts exponential backoff with jitter
2. If all retries fail, `_scheduledImpl()` switches to **direct inline processing**
3. A `WALL_TIME_LIMIT_MS = 25_000` guard prevents exceeding the 30s Worker timeout
4. Sources are processed in batches of 5, deferring remaining to the next cron cycle

---

## The "Real" Process: Step-by-Step Core Execution

### Phase 1: Orchestration (`_scheduledImpl`)

```
1. loadConfig()                     → Frozen config object (v3.2.0)
2. getAndIncrementCycle(kv)         → Monotonic cycle counter from KV
3. buildSourceList(config)          → Merge config.feeds[] (25 RSS) + config.sources[] (46 ATS)
4. getEnabledSources(env.DB)       → D1 registry sources (auto-discovered)
5. getSourcesForCycle(db, cycle)    → Priority-filtered sources for this cycle
6. FEED_QUEUE.sendBatch(sources)    → Dispatch in chunks of 100 with withRetry()
```

**Periodic Tasks** (cycle-modulo gated):

| Task             | Condition                         | Function Called                                         |
| ---------------- | --------------------------------- | ------------------------------------------------------- |
| Priority recalc  | `cycle % 4 === 0`                 | `recalculatePriorities(db)`                             |
| Career probing   | `cycle % 4 === 0`                 | `probeDomainsForCareers(db, domains, 20)`               |
| Search expansion | `cycle % 4 === 0`                 | `runSearchExpansion(db, queries, knownUrls, kv, 8, 20)` |
| Stale cleanup    | Every cycle                       | `cleanupStaleJobs(db, 30)`                              |
| Daily report     | `hourUTC === 0 && minuteUTC < 15` | `sendDailyReport(db, env, {reportDate: yesterday})`     |

### Phase 2: Ingestion (`processFeeds`)

For each source config from `FEED_QUEUE`:

```
1. isFeedCircuitOpen(kv, source.url) → Skip if circuit breaker is active
2. CONNECTOR_MAP[source.type]()      → Route to type-specific connector
3. normalizeJob(raw, sourceMeta)     → Canonical RawJob with content_hash + similarity_hash
4. slimJob(job)                      → Strip contentSnippet/description/body for queue payload
5. batchInsertJobs(db, jobs)         → INSERT OR IGNORE in D1 chunks of 40
6. detectAtsSourcesWithDomains()     → Scan job URLs for 14 ATS hostname patterns
7. registerDomain(db, domain)        → Queue company domains for career probing
8. recordFeedResult(kv, url, result) → Update health record; open circuit if ≥10 failures
9. JOB_QUEUE.sendBatch(slimmedJobs)  → Forward to evaluator with withRetry()
```

### Phase 3: Evaluation (`evaluateJobs`)

```
1. resetAiCallCount()                → Reset 40-call subrequest budget
2. getActiveProfiles(db)             → Load multi-tenant profiles from D1
3. getPreferenceWeights(kv)          → Load feedback-learned weights from KV
4. getEffectiveThreshold(kv, base)   → Get auto-adjusted threshold (30–70 range)
5. generateEmbedding(ai, profileSpec)→ One-time profile vector (768-dim)
6. getGlobalTermFrequencies(db)      → Pre-fetch IDF data (1 D1 call for all terms)

For each job in batch:
  7. isNewJob(job, 24h)              → Freshness gate
  8. generateEmbedding(ai, jobText)  → Job vector (budget-gated)
  9. cosineSimilarity(jobVec, profVec)→ Semantic similarity score
  10. scoreJob(job, config, idf, sim) → 10-layer scoring pipeline → 0–100
  11. applyFeedbackBoost(result, wts) → ±5 point feedback adjustment
  12. Math.max(threshold, 50)         → MINIMUM_ALERT_SCORE floor enforced
  13. hasSentAlert(db, jobId, profId) → D1 dedup check
  14. ALERT_QUEUE.send({job, score})   → Forward with withRetry()
  15. markAlertSent(db, jobId, profId) → Record in sent_alerts table
```

### Phase 4: Delivery (`sendAlerts`)

```
1. hasSentAlert(db, jobId, profId)   → Final dedup verification
2. sendAlert(job, scoreResult, opts) → Build and dispatch:
   ├── buildDiscordEmbed(job, score) → Rich embed with breakdown fields
   └── buildTelegramMessage(job, s)  → MarkdownV2 formatted message
3. markAlertSent(db, jobId, profId)  → Persist delivery record
```

---

## Scoring Engine v3 — `src/scoring/relevance.js` (791 LOC)

### 10-Layer Pipeline

| #   | Layer                  | Weight/Effect         | Implementation Detail                                                                                                                           |
| --- | ---------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Input Sanitization** | Pre-processing        | `sanitizeText()` — lowercase, strip HTML, normalize unicode                                                                                     |
| 2   | **Exclusion Guard**    | Hard stop → `score=0` | Word-boundary regex against `exclude[]` list (WordPress, PHP, Laravel, etc.)                                                                    |
| 3   | **Title Matching**     | 30% of total          | Graduated: 1 hit = 60%, 2 hits = 80%, 3+ hits = 100% of `weights.titleMatch`. Uses `expandWithSynonyms()` + `\\b` regex.                        |
| 4   | **Skills Matching**    | 30% of total          | Iterates `mustMatch[]` + `shouldMatch[]` + `niceToHave[]` via `keywordMatchesText()`. **Hard Gate**: zero must-match hits → score capped at 45. |
| 5   | **Location Matching**  | 10% of total          | `detectRemoteType()` → remote/hybrid/onsite. Word-boundary regex from `REGION_BONUS_REGEX` in `skills.js`.                                      |
| 6   | **Salary Analysis**    | 10% of total          | `extractSalaryUSD()` — parses "$80k", "80,000/yr", "₹15 LPA". Discards values < $10,000.                                                        |
| 7   | **TF-IDF Signal**      | Bonus (0–15%)         | `computeTfIdfScore()` — exact token equality, BM25 IDF smoothing `log((N+1)/(df+1))`, sum of TF×IDF (not mean).                                 |
| 8   | **Experience Scoring** | ±5 points             | `scoreExperience()` + `detectSeniority()` — scans full text (not first 500 chars). Uses `SENIORITY_REGEX` from `skills.js`.                     |
| 9   | **Stack Combos**       | +4 to +10             | Full MERN (+10), Next.js+TS (+8), Node+MongoDB (+6), AWS (+4), Remote+India (+5).                                                               |
| 10  | **Penalties**          | -5 to -15             | Non-JS stack in title OR body (-15, uses `NON_JS_STACKS`). Frontend-only with no backend signals and no must-match (-5).                        |

**Post-Pipeline**: `MINIMUM_ALERT_SCORE = 50` — jobs below this are never alerted regardless of profile threshold.

### Centralized Dictionary — `src/scoring/skills.js`

All regex patterns and static keyword lists are extracted into `skills.js`:

```javascript
SCORE_LABELS; // [{min: 88, label: 'Excellent Match', color: '🟢'}, ...]
SENIORITY_REGEX; // {lead: /.../, senior: /.../, mid: /.../, junior: /.../}
SENIORITY_PREF_REGEX; // {junior: /.../, mid: /.../}
REGION_BONUS_REGEX; // /\b(india|worldwide|global|anywhere|asia|remote)\b/i
NON_JS_STACKS; // ['python', 'ruby', 'golang', 'rust', ...]
FRONTEND_KEYWORDS; // ['frontend', 'front-end', 'css only', ...]
BACKEND_KEYWORDS; // ['backend', 'back-end', 'node', 'express', ...]
FRONTEND_TITLE_REGEX; // /\b(frontend|front-end)\b/i
```

---

## 5-Layer Source Discovery

### Layer Model

```
┌──────────────────────────────────────────────────────────────────┐
│                    🔎 LAYER 5: SEARCH EXPANSION                  │
│    runSearchExpansion() → DuckDuckGo HTML → 17 niche queries     │
│    DDG_FAILURE_THRESHOLD=5, cooldown=10min                       │
├──────────────────────────────────────────────────────────────────┤
│                  🏗️ LAYER 4: CAREER PAGE DETECTION               │
│    probeDomainsForCareers() → 16 path patterns → JSON-LD check  │
│    maxProbes=20/cycle, rateLimitDomain(3s)                       │
├──────────────────────────────────────────────────────────────────┤
│                  🔍 LAYER 3: AUTO ATS DISCOVERY                  │
│    detectAtsSourcesWithDomains() → 14 ATS hostname patterns      │
│    Greenhouse│Lever│Ashby│Workable│Breezy│SmartRecruiters│...    │
├──────────────────────────────────────────────────────────────────┤
│                   🏢 LAYER 2: PRECONFIGURED ATS (46 sources)    │
│    Greenhouse×30│Lever×10│Ashby×8│Workable×4                    │
├──────────────────────────────────────────────────────────────────┤
│                     📡 LAYER 1: RSS BOOTSTRAP (25 feeds)         │
│    WeWorkRemotely│RemoteOK│Himalayas│Jobspresso│CryptoJobs│...  │
└──────────────────────────────────────────────────────────────────┘
```

### ATS Pattern Detection (`sourceDiscovery.js`)

The discovery module recognizes **14 ATS platforms** from job URLs:

| Platform        | Hostname Pattern                    | Connector       |
| --------------- | ----------------------------------- | --------------- |
| Greenhouse      | `boards.greenhouse.io`              | `greenhouse.js` |
| Lever           | `jobs.lever.co`                     | `lever.js`      |
| Ashby           | `jobs.ashbyhq.com`, `*.ashbyhq.com` | `ashby.js`      |
| Workable        | `apply.workable.com`                | `workable.js`   |
| Breezy HR       | `jobs.breezy.hr`, `*.breezy.hr`     | Detected only   |
| SmartRecruiters | `careers.smartrecruiters.com`       | Detected only   |
| Recruitee       | `*.recruitee.com`                   | Detected only   |
| Rippling        | `app.rippling.com`                  | Detected only   |
| Pinpoint        | `*.pinpointhq.com`                  | Detected only   |
| Teamtailor      | `*.teamtailor.com`                  | Detected only   |
| Dover           | `app.dover.com`                     | Detected only   |
| Freshteam       | `*.freshteam.com`                   | Detected only   |
| Jobvite         | `jobs.jobvite.com`                  | Detected only   |

> **Note**: "Detected only" platforms are registered in `source_registry` for tracking but lack dedicated connector implementations. They are discoverable but not yet fetchable.

---

## Intelligence Layer

### 4-Tier Priority Scoring (`sourceIntelligence.js`)

```
Priority = (Yield × 0.30) + (Freshness × 0.25) + (Reliability × 0.25)
         + (Consistency × 0.10) + (Relevance × 0.10)
```

| Tier        | Score | Cycle Interval  | Effective Frequency |
| ----------- | ----- | --------------- | ------------------- |
| **High**    | ≥ 65  | Every cycle     | Every 15 min        |
| **Medium**  | ≥ 35  | Every 3 cycles  | ~45 min             |
| **Low**     | ≥ 10  | Every 8 cycles  | ~2 hours            |
| **Dormant** | < 10  | Every 16 cycles | ~4 hours            |

Additional intelligence features:

- `detectHiringVelocitySurge()` — Sources with >30% job volume increase get +15 priority bonus
- `detectTrendTrigger()` — Skills with ≥20% weekly growth or ≥5 new occurrences flagged in KV with 7-day TTL

### Circuit Breaker (`feedHealth.js`)

| Constant                | Value       | Purpose                                   |
| ----------------------- | ----------- | ----------------------------------------- |
| `OPEN_THRESHOLD`        | 10          | Consecutive failures before circuit opens |
| `BASE_COOLDOWN_SECONDS` | 300 (5 min) | Initial cooldown duration                 |
| `MAX_COOLDOWN_SECONDS`  | 3600 (1 hr) | Maximum cooldown cap                      |
| `HEALTH_TTL`            | 30 days     | KV health record expiration               |

Cooldown formula: `min(MAX, BASE × 2^(failures - threshold))` with ±20% jitter.

### Dynamic Threshold (`threshold.js`)

| Constant         | Value        |
| ---------------- | ------------ |
| `WINDOW_SIZE`    | 200 scores   |
| `MIN_THRESHOLD`  | 30           |
| `MAX_THRESHOLD`  | 70           |
| `ADJUST_STEP`    | ±2 per cycle |
| `TARGET_MATCHES` | 1–8 per run  |

---

## 5-Level Deduplication System

| Level                  | Mechanism                                                                 | Where            | Catches                                        |
| ---------------------- | ------------------------------------------------------------------------- | ---------------- | ---------------------------------------------- |
| **1. URL**             | D1 `UNIQUE(url)` constraint                                               | `jobs` table     | Same URL ingested twice                        |
| **2. Content Hash**    | D1 `UNIQUE(content_hash)` — FNV-1a of `company::title::url_path::snippet` | `jobs` table     | Same job reposted with different URL           |
| **3. Similarity Hash** | FNV-1a of `company::title` only (loose) — `clusterDuplicates()`           | `core/dedup.js`  | Cross-source duplicates (RSS + ATS + Career)   |
| **4. Intra-Batch**     | In-memory `Set<content_hash>`                                             | `processFeeds()` | Duplicates within a single queue message batch |
| **5. Alert-Level**     | `sent_alerts(job_id, profile_id)` PRIMARY KEY                             | D1 table         | Ensures each user sees each job exactly once   |

---

## D1 Database Schema (10 migrations)

| Migration                      | Tables/Changes                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `0001_initial.sql`             | `users`, `profiles`, `jobs` (UNIQUE url + content_hash), `feed_health`, `sent_alerts` |
| `0002_intelligence.sql`        | Source intelligence columns                                                           |
| `0003_embeddings.sql`          | Embedding vector storage                                                              |
| `0004_safety.sql`              | Safety constraints                                                                    |
| `0005_source_registry.sql`     | `source_registry` table for discovered sources                                        |
| `0006_source_intelligence.sql` | Priority scoring, tier assignment, crawl stats                                        |
| `0007_daily_metrics.sql`       | `daily_metrics` table for report aggregation                                          |
| `0008_expansion_tuning.sql`    | Exploration bonus columns                                                             |
| `0009_enriched_fields.sql`     | Enrichment metadata                                                                   |
| `0010_growth_tables.sql`       | `domain_registry`, growth engine tables                                               |

---

## Project Structure

```
job-hunter-bot/
├── src/
│   ├── worker.js                  # Entry point: fetch + scheduled + queue handlers (845 LOC)
│   ├── config.js                  # Frozen config: 25 RSS + 46 ATS + scoring rules (270 LOC)
│   ├── env.ts                     # Zod env validation
│   │
│   ├── core/
│   │   ├── logger.js              # Structured console logging with levels
│   │   ├── utils.js               # sanitizeText, compareTwoStrings, escapeRegex, parseExperienceYears, extractSalaryUSD
│   │   ├── schema.js              # RawJob typedef, normalizeJob(), fnvHash(), jobDedupeKey()
│   │   ├── dedup.js               # clusterDuplicates(), computeSimilarityHash(), isDuplicateByEmbedding()
│   │   └── batcher.js             # Batch processing utilities
│   │
│   ├── connectors/
│   │   ├── index.js               # CONNECTOR_MAP registry + runAllConnectors()
│   │   ├── base.js                # fetchWithTimeout(10s), rateLimitDomain(2s), buildSourceList(), groupByType()
│   │   ├── rss.js                 # RSS/Atom XML parsing
│   │   ├── greenhouse.js          # Greenhouse public JSON API
│   │   ├── lever.js               # Lever public JSON API
│   │   ├── ashby.js               # Ashby posting API
│   │   ├── workable.js            # Workable v3 API
│   │   └── careerPage.js          # Career page HTML + JSON-LD extraction
│   │
│   ├── discovery/
│   │   ├── sourceDiscovery.js     # 14 ATS hostname patterns → auto-register in D1
│   │   ├── careerDetector.js      # 16 career path patterns, JSON-LD+link counting, domain registry
│   │   └── searchExpander.js      # DuckDuckGo HTML search, domain extraction, DDG cooldown
│   │
│   ├── intelligence/
│   │   ├── sourceIntelligence.js  # calculatePriority(), assignTier(), getSourcesForCycle(), detectHiringVelocitySurge()
│   │   ├── feedHealth.js          # Circuit breaker: isFeedCircuitOpen(), recordFeedResult(), calculateCooldown()
│   │   ├── threshold.js           # Dynamic threshold: recordJobScore(), getEffectiveThreshold(), computeWindowStats()
│   │   ├── dailyReport.js         # incrementDailyMetrics(), formatDailyReport(), sendDailyReport()
│   │   ├── growthEngine.js        # Growth strategy orchestration
│   │   └── enrichment.js          # Job data enrichment
│   │
│   ├── scoring/
│   │   ├── relevance.js           # v3 scoring engine: scoreJob(), computeTfIdfScore(), detectSeniority() (791 LOC)
│   │   ├── skills.js              # Centralized dictionaries: SENIORITY_REGEX, NON_JS_STACKS, SCORE_LABELS
│   │   └── feedback.js            # recordInteraction(), applyFeedbackBoost(), applyFeedbackToSource()
│   │
│   ├── db/
│   │   ├── index.js               # Barrel export for all DB functions
│   │   ├── jobs.js                # insertJobIfNotExists(), batchInsertJobs(chunk=40), cleanupStaleJobs()
│   │   ├── sources.js             # Source registry CRUD, getEnabledSources(), getSourceMetrics()
│   │   ├── profiles.js            # getActiveProfiles(), hasSentAlert(), markAlertSent()
│   │   └── terms.js               # recordTermFrequencies(), getGlobalTermFrequencies()
│   │
│   ├── notifications/
│   │   ├── notifications.js       # sendAlert() → Discord webhook embeds + Telegram MarkdownV2
│   │   ├── notificationQueue.js   # Queue batching helpers
│   │   └── ai.js                  # generateEmbedding() (budget=40), cosineSimilarity(), retry with backoff
│   │
│   └── storage/
│       ├── storage.js             # KV read/write wrappers
│       ├── runLock.js             # Cron execution lock
│       └── feeds.js               # Feed state tracking
│
├── tests/
│   ├── stress.pipeline.test.js    # End-to-end pipeline: scoring, thresholds, AI boost, exclusion
│   ├── stress.notifications.test.js # Alert delivery, dedup, score labels, determinism
│   └── stress.resilience.test.js  # 200KB jobs, boundary thresholds, concurrent dedup, D1 chunking
│
├── migrations/                    # 10 D1 schema migrations (0001–0010)
├── daily-report.js                # Standalone CLI: node daily-report.js [--console|--dry-run]
├── config.json                    # Legacy config (runtime uses config.js frozen object)
├── wrangler.jsonc                 # Worker config: cron, queues, D1, KV, AI bindings
└── package.json                   # v3.1.0, ESM, sole dep: zod
```

---

## API Endpoints

| Endpoint   | Method | Handler   | Response                                                            |
| ---------- | ------ | --------- | ------------------------------------------------------------------- |
| `/health`  | GET    | `fetch()` | `{ status, version, architecture, secrets }`                        |
| `/metrics` | GET    | `fetch()` | Source metrics from `getSourceMetrics(db)`                          |
| `/report`  | GET    | `fetch()` | Plain text daily intelligence report. `?date=YYYY-MM-DD` supported. |
| `/report`  | POST   | `fetch()` | Generate + send report to Discord/Telegram                          |
| `/trigger` | POST   | `fetch()` | Manual crawl cycle trigger (queue or direct fallback)               |

---

## Cloudflare Free Tier Budget

| Resource       | Limit            | Mitigation                                                       |
| -------------- | ---------------- | ---------------------------------------------------------------- |
| **Workers**    | 100k req/day     | Priority-based source selection reduces invocations by 60–80%    |
| **D1**         | 5M rows read/day | `D1_BATCH_CHUNK=40`, `INSERT OR IGNORE`, 30-day stale cleanup    |
| **KV**         | 100k reads/day   | Cycle counters, circuit breaker checks, threshold windows        |
| **Queues**     | 1M msgs/month    | `sendBatch()` chunks of 100, smart source selection              |
| **Workers AI** | 10k neurons/day  | `MAX_AI_CALLS_PER_INVOCATION=40`, skip below score 50            |
| **CPU**        | 10ms/invocation  | Queue decoupling spreads compute; `WALL_TIME_LIMIT_MS=22s` guard |

---

## Known Issues & Limitations

| Issue                                         | Impact                                                                                                                            | Status    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **8 of 14 ATS platforms lack connectors**     | Breezy, SmartRecruiters, Recruitee, Rippling, Pinpoint, Teamtailor, Dover, Freshteam, Jobvite are detected but cannot be fetched. | Tracked   |
| **DDG HTML search is fragile**                | DuckDuckGo blocks automated queries; cooldown mitigation is in place but search expansion can stall for extended periods.         | Mitigated |
| **No authentication on API endpoints**        | `/trigger`, `/report`, `/metrics` are publicly accessible. No bearer token or API key check.                                      | Open      |
| **Single-region D1**                          | D1 is single-region SQLite; read latency spikes for globally distributed Workers.                                                 | By design |
| **No email channel implementation**           | `notifications.js` references email but only Discord and Telegram are implemented.                                                | Tracked   |
| **Feedback loop requires manual interaction** | No UI for recording user interactions; requires direct API calls to `/feedback`.                                                  | Open      |
| **Profile management is DB-only**             | No API endpoints for creating/updating user profiles. Requires direct D1 SQL.                                                     | Open      |

---

## Scalability Analysis

### Current Throughput (measured)

From stress tests: **529 jobs/sec** (2000 jobs in 3778ms) with scoring pipeline. Zero crashes.

### 10× Load Path

| Bottleneck                | Current Capacity         | 10× Mitigation                                                                  |
| ------------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| **Queue throughput**      | 5 msgs/batch, 3 queues   | Increase `max_batch_size` to 25–50 in `wrangler.jsonc`                          |
| **D1 write volume**       | 40 stmts/batch call      | D1 supports ~50k writes/day on free tier; upgrade to paid for 10×               |
| **AI subrequest budget**  | 40 calls/invocation      | Pre-filter aggressively; only embed jobs scoring >60 instead of >50             |
| **Cron frequency**        | Every 15 min             | Already optimal; more frequent would waste cycles                               |
| **Source count**          | ~71 hardcoded + registry | Source intelligence tier system already handles 500+ sources efficiently        |
| **Memory per invocation** | ~128 MB isolate          | `slimJob()` strips heavy fields; intra-batch dedup prevents object accumulation |

### Architectural Ceiling

The queue-per-phase topology is the primary scalability enabler. Each phase (fetch, evaluate, alert) runs in its own Worker invocation with independent CPU budgets. Horizontal scaling is implicit — Cloudflare spawns new isolates automatically for queue depth. The practical ceiling is **Cloudflare's paid tier limits**, not architectural.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Cloudflare Account](https://dash.cloudflare.com/sign-up) (free tier)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) v4+

### Setup

```bash
git clone https://github.com/your-username/job-hunter-bot.git
cd job-hunter-bot
npm install

npx wrangler login
npx wrangler d1 create job-hunter-db
npx wrangler kv namespace create SEEN_JOBS
npx wrangler queues create feed-queue
npx wrangler queues create job-queue
npx wrangler queues create alert-queue

# Update wrangler.jsonc with returned IDs

npx wrangler d1 migrations apply job-hunter-db --local  # Local
npx wrangler d1 migrations apply job-hunter-db          # Production

npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put TELEGRAM_BOT_TOKEN  # Optional
npx wrangler secret put TELEGRAM_CHAT_ID    # Optional
```

### Run

```bash
npm run dev              # Local development
npm run deploy           # Deploy to Cloudflare
npm test                 # Run 80+ test assertions (3 stress suites)
node daily-report.js     # Generate daily intelligence report
```

---

## 📝 License

ISC License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <sub>Built by <a href="https://github.com/Arpitpatidar00">Arpit Patidar</a></sub>
</p>
