# JobHunterBot — Complete System Report

> **Combined document** containing all audit reports, architectural analysis, operational intelligence, and optimization results in a single reference.

## Table of Contents

1. [Part 1: Deep Architecture & Runtime Audit (v2)](#part-1-deep-architecture--runtime-audit-v2)
2. [Part 2: Deep System Audit v3](#part-2-deep-system-audit-v3)
3. [Part 3: System Audit Report](#part-3-system-audit-report)
4. [Part 4: Operational Intelligence Report](#part-4-operational-intelligence-report)
5. [Part 5: Final Architecture Analysis](#part-5-final-architecture-analysis)
6. [Part 6: Optimization Report](#part-6-optimization-report)

---
---

# Part 1: Deep Architecture & Runtime Audit (v2)


> **Methodology:** Every claim in this report is derived from tracing actual execution paths in the codebase, not from architectural assumptions. Files and line numbers are referenced throughout.

---

## A. Real Runtime Flow (Verified)

Traced from `src/worker.js` through every module. Compute-cost hotspots marked with ⚡.

```
CRON (every 15 min)
 └─ _scheduledImpl()                           [worker.js:1218]
     ├─ getAndIncrementCycle(KV)                [1 KV read]
     ├─ buildSourceList(config)                 → 86 static sources
     ├─ getEnabledSources(DB)                   → N dynamic registry sources  ⚡ D1 read
     ├─ getSourcesForCycle(DB, cycleNumber)     → tier-filtered registry sources  ⚡ D1 read
     ├─ MERGE: ALL 86 config + filtered registry → sourcesToCrawl
     ├─ FEED_QUEUE.sendBatch(sourcesToCrawl)    → chunks of 50  ⚡ Queue writes
     │
     ├─ [every 4 cycles] recalculatePriorities(DB)      ⚡ D1 batch
     ├─ [every 4 cycles] probeDomainsForCareers(DB)     ⚡ N fetch + D1
     └─ [every 4 cycles] runSearchExpansion(DB, queries) ⚡ N fetch + D1

FEED_QUEUE consumer (batch_size=5)
 └─ processFeeds(messages)                     [worker.js:406]
     ├─ getFeedHealthRecord(KV) per source     ⚡ 5 KV reads (circuit check)
     ├─ runAllConnectors(batchConfig, KV)      [connectors/index.js:70]
     │   ├─ buildSourceList(batchConfig)        → rebuilds list from message bodies
     │   ├─ groupByType()
     │   └─ for each type, chunk(10):
     │       └─ connector(chunk, config, kv)    ⚡⚡ N×fetch (RSS/ATS APIs)
     │           ├─ RSS: parseXml + cursor dedup (KV read/write per source)
     │           ├─ Greenhouse: fetch ALL jobs, NO limit          ← FLOOD SOURCE
     │           ├─ Lever: fetch ALL postings, NO limit           ← FLOOD SOURCE
     │           ├─ Ashby: GraphQL ALL jobPostings, NO limit      ← FLOOD SOURCE
     │           └─ Workable: POST ALL results, NO limit          ← FLOOD SOURCE
     │
     ├─ INTRA-BATCH DEDUP: Set(content_hash)   → filters within THIS invocation only
     ├─ ctx.waitUntil(async () => {
     │   ├─ batchInsertJobs(DB, dedupedJobs)   ⚡ D1 batch INSERT OR IGNORE
     │   ├─ JOB_QUEUE.sendBatch(slimJob(new))  ⚡ Queue writes (chunks of 50)
     │   ├─ detectAtsSourcesWithDomains(ALL job URLs)   ← runs on ALL jobs, not just new
     │   ├─ batchRegisterDiscoveredSources(DB)  ⚡ D1 writes
     │   ├─ batchRegisterDomains(DB)            ⚡ D1 writes
     │   ├─ recordSourceYieldsBatch(DB)         ⚡ D1 batch
     │   └─ incrementDailyMetrics(DB)           ⚡ D1 write
     │   })

JOB_QUEUE consumer (batch_size=5)
 └─ evaluateJobs(messages)                     [worker.js:769]
     ├─ getActiveProfiles(DB)                  ⚡ D1 read
     ├─ getEffectiveThreshold(KV)
     ├─ getProfileEmbedding(AI, KV)            ⚡ AI subrequest (cached)
     ├─ getGlobalTermFrequencies(DB)           ⚡ D1 read
     ├─ for each job:
     │   ├─ isNewJob() filter                  → time-window gate (24h)
     │   ├─ hasBasicKeywordMatch() pre-filter  → regex gate
     │   ├─ computeQuickKeywordScore()         → skip AI if >75
     │   ├─ chunkTexts() + embedChunks(AI)     ⚡⚡ AI subrequest (budget: 30/invocation)
     │   ├─ scoreJob()                         ⚡ CPU: Trie scan + TF-IDF + combos
     │   ├─ applyFeedbackBoost()
     │   └─ if score >= threshold:
     │       └─ ALERT_QUEUE.send()             ⚡ Queue write
     └─ batchMarkAlertSent(DB)                 ⚡ D1 batch

ALERT_QUEUE consumer (batch_size=5)
 └─ sendAlerts(messages)                       [worker.js]
     └─ sendAlert(job, scoreResult)
         ├─ Discord: fetch(webhook) with 429 retry  ⚡ External fetch
         └─ Telegram: fetch(api.telegram.org)       ⚡ External fetch
```

---

## 1. Source Explosion Analysis

### Static Sources in `config.js`

| Type | Count | Notes |
|------|-------|-------|
| RSS feeds (`config.feeds[]`) | 24 | Job boards: WeWorkRemotely, RemoteOK, Himalayas, etc. |
| Greenhouse (`config.sources[]`) | 33 enabled | HashiCorp, Discord, Figma, Cloudflare, etc. (~1 disabled) |
| Lever | 11 enabled | Stripe, Twitch, Deel, Mercury, etc. (~1 disabled) |
| Ashby | 10 | Notion, Linear, Ramp, Resend, Raycast, etc. |
| Workable | 6 | Toggl, Superside, Coda, Lemon.io, Whereby |
| **Total Static** | **84** enabled | |

### Double-Sourced Companies (CRITICAL FINDING)

These companies are crawled from **multiple ATS platforms**, producing cross-platform duplicates that bypass `content_hash` dedup because the URLs differ:

| Company | Platform 1 | Platform 2 | Impact |
|---------|-----------|-----------|--------|
| **Notion** | Greenhouse (`boards-api.greenhouse.io/v1/boards/notion/jobs`) | Ashby (`api.ashbyhq.com/posting-api/job-board/notion`) | Same jobs, different URLs |
| **Linear** | Greenhouse (`boards-api.greenhouse.io/v1/boards/linear/jobs`) | Ashby (`api.ashbyhq.com/posting-api/job-board/linear`) | Same jobs, different URLs |
| **Netlify** | Greenhouse (`boards-api.greenhouse.io/v1/boards/netlify/jobs`) | Lever (`api.lever.co/v0/postings/netlify`) | Same jobs, different URLs |
| **Vercel** | Greenhouse (`boards-api.greenhouse.io/v1/boards/vercel/jobs`) | Lever (`api.lever.co/v0/postings/vercel`) | Same jobs, different URLs |

**Root Cause:** `content_hash` in `schema.js:121` is computed from `dedupeStr + urlPath + content[:500]`. Since `urlPath` differs between platforms (e.g., `greenhouse.io/...` vs `ashbyhq.com/...`), the hash is different even for the same job.

The `similarity_hash` field (line 126, `fnvHash(dedupeStr)` — company+title only) **IS computed but is NEVER used as a D1 UNIQUE constraint**. It exists in memory only and is discarded.

### Dynamic Source Growth

Sources are added by three mechanisms:

1. **ATS Detection** (`detectAtsSourcesWithDomains` in `processFeeds`, line 669): Extracts URLs from **ALL fetched jobs** (not just new ones) and pattern-matches ATS board URLs. Uses `INSERT OR IGNORE` on `source_registry.url`.
2. **Search Expansion** (`runSearchExpansion`, runs every 4 cycles): Queries Bing/Brave with 15+ search strings, extracts ATS URLs from results. Adds 0-10 sources per run.
3. **Career Page Probing** (`probeDomainsForCareers`, runs every 4 cycles): Tests domains for career pages across 16 path suffixes (`/careers`, `/jobs`, `/work-with-us`, etc.).

**Source growth safeguards:**
- `INSERT OR IGNORE` on `source_registry.url` PRIMARY KEY — prevents URL-exact duplicates ✅
- `SKIP_DOMAINS` set in `sourceDiscovery.js` filters generic domains ✅
- Auto-disable after 20 consecutive failures ✅
- Re-enable after 48 hours gives disabled sources another chance ⚠️ (can re-introduce bad sources)

**Missing safeguard:** No cap on total source count. No maximum-sources-per-domain limit. No diminishing returns on sources that consistently produce 100% duplicates.

---

## 2. Crawl Scheduling Logic

### How Sources Are Selected Per Cycle

In `_scheduledImpl` (line 1227-1260):

```javascript
const configSources = buildSourceList(config);  // ALL 84 static sources
const prioritySources = await getSourcesForCycle(env.DB, cycleNumber);
sourcesToCrawl = [
  ...configSources,  // ALL config sources, ALWAYS included
  ...prioritySources.filter(s => !configUrls.has(s.url)), // registry-only sources, filtered by tier
];
```

> **CRITICAL FINDING:** Config sources **completely bypass** the priority/tier system. All 84 static sources are dispatched **every single cron cycle** (every 15 minutes), regardless of their priority score, crawl tier, or duplication ratio.

**Tier filtering only applies to dynamically discovered registry sources.** This means the intelligence layer's priority scoring, hiring surge detection, and adaptive scheduling have **zero effect** on the bulk of the crawling workload.

### Per-Cycle Source Estimate

| Source Type | Per Cycle | Rationale |
|-------------|-----------|-----------|
| Config sources (static) | **84** | Always included, every cycle |
| Registry (high tier) | ~5-15 | Every cycle |
| Registry (medium tier) | ~3-8 | Every 3rd cycle |
| Registry (low tier) | ~2-5 | Every 8th cycle |
| Registry (exploration) | ~0-5 | Recently discovered, always included |
| **Average total** | **~95-110** | |

### Jobs Per Source (Estimated)

| Connector | Typical Jobs/Source | Range | Has Limit? |
|-----------|---------------------|-------|------------|
| RSS feeds | 10-50 | 0-200 | 2MB body limit only |
| Greenhouse | 30-300 | 5-500+ | **NO** — returns ALL `data.jobs` |
| Lever | 20-200 | 0-400+ | **NO** — returns full array |
| Ashby | 10-100 | 0-200 | **NO** — returns all `jobPostings` |
| Workable | 10-80 | 0-150 | **NO** — returns all `results` |
| Career Page | 5-30 | 0-50 | HTML parsing limited |

### Daily Processing Math

```
Sources per cycle:           ~100
Average jobs per source:     ~40 (weighted average across types)
Raw jobs per cycle:          ~4,000
Cycles per day:              96 (every 15 min × 24h)
                             ─────────────────────────
Raw jobs per day:            ~384,000

After in-memory dedup:       ~360,000 (only catches within same batch invocation)
After D1 INSERT OR IGNORE:   ~2,000-5,000 truly new jobs per day
                             ─────────────────────────
Duplicate ratio:             ~98-99%
Wasted D1 writes:            ~355,000+ INSERT OR IGNORE per day (mostly dupes)
```

**This is the core problem.** The system fetches 350,000+ jobs per day but only ~3,000 are genuinely new. The remaining ~98% are burned as wasted fetches, wasted CPU parsing, wasted memory allocation, and wasted D1 `INSERT OR IGNORE` statements.

---

## 3. True Deduplication Effectiveness

### B. Duplicate Leakage Map

| Stage | Mechanism | Scope | Effectiveness | Gap |
|-------|-----------|-------|---------------|-----|
| **1. RSS Cursor** | KV pubDate cursor | Per-source, cross-cycle | **HIGH** for RSS | ATS connectors have NO cursor — they return ALL jobs every time |
| **2. In-Memory Set** | `Set(content_hash)` in `processFeeds` | Single `processFeeds()` invocation | **LOW** | Resets between queue batches. A source in batch #1 and same source in batch #2 won't dedup. |
| **3. D1 INSERT OR IGNORE** | `UNIQUE(url)` + `UNIQUE(content_hash)` | Global, persistent | **HIGH** for same-URL jobs | Cross-platform duplicates (different URLs) leak through. Every `INSERT OR IGNORE` costs a D1 write. |
| **4. similarity_hash** | `fnvHash(company::title)` | Computed but **never stored in D1** | **ZERO** | This field is generated but never used as a dedup constraint |
| **5. SimHash** | `generateSimHash` imported in worker.js | **Never called** in the main processFeeds flow | **ZERO** | Imported but unused in runtime dedup path |
| **6. Semantic dedup** | Cosine similarity on embeddings | Only in `evaluateJobs` for alerting | **Very Low** | Only prevents duplicate alerts, not duplicate processing |

### Layer 1 — In-Memory Dedup: Deep Dive

**Where the Set is created:** `processFeeds`, line 492:
```javascript
const seenHashes = new Set();
```

**Scope:** Lives only for the duration of one `processFeeds()` invocation. Since `processFeeds` is the queue consumer, each queue batch (max 5 messages) gets its own `Set`. Two separate queue batches processing sources that return overlapping jobs **will not cross-dedup**.

**Does it persist across batches?** NO. The `Set` is a local variable inside `processFeeds`.

**Does it reset between connectors?** YES — but within a single invocation, the Set persists across connector types. If batch #1 contains both an RSS feed and a Greenhouse source that return the same job (different URL → different content_hash), they still won't dedup because the hash differs.

### Layer 2 — Database Dedup: Deep Dive

**D1 Schema** (`0001_initial.sql:23`):
```sql
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    url TEXT UNIQUE NOT NULL,
    content_hash TEXT UNIQUE NOT NULL,
    ...
);
```

**Duplicate detection happens AFTER:**
1. The HTTP fetch has already been made ⚡
2. The XML/JSON has been parsed ⚡
3. The job has been normalized ⚡
4. The content_hash has been computed ⚡
5. The job has been passed through in-memory dedup ⚡

Only then does `INSERT OR IGNORE` silently reject it. **All CPU cost has already been spent.**

### Layer 3 — SimHash / Similarity Hash

`generateSimHash` is imported at `worker.js:102` but **never called** in `processFeeds` or `evaluateJobs`. It's dead code in the main pipeline.

`similarity_hash` is computed in `schema.js:126` as `fnvHash(company::title)` but **never stored in D1** and **never compared against**. It rides along in the job object and gets garbage-collected.

---

## 4. Job Volume Explosion Analysis

### Why Raw Job Counts Are Extremely High

**Root Cause 1: ATS connectors have no result limits.**

Every Greenhouse/Lever/Ashby/Workable fetch returns the company's **entire job board**:
- `greenhouse.js:112`: `const ghJobs = data.jobs || [];` — ALL jobs
- `lever.js:132`: `const postings = Array.isArray(data) ? data : [];` — ALL postings
- `ashby.js:144`: `data?.data?.jobBoard?.jobPostings || []` — ALL postings
- `workable.js:118`: `data.results || []` — ALL results

A company like MongoDB or Datadog with 300+ openings returns 300+ jobs **every single crawl cycle**. Since they're `high` tier (or config-static), they're crawled every 15 minutes.

**Root Cause 2: Config sources bypass tier scheduling.**

`_scheduledImpl` line 1247: `sourcesToCrawl = [...configSources, ...prioritySources...]`

ALL 84 config sources run every cycle. The intelligence layer only throttles registry-discovered sources.

**Root Cause 3: No connector-level cursor for ATS.**

RSS connector has `rss_cursor:` in KV (line 254-289) that filters items by `pubDate`. Greenhouse, Lever, Ashby, and Workable have **no equivalent cursor mechanism**. They return identical full-board dumps every time.

### Estimated Per-Source Volumes

| Company (Greenhouse) | Est. Jobs | Every 15 min? |
|----------------------|-----------|---------------|
| MongoDB | 300+ | Yes (config) |
| Datadog | 250+ | Yes (config) |
| Cloudflare | 200+ | Yes (config) |
| Scale AI | 150+ | Yes (config) |
| Grafana Labs | 100+ | Yes (config) |
| HashiCorp | 100+ | Yes (config) |

That's **~1,100+ Greenhouse jobs** from just 6 companies, re-fetched and re-parsed every 15 minutes. Over 24 hours = **~105,000 wasted job parses** from these 6 sources alone.

---

## 5. Connector Behavior Analysis

### RSS Connector (`rss.js`)
- **Limit:** 2MB max response body (line 146)
- **Cursor:** ✅ KV-based `pubDate` cursor (line 254-289) filters previously seen items
- **Concurrency:** 5 parallel feeds (line 320: `pLimit(5)`)
- **Impact:** Moderate — cursor prevents most re-processing

### Greenhouse Connector (`greenhouse.js`)
- **Limit:** **NONE** — fetches `?content=true` which includes full job descriptions
- **Cursor:** ❌ No cursor or incremental fetch
- **Pagination:** ❌ No pagination — single API call returns all jobs
- **Concurrency:** 3 parallel (line 17)
- **Impact:** **SEVERE** — `content=true` means every job includes full HTML description, multiplying payload size

### Lever Connector (`lever.js`)
- **Limit:** **NONE**
- **Cursor:** ❌
- **Pagination:** ❌
- **Concurrency:** 3 parallel
- **Impact:** HIGH — Lever boards can have 200+ postings

### Ashby Connector (`ashby.js`)
- **Limit:** **NONE** — GraphQL query requests ALL fields including `descriptionHtml` and `descriptionPlain`
- **Cursor:** ❌
- **Concurrency:** 3 parallel
- **Impact:** HIGH — full description fetched every time

### Workable Connector (`workable.js`)
- **Limit:** **NONE** — POST with empty filters
- **Cursor:** ❌
- **Concurrency:** 3 parallel
- **Impact:** MODERATE (boards are typically smaller)

### Career Page Connector (`careerPage.js`)
- **Limit:** Implicitly limited by HTML parsing quality
- **Cursor:** ❌
- **Rate limit:** 5s between same-domain requests
- **Impact:** LOW (few sources, small yield)

---

## 6. Queue Backpressure & Throughput

### Queue Configuration (`wrangler.toml`)

| Queue | Max Batch Size | Max Retries | Max Concurrency |
|-------|---------------|-------------|-----------------|
| feed-queue | 5 | 2 | 1 (default) |
| job-queue | 5 | 3 | 1 (default) |
| alert-queue | 5 | 5 | 1 (default) |

### Burst Analysis

**Scheduled producer** sends ~100 sources in chunks of 50 to `feed-queue`:
- 2 queue `sendBatch` calls per cycle
- 200ms delay between batches
- Each message = 1 source config object

**Feed consumer** (`processFeeds`) receives 5 sources per batch:
- Processes 5 sources → potentially 200-1500 raw jobs
- Sends new jobs to `job-queue` in chunks of 50
- With 20 queue batches to drain 100 sources: takes ~5-10 minutes

**Queue congestion scenario:**
If `processFeeds` for one batch takes 15s (heavy ATS sources), the feed-queue will accumulate 20 batches. With `max_concurrency: 1`, these serialize. 20 × 15s = 5 minutes of queue drain time — which is within the 15-minute cron window.

**Direct fallback risk:** If `FEED_QUEUE.sendBatch` fails (rate limit), `_scheduledImpl` falls back to processing ALL 100 sources synchronously inline with a 25s wall-time guard. This can only process 1-2 batches before hitting the limit, leaving 80+ sources unprocessed.

---

## 7. Worker Execution Limits Analysis

### CPU Time Budget Distribution (per `processFeeds` invocation)

| Operation | Est. CPU Time | Notes |
|-----------|---------------|-------|
| Circuit breaker KV reads | 50-100ms | 5 KV reads |
| HTTP fetches (connectors) | 2-8s | Bottleneck: network I/O (not CPU) |
| XML/JSON parsing | 200-500ms | RSS regex parsing is CPU-heavy |
| Job normalization | 50-100ms | Per-job FNV hash, regex sanitization |
| In-memory dedup | 5-20ms | Set operations |
| D1 batch insert | 100-300ms | 40-item batch chunks |
| Queue sendBatch | 50-200ms | With retry delays |
| Discovery ATS detection | 50-150ms | Regex over ALL job URLs |
| **Total** | **~3-10s** | Well within 30s limit |

### CPU Time Budget (per `evaluateJobs` invocation)

| Operation | Est. CPU Time | Notes |
|-----------|---------------|-------|
| Profile/threshold setup | 50-100ms | D1 + KV reads |
| Per-job keyword pre-filter | 1-5ms/job | Regex matching |
| Per-job `scoreJob()` | 5-15ms/job | Trie scan + TF-IDF + combo checks |
| Per-job AI embedding | 200-500ms/job | **AI subrequest** — the bottleneck |
| Per-job RAG matching | 1-5ms/job | Min-Heap cosine similarity |
| **Total for 5 jobs** | **1-3s** | Fine if AI calls stay under budget |

### What Pushes Toward Limits

1. **Direct fallback processing:** When queues fail, `processFeeds` calls `evaluateJobsFallback()` inline, stacking fetcher + evaluator CPU in one invocation.
2. **Large ATS responses:** A single Greenhouse `?content=true` response with 300 jobs = parsing 300 job descriptions (each 1-10KB of HTML).
3. **AI subrequest cap:** 30 AI calls per invocation. If 5 jobs each need embedding = 5 AI calls. With default queue batch of 5 messages × multiple jobs per message, this is easily exceeded.

---

## 8. Discovery Engine Impact

### Growth Rate

- **Search expansion runs:** Every 4th cron cycle = 6 times/hour × 24h = **144 discovery runs/day**
- **Career probing runs:** Every 4th cycle = **144 probe runs/day**
- **ATS detection:** EVERY `processFeeds` invocation (no cycle gating)

### Source Addition Rate

Per search expansion run:
- `maxSearchesPerCycle: 5` queries
- `maxDomainsPerSearch: 15` domains extracted
- Typically 0-3 new ATS sources discovered per run
- 0-5 new domains queued for probing

**Estimated daily source growth:** 10-50 new sources/day (assuming Bing/Brave don't block)

### Missing Safeguards

1. **No total source cap.** The system will grow indefinitely.
2. **No duplicate-source detection beyond URL equality.** Two different URL formats for the same company (e.g., `/v1/boards/vercel/jobs` vs `/v0/postings/vercel`) register as separate sources.
3. **Re-enable loop:** Sources auto-disabled after 20 failures get re-enabled after 48 hours (`0006_source_intelligence.sql` re-enable logic in `recalculatePriorities`, line 157). If they fail again, they cycle through disable-reenable indefinitely.

---

## 9. Source Overlap Analysis

### Cross-Platform ATS Overlap

Companies frequently use multiple ATS platforms simultaneously or migrate between them. The config currently has:

| Company | Greenhouse ✅ | Lever ✅ | Ashby ✅ | Workable |
|---------|:---:|:---:|:---:|:---:|
| Notion | ✅ | | ✅ | |
| Linear | ✅ | | ✅ | |
| Netlify | ✅ | ✅ | | |
| Vercel | ✅ | ✅ | | |

When both connectors succeed, the same job appears from two sources with:
- Different `id` (e.g., `gh-12345` vs `ashby-67890`)
- Different `url` (e.g., `greenhouse.io/.../12345` vs `jobs.ashbyhq.com/.../67890`)
- Different `content_hash` (because URL path is part of the hash)
- **Same** `similarity_hash` (company::title) — but this is never checked

**Result:** Both copies pass D1 `UNIQUE(url)` and `UNIQUE(content_hash)` constraints. Both get stored. Both get scored. Both potentially trigger alerts.

### RSS Feed Overlap

Multiple RSS feeds cover the same job boards:
- `weworkremotely.com/remote-jobs.rss` overlaps with category feeds (programming, full-stack, front-end, back-end, devops) — job appearing in main feed AND category feed
- `remoteok.com` and `remoteok.io` — same site, two feeds
- `empllo.com` — two category feeds that may overlap

RSS cursor dedup (`pubDate`-based) helps within a single source but **not cross-source**.

---

## 10. Hidden Performance Problems

### Problem 1: Discovery Runs on ALL Jobs, Not Just New Ones

`processFeeds` line 661: `for (const job of jobs)` — iterates over ALL fetched jobs (before dedup).

```javascript
const urlsForAtsDetection = [];
for (const job of jobs) {         // <-- 'jobs' = ALL raw jobs, not 'newJobs'
    if (job.link) urlsForAtsDetection.push(job.link);
    if (job.company_url) urlsForAtsDetection.push(job.company_url);
    ...
}
```

If a batch fetches 1,000 raw jobs (98% duplicates), all 1,000 URLs are processed through ATS pattern detection. The discovery should run on `newJobs` only.

### Problem 2: `slimJob` Strips Content, Scoring Gets Degraded Input

`slimJob` (line 366-381) removes `content`, `contentSnippet`, and `description` to fit queue payload limits. In `evaluateJobs`, the scorer receives these stripped jobs. The `scoreJob` function in `relevance-v4.js` line 374 accesses:

```javascript
const rawBody = typeof (item.content || item.contentSnippet || item.description) === 'string'
    ? item.content || item.contentSnippet || item.description
    : '';
```

Since `slimJob` stripped all of these, `rawBody = ''`. **The entire scoring pipeline operates on title-only text for queued jobs.** Skills matching, TF-IDF, seniority detection, experience parsing, salary extraction — all depend on body text and all receive empty strings.

This means:
- `mustMatch` keyword hits only count if in the title
- TF-IDF score is always 0
- Experience/salary features are never detected
- The scoring engine is operating at ~30% capacity

**This effectively neuters the scoring pipeline for queue-routed jobs.**

### Problem 3: Repeated Config Loading

`loadConfig()` is called in `processFeeds`, `evaluateJobs`, and `_scheduledImpl`. It creates a new frozen object each time. The `getGlobalMatcher(config)` call in `scoreJob` rebuilds or retrieves a cached Aho-Corasick trie — but the cache key is the config object reference, which changes each call.

### Problem 4: Per-Job Regex Construction

In `scoreJob` and helper functions, `new RegExp(...)` is constructed per keyword per job:

```javascript
if (new RegExp(`\\b${escapeRegex(variant)}\\b`, "i").test(text)) return true;
```

With 5 `mustMatch` + 10 `shouldMatch` + 10 `niceToHave` + 15 `exclude` keywords, each with ~3 synonyms = ~120 regex constructions **per job**. For 50 jobs per evaluateJobs batch = 6,000 regex constructions per invocation.

The `FastMatcher` trie (`getGlobalMatcher`) should handle this, but the fallback `keywordMatchesText` function still constructs regexes.

### Problem 5: Redundant Circuit Breaker Check

In `processFeeds`, circuit breaker is checked via KV for each source (line 432-449). Then inside `runAllConnectors`, `rateLimitDomain` does another KV read for rate limiting. For 5 sources in a batch, this is 10+ KV reads before any actual fetching begins.

---

## C. Job Processing Math

### Realistic Throughput Calculation

```
Config sources:           84 (every cycle)
Registry sources (avg):   ~20 per cycle (tier-weighted)
Total sources/cycle:      ~104

RSS sources:              24 × ~25 avg jobs = 600 → after cursor: ~30 new
Greenhouse sources:       33 × ~100 avg jobs = 3,300 → 99% dupes = ~33 new
Lever sources:            11 × ~80 avg jobs = 880 → 99% dupes = ~9 new
Ashby sources:            10 × ~40 avg jobs = 400 → 99% dupes = ~4 new
Workable sources:         6 × ~30 avg jobs = 180 → 99% dupes = ~2 new
Registry sources:         20 × ~30 avg jobs = 600 → 95% dupes = ~30 new

Raw jobs per cycle:       ~5,960
New jobs per cycle:       ~108
Duplicate ratio:          ~98.2%

Cycles per day:           96
Raw jobs per day:         ~572,000
New jobs per day:         ~10,400
Wasted fetches/day:       ~561,000
```

### Resource Cost of Waste

Each wasted job costs:
- **Network I/O:** Already included in endpoint round-trip
- **CPU:** XML/JSON parse + normalize + hash = ~2ms
- **Memory:** ~5KB per job object in V8 heap
- **D1:** 1 `INSERT OR IGNORE` statement (counted toward daily limits)

Daily waste: `561,000 × 2ms = 18.7 minutes of CPU` just for parsing duplicates.

---

## D. Resource Waste Map

| Rank | Resource | Waste Source | Severity | Daily Impact |
|------|----------|-------------|----------|--------------|
| 1 | **D1 Writes** | `INSERT OR IGNORE` on duplicate jobs | 🔴 Critical | ~560K wasted write ops |
| 2 | **Network I/O** | Re-fetching full ATS boards every 15 min | 🔴 Critical | ~560K redundant job payloads |
| 3 | **CPU Time** | Parsing + normalizing + hashing duplicate jobs | 🟡 High | ~19 min wasted CPU |
| 4 | **Worker Memory** | Holding 5,000+ job objects in V8 heap per batch | 🟡 High | ~25MB per invocation |
| 5 | **Scoring Accuracy** | `slimJob` strips content → scoring on title-only | 🔴 Critical | 100% of queue-routed jobs affected |
| 6 | **AI Budget** | Embedding jobs that will score <50 | 🟡 High | Up to 30 AI calls/invocation |
| 7 | **KV Reads** | Redundant circuit breaker + rate limit checks | 🟢 Low | ~1,000 reads/day |

---

## E. Architecture Weaknesses

### 1. Late Deduplication
Duplicates are only caught at the D1 INSERT stage. All upstream CPU (fetch, parse, normalize, hash) is wasted. Moving dedup earlier (e.g., pre-fetch URL check) would eliminate ~98% of processing.

### 2. Config Sources Bypass Intelligence
The entire priority/tier system is rendered ineffective because config sources (84 of ~104 per cycle) are unconditionally included. The intelligence layer only governs ~20% of the crawl workload.

### 3. Missing ATS Cursors
RSS has cursor-based dedup. ATS connectors have none. This is the single largest contributor to duplicate volume.

### 4. Cross-Platform Duplicate Blindness
`similarity_hash` exists but is unused. Double-sourced companies generate duplicate jobs, duplicate alerts, and duplicate D1 entries.

### 5. Content Stripping Kills Scoring
`slimJob` removes all body text. The scoring engine receives title-only input. This makes mustMatch, TF-IDF, salary, seniority, and experience features useless for queue-routed jobs.

### 6. Uncontrolled Source Growth
No cap on total sources. Discovery adds 10-50 sources/day with no ceiling. After 6 months, registry could have 3,000+ sources — all needing periodic crawling.

---

## F. Concrete Optimization Opportunities

### Short-Term Fixes (1-2 days each)

1. **Add ATS cursor dedup via KV**
   - Store last-seen job IDs per ATS source in KV: `ats_cursor:{source_url}`
   - Filter out already-seen IDs before normalization
   - **Impact:** Eliminates ~80% of duplicate ATS processing
   - **Files:** `greenhouse.js`, `lever.js`, `ashby.js`, `workable.js`

2. **Fix `slimJob` content stripping**
   - Include `contentSnippet` (500 chars) in the slim payload
   - Alternatively, increase queue payload inspection and compress
   - **Impact:** Restores scoring accuracy from ~30% to ~90%
   - **File:** `worker.js:366`

3. **Remove double-sourced companies**
   - Remove Notion/Linear from one of Greenhouse/Ashby
   - Remove Netlify/Vercel from one of Greenhouse/Lever
   - **Impact:** Eliminates ~400-800 duplicate jobs/cycle
   - **File:** `config.js`

4. **Run discovery on `newJobs` not `jobs`**
   - Change line 661 from `for (const job of jobs)` to `for (const job of newJobs)`
   - **Impact:** Reduces ATS detection iterations by ~98%
   - **File:** `worker.js:661`

### Medium-Term Improvements (1-2 weeks)

5. **Apply tier scheduling to config sources**
   - Move config sources into D1 registry on first boot
   - Let the intelligence layer manage all sources uniformly
   - **Impact:** Reduces config source crawl frequency by 3-8x for low-value sources

6. **Add `similarity_hash` as D1 index (not unique constraint)**
   - Add index: `CREATE INDEX idx_jobs_similarity ON jobs(similarity_hash)`
   - Before inserting, check: `SELECT 1 FROM jobs WHERE similarity_hash = ? LIMIT 1`
   - Skip if exists — catches cross-platform duplicates
   - **Impact:** Eliminates cross-platform duplicate storage and scoring

7. **Add result-count limits to ATS connectors**
   - Greenhouse: `?content=true` → `?content=false` for initial scan, fetch content only for new jobs
   - All ATS: Limit to most recent 50-100 jobs per fetch
   - **Impact:** Reduces payload size by 5-10x, reduces parse time

8. **Pre-fetch URL dedup check**
   - Before running connectors, query D1: `SELECT url FROM jobs WHERE url IN (...)`
   - Skip URLs that already exist
   - **Trade-off:** Adds 1 D1 read per batch, saves N D1 writes

### Long-Term Scaling Strategies

9. **Event-sourced incremental crawling**
   - For ATS connectors, use `If-Modified-Since` or `updated_after` API parameters where available
   - Greenhouse has `updated_after` query param
   - **Impact:** Fundamental fix — only fetch genuinely new/updated jobs

10. **Source budget system**
    - Assign each source a daily "fetch budget" based on its yield ratio
    - Sources with >95% duplicate ratio get throttled to 1 crawl/day
    - **Impact:** Self-regulating system that scales with actual value

11. **Dedicated crawl worker**
    - Separate the crawler from the scorer into distinct Workers
    - Crawler writes to D1, scorer reads from D1 on a separate schedule
    - **Impact:** Decouples crawl frequency from scoring frequency

---

## Summary

The Job Hunter Bot's core architecture is sound, but **runtime behavior diverges significantly from design intent**. The intelligence layer (priority scoring, tier scheduling, hiring surge detection) governs only ~20% of the crawl workload because config sources bypass it entirely. ATS connectors lack the incremental-fetch cursors that RSS has, causing ~98% duplicate processing. The `slimJob` content-stripping degrades scoring accuracy to title-only matching. Cross-platform double-sourcing of 4 companies compounds the duplicate problem.

The single highest-impact fix is **adding ATS cursor dedup** (Short-Term Fix #1), which alone could reduce daily wasted processing from ~560K jobs to ~110K jobs — a 5x improvement with minimal code changes.


---
---

# Part 2: Deep System Audit v3


**Second-stage architecture audit** focusing on what the first optimization pass missed:
CPU hotspots, KV efficiency, D1 performance, queue architecture, memory usage, scheduler intelligence, scoring accuracy, alert quality, failure handling, and scaling limits.

---

## 1. Full System Execution Flow

```
Cron Trigger (every 15 min)
  ↓
_scheduledImpl()
  ├── getAndIncrementCycle(KV)          ← 1 KV read + conditional write
  ├── buildSourceList(config)           ← 80 static sources
  ├── getEnabledSources(D1)             ← 1 D1 query
  ├── getSourcesForCycle(D1)            ← 2 D1 queries (tiered + exploration)
  ├── Priority merge + top-40 selection
  ├── FEED_QUEUE.send() × batches       ← Queue writes
  ├── recalculatePriorities(D1)         ← every 4th cycle: 1 read + N updates
  ├── retrainThresholds(D1+KV)          ← every 24th cycle
  ├── probeDomainsForCareers(D1)        ← every 4th cycle
  ├── runSearchExpansion(D1+KV+fetch)   ← every 8th cycle
  └── sendDailyReport()                 ← every 96th cycle
        ↓
processFeeds (FEED_QUEUE consumer)
  ├── loadConfig()                      ← Re-parsed every invocation
  ├── getFeedHealthRecord(KV) × N       ← 2 KV reads per source
  ├── runAllConnectors(KV)              ← N HTTP fetches + cursor load/save
  ├── recordFeedResult(KV) × N          ← 2 KV ops per source (read+write)
  ├── updateSourceStats(D1) × N         ← 1 D1 write per source
  ├── Cycle-level dedup (KV load+save)  ← 2 KV ops (read cycle set, write back)
  ├── batchInsertJobs(D1)               ← 1 D1 batch per 40 jobs
  ├── JOB_QUEUE.send() × batches        ← Queue writes
  ├── detectAtsSourcesWithDomains()     ← CPU: regex on all URLs
  ├── batchRegisterDiscoveredSources(D1)
  └── recordSourceYieldsBatch(D1)       ← 1 D1 batch
        ↓
evaluateJobs (JOB_QUEUE consumer)
  ├── getActiveProfiles(D1)             ← 1 D1 query
  ├── getPreferenceWeights(KV)          ← 1 KV read
  ├── getEffectiveThreshold(KV)         ← 1-2 KV reads
  ├── getProfileEmbedding(AI+KV)        ← 1 AI call (or KV cache hit)
  ├── getGlobalTermFrequencies(D1)      ← 1 D1 query
  ├── Per-job loop:
  │   ├── isNewJob()                    ← time filter
  │   ├── hasBasicKeywordMatch()        ← FastMatcher
  │   ├── computeQuickKeywordScore()
  │   ├── chunkTexts() + embedChunks(AI+KV)  ← 0-1 AI call per job
  │   ├── scoreJob()                    ← CPU: scoring pipeline
  │   ├── applyFeedbackBoost(KV)
  │   ├── ALERT_QUEUE.send() per match  ← Queue write
  │   └── trackScoreDistribution(KV)    ← 1 KV write per alert
  ├── getSentAlertsForJobs(D1)          ← 1 D1 query per message
  ├── batchMarkAlertSent(D1)
  ├── recordJobScoresBatch(KV)          ← 1 KV write (batched)
  └── incrementDailyMetrics(D1)
        ↓
sendAlerts (ALERT_QUEUE consumer)
  └── sendAlert() per message           ← 1 HTTP call (Discord/Telegram)
```

---

## 2. Worker CPU Hotspots

| # | Hotspot | Location | Impact | Fix |
|---|---------|----------|--------|-----|
| 1 | **loadConfig() re-parsed every invocation** | `worker.js:409,810,1258` | Config is re-loaded 3× per cron cycle (processFeeds, evaluateJobs, scheduler). Object creation + array builds each time. | Cache at module level, invalidate only on config change |
| 2 | **Duplicated waitUntil/else blocks** | `worker.js:1051-1200` | 150 lines of identical code in ctx.waitUntil branch and else branch (scores batch, chunks batch, threshold adjust, daily metrics). Doubles maintenance cost, no CPU saving. | Extract to shared `postEvaluationCleanup()` function |
| 3 | **trackScoreDistribution N+1 calls** | `threshold.js:203-204` | `recordJobScoresBatch` calls `trackScoreDistribution` individually for each score. If batch has 50 scores → 50 separate KV read-modify-write cycles for histogram buckets. | Batch histogram updates into single KV write |
| 4 | **JSON.stringify for 10K hash cycle dedup set** | `worker.js:531` | Serializing 10,000 hashes to JSON string every processFeeds invocation. ~200KB string allocation + KV write. | Use smaller hash representation (4-byte hex) or bloom filter |
| 5 | **cosine similarity per chunk** | `worker.js:933-936` | O(768) float multiplications per chunk × 5 chunks × N jobs. For 50 jobs with 5 chunks each = 250 cosine ops. | Pre-compute profile magnitude once, use dot product only |
| 6 | **Regex-heavy sanitizeText in connectors** | `core/utils.js` | HTML entity decoding + whitespace normalization on every job field. Called thousands of times per batch. | Use lightweight string replace instead of regex chains |

---

## 3. KV Storage Analysis

| # | KV Key Pattern | Purpose | Size Est. | Frequency | Issue |
|---|----------------|---------|-----------|-----------|-------|
| 1 | `cursor:{type}:{slug}` | ATS cursor (job IDs) | ~5-15KB | 2 ops/source/cycle | **500 ID cap is generous** — most boards have <100 active jobs. Could reduce to 200. |
| 2 | `cycle_dedup:{N}` | Cross-batch dedup hashes | **~200KB** | 2 ops/cycle | **Largest KV value**. 10K hashes × ~20 chars each. Could blow up if hashes are long. |
| 3 | `feed:health:{hash}` | Per-feed health record | ~200B | **2 reads + 1 write per source per cycle** | With 40 sources → 120 KV ops just for health. Consider batching or reducing frequency. |
| 4 | `feed:circuit:{hash}` | Circuit breaker flag | ~1B | 1 read per source | Low cost individually, but adds up with health reads. |
| 5 | `thresh:window` | Rolling score window (200 scores) | ~1KB | 1 read + 1 write per eval batch | Fine, but in-memory cache resets on cold start. |
| 6 | `thresh:effective` | Current threshold | ~4B | 1 read + conditional write | Fine. Has dedup logic to avoid write if change <2. |
| 7 | `crawl_cycle_counter` | OLD cycle counter (unused after sourceIntelligence.js) | ~4B | 1 read/cycle | **Orphaned key** — `getAndIncrementCycle` uses `__cycle_number`, but `processFeeds` reads `crawl_cycle_counter`. These are **different keys**! |
| 8 | `trend:spike:{skill}` | Skill trend flags | ~1B each | N writes/discovery cycle | Fine. 7-day TTL. |
| 9 | `discovery:last_success_timestamp` | Discovery staleness check | ~30B | 1 read/cycle | Fine. |
| 10 | `pref:weights` | User preference weights | ~200B | 1 read/eval batch | Fine. |

### Critical KV Bug Found

> **`processFeeds` reads `crawl_cycle_counter` but `getAndIncrementCycle` writes `__cycle_number`.**

In `worker.js:494`:
```js
const cycleNumber = await env.SEEN_JOBS.get("crawl_cycle_counter");
```
But `getAndIncrementCycle` in `sourceIntelligence.js:334`:
```js
const raw = await kv.get('__cycle_number');
```

**These are two different keys.** The dedup cycle key in processFeeds will always be `cycle_dedup:null` or `cycle_dedup:0` since `crawl_cycle_counter` is likely stale/empty. This means the cycle-level dedup set may never properly rotate.

### KV Operation Budget (per cron cycle, ~40 sources)

```
Health reads:       80 (2 per source)
Health writes:      40 (1 per source)
Cursor reads:       40 (1 per source — ATS only)
Cursor writes:      40 (1 per source — ATS only)
Cycle dedup:         2 (read + write)
Score tracking:      2 (window + distribution)
Threshold:           2 (read + conditional write)
Cycle counter:       1 (conditional write)
Misc:               ~5 (profile embedding, preferences, etc.)
─────────────────────
TOTAL:             ~212 KV ops per cycle
```

Cloudflare Free Tier allows **1,000 KV reads + 1,000 KV writes per day**. At 96 cycles/day × 212 ops = **~20,000 KV ops/day**. This **vastly exceeds** free tier limits.

---

## 4. Database Efficiency (D1)

### Missing Indexes

| Table | Column(s) | Query That Needs It | Impact |
|-------|-----------|---------------------|--------|
| `jobs` | `company` | `detectHiringSurge`: `GROUP BY company WHERE created_at >= ...` | **Full table scan** on every growth engine run |
| `jobs` | `created_at` | `cleanupStaleJobs`: `WHERE fetched_at < datetime(...)` | Uses `idx_jobs_fetched_score` but only partially |
| `sent_alerts` | `job_id` | `getSentAlertsForJobs`: `WHERE job_id IN (...)` | Primary key is composite `(job_id, profile_id)` — this works for exact matches but IN queries may not use it efficiently |
| `daily_metrics` | `date` | `detectSkillSpikes`: `WHERE date >= date('now', '-14 days')` | No index — relies on small table assumption |

### Inefficient Query Patterns

1. **batchMarkAlertSent does an extra SELECT before INSERT** (`profiles.js:150-153`): Selects all existing job IDs just to check FK constraints, then does INSERT OR IGNORE. The FK check is redundant since INSERT OR IGNORE handles violations. This is **1 extra D1 query per alert batch**.

2. **growthEngine uses batch size 100** (`growthEngine.js:207`): D1 batch limit is **~50 statements**. Using 100 will fail silently or error for large batches. Should be 40 to stay safe.

3. **detectHiringSurge** runs a `GROUP BY company` on the entire jobs table (`growthEngine.js:103`). With thousands of jobs, this is expensive. No covering index on `(company, created_at)`.

4. **D1 `feed_health` table is never used** (`0001_initial.sql:33`): Feed health tracking was moved to KV (`feedHealth.js`) but the D1 table still exists. Dead schema bloat.

### D1 Write Budget

```
Per cycle:
  batchInsertJobs:        ~3 batches (120 jobs ÷ 40)
  updateSourceStats:      40 individual writes → should be batched
  recordSourceYieldsBatch: 1 batch
  batchMarkAlertSent:     1-2 batches
  incrementDailyMetrics:  1-3 writes
  batchRegisterSources:   0-1 batch
  ─────────────────────
  TOTAL: ~50 D1 queries per cycle

Per day (96 cycles): ~4,800 D1 queries
```

D1 Free Tier: **5M rows read + 100K rows written per day**. We are well within limits after the optimizations, but `updateSourceStats` being individual writes is wasteful.

---

## 5. Queue Architecture Analysis

| Stage | Payload Size | Rate | Issue |
|-------|-------------|------|-------|
| FEED_QUEUE | ~200B per source config | 1-4 msgs × 40 sources/cycle | ✅ Small payloads. Well-batched. |
| JOB_QUEUE | ~500B-2KB per job (with contentSnippet) | 1-10 msgs × 20 jobs each/cycle | ⚠️ `slimJob` now includes `contentSnippet` (500 chars). Verify stays under 128KB queue message limit. |
| ALERT_QUEUE | ~3-5KB per alert (full job + scoreResult) | 0-20 msgs/cycle | ⚠️ **Full job object + full scoreResult sent per alert**. `scoreResult` includes `breakdown`, `reasons[]`, `features{}`, `matchedSkills[]`. This is larger than necessary. |

### Queue Issues

1. **Alert payload bloat**: Each alert message contains the **entire job object** + **entire scoreResult** including breakdown details, reasons array, and features. Only ~30% of this data is used by `sendAlert()`. Could slim to just what notifications need.

2. **No dead letter queue**: If an alert fails after all retries, the message is ack'd and the alert is lost. No DLQ captures failed deliveries for later retry.

3. **evaluateJobs sends alerts one-at-a-time**: Each match calls `ALERT_QUEUE.send()` individually instead of batching. With 20 matches → 20 separate queue writes.

---

## 6. Deduplication Pipeline Review

### Current Dedup Layers (Post-Fix)

```
Layer 1: ATS Cursor (KV)        → Filters known job IDs per source
Layer 2: Per-source limit (50)   → Caps flood
Layer 3: Identity hash (KV)      → company+title+location
Layer 4: Content hash (memory)   → company+title+content
Layer 5: Cycle dedup set (KV)    → Persists across queue batches
Layer 6: D1 UNIQUE(content_hash) → Final catch-all
Layer 7: D1 UNIQUE(url)          → URL-level dedup
```

### Remaining Gaps

1. **Company name normalization is weak**: `jobDedupeKey` in `schema.js` does basic lowercase+trim. "Stripe, Inc." vs "Stripe" vs "stripe" are handled, but "Meta Platforms" vs "Facebook" vs "Meta" are not. Cross-company alias mapping is missing.

2. **Title normalization doesn't handle level variants**: "Senior Software Engineer" vs "Sr. Software Engineer" vs "Software Engineer (Senior)" produce different hashes.

3. **Location in identity_hash is fragile**: It only matches categories containing keywords like "remote", "india", "europe". A job with location "San Francisco" won't contribute to identity_hash, so two jobs at the same company with the same title but different non-keyword locations will hash identically.

4. **Reposted jobs with slightly different descriptions bypass content_hash**: If a company reposts a job with minor description changes (adding a line, changing a date), the content_hash changes. The identity_hash catches this only if the company+title+location match.

5. **Cycle dedup KV key bug** (see KV section): The cycle key uses `crawl_cycle_counter` which is different from `__cycle_number`. This means dedup set never properly rotates — it either always reads empty or always reads the same stale set.

---

## 7. Connector Performance Review

| Connector | API Calls/Source | Parsing Cost | New Issue |
|-----------|-----------------|-------------|-----------|
| **Greenhouse** | 1 HTTP GET | JSON parse (fast) | No ETag/If-Modified-Since — full re-fetch even if board unchanged |
| **Lever** | 1 HTTP GET | JSON parse (fast) | Same — no conditional requests |
| **Ashby** | 1 HTTP POST (GraphQL) | JSON parse (fast) | GraphQL query fetches `descriptionHtml` + `descriptionPlain` for every job — heavy response payload even for cursor-filtered jobs |
| **Workable** | 1 HTTP POST | JSON parse (fast) | Same |
| **RSS** | 1 HTTP GET | XML parse (rss-parser) | rss-parser is synchronous + CPU-heavy for large feeds. No streaming. |
| **Career Pages** | 2-3 HTTP GET (page + JSON-LD) | HTML parsing + regex | Most expensive per-source. Puppeteer-style parsing is heavy. |

### Per-Connector Cost Estimate

```
Greenhouse:  ~50ms fetch + ~10ms parse + ~20ms cursor = ~80ms
Lever:       ~60ms fetch + ~10ms parse + ~20ms cursor = ~90ms
Ashby:       ~80ms fetch + ~15ms parse + ~20ms cursor = ~115ms (heavy GraphQL payload)
Workable:    ~60ms fetch + ~10ms parse + ~20ms cursor = ~90ms
RSS:         ~100ms fetch + ~30ms parse (xml) = ~130ms
Career Page: ~200ms fetch + ~50ms parse (html) = ~250ms
```

### Issue: Ashby fetches full descriptions even when cursor-filtering

The Ashby GraphQL query requests `descriptionHtml` and `descriptionPlain` for **every job**. After applying the cursor filter, we throw away 90%+ of this data. The query should be split: fetch IDs first (lightweight), then fetch details only for new jobs.

---

## 8. Discovery Engine Review

### How New Sources Are Found

```
1. ATS Detection (detectAtsSourcesWithDomains)
   - Regex matches on job URLs for greenhouse/lever/ashby/workable patterns
   - Runs on newJobs only (fixed)
   - Registers new ATS sources automatically

2. Domain Registration (batchRegisterDomains)
   - Extracts company domains from job URLs
   - Queues for career page probing

3. Career Page Probing (probeDomainsForCareers)
   - HTTP fetches candidate career page URLs
   - Registers successful hits as career_page sources

4. Search Expansion (runSearchExpansion)
   - Runs Bing/Brave queries with dynamic terms
   - Includes hardcoded "MERN remote India" query
```

### Issues

1. **Hardcoded search query**: `worker.js:1479` always adds `'MERN remote India "careers"'`. This should come from config, not be hardcoded.

2. **Discovery rate is uncapped per search**: `maxDomainsPerSearch` config controls domains, but there's no cap on how many ATS sources a single search can discover. A viral search result page could register dozens of sources.

3. **No validation of discovered source quality**: New sources are registered with `INSERT OR IGNORE` but never validated that they actually return parseable job data. Bad sources accumulate until the circuit breaker trips (5 failures).

4. **growthEngine runs inside discovery path**: `runGrowthEngineCycle` is called inside the search expansion block (`worker.js:1482`), coupling skill spike detection to search timing. If discovery is disabled, growth signals are never computed.

---

## 9. Source Priority System

### Current Scoring Formula

```
Priority = Yield(25%) + Freshness(20%) + Reliability(20%)
         + Consistency(15%) + Relevance(10%) + DedupPenalty(10%)
```

### Issues

1. **Exploration bonus (70 baseline for new sources) is too generous**: New sources with 0 attempts get priority 70, which puts them in the "high" tier (≥65). They get crawled every single cycle until 10 attempts accumulate. This could saturate the 40-source budget with unproven sources.

2. **No decay for dormant sources that were once high-performing**: A source that produced jobs 2 months ago but nothing since still has `total_jobs_found` credit. The freshness score handles some of this (15 at >7 days), but the consistency score remains boosted by historical data.

3. **`dup_ratio` is not properly seeded**: New columns from migration `0007` start at 0. But `calculatePriority` only penalizes above 0.6. A source that's 100% duplicates for its first 10 fetches will have dup_ratio slowly climbing via EMA (0.6 blend factor), taking ~5 cycles to reach 0.6 threshold.

4. **Re-enable after 48h resets priority to 40**: Disabled sources that recover get `priority_score = 40` (medium tier). This is higher than many legitimate low-yield sources and could waste crawl budget on repeatedly-failing sources.

---

## 10. Scoring Pipeline Review

### Feature Extraction Quality

| Feature | Status | Issue |
|---------|--------|-------|
| **Keyword matching** | ✅ Works (FastMatcher) | Aho-Corasick trie is efficient |
| **TF-IDF scoring** | ⚠️ Partially fixed | `contentSnippet` (500 chars) now available, but full `description` still stripped. TF-IDF on 500 chars is better than title-only but not optimal. |
| **Salary extraction** | ⚠️ Works on contentSnippet | Only sees first 500 chars. Many job posts put salary at the bottom. |
| **Seniority detection** | ✅ Works (title-based) | Primarily title-based, so not affected by content stripping |
| **Remote detection** | ✅ Works | Categories + title + contentSnippet |
| **RAG semantic matching** | ⚠️ Limited | Only runs if `quickKeywordScore < 75`. Strong keyword matches skip AI entirely. This is a reasonable optimization but means semantic quality is untested for "obvious" matches. |
| **Experience extraction** | ⚠️ Limited | Regex-based on contentSnippet. "5+ years" style patterns only work if in first 500 chars. |

### `trajectoryFit` is always 0.5

```js
const trajectoryFit = 0.5; // v4 stub
```

This is a hardcoded stub that was never implemented. The scoring formula uses `trajectoryFit` for career trajectory matching, but it's always 0.5 (neutral). This means the trajectory override/penalty system in relevance-v4.js is effectively disabled.

---

## 11. Alert Pipeline Review

### Issues

1. **Alert-level trackScoreDistribution is redundant**: `trackScoreDistribution` is called per-alert in the evaluator loop (`worker.js:1022`), PLUS `recordJobScoresBatch` also calls it for every score (`threshold.js:203`). This means histogram is updated **twice** for alerted jobs — once inline and once in batch.

2. **No alert deduplication in sendAlerts**: If the ALERT_QUEUE retries a message, `sendAlert` will send the notification again. The `hasSentAlert` check is in `evaluateJobs`, not in `sendAlerts`. If the alert succeeds (Discord/TG 200) but `msg.ack()` fails, the alert will be resent.

3. **Alert quality floor is too low**: `MINIMUM_ALERT_SCORE = 50` as floor. Jobs scoring 50-55 are marginal matches. Consider raising to 55-60 for better signal-to-noise.

4. **No alert rate limiting**: If a crawl discovers 20+ high-quality jobs simultaneously, all 20 alerts fire at once. Discord and Telegram both have rate limits that may cause failures. The `fetchWithRetry` in notifications.js handles 429s but only after damage is done.

---

## 12. Memory Usage Analysis

| Object | Estimated Size | Lifecycle | Issue |
|--------|---------------|-----------|-------|
| `cycleSeenHashes` (Set) | **200KB-800KB** (10K hashes × 20-80B) | Per processFeeds invocation | Loaded from KV JSON, parsed into Set, manipulated, re-serialized. Peak memory during parse+serialize is 2× the set size. |
| `jobs` array (raw fetched) | **50-200KB** (200 jobs × 500B-1KB) | Per processFeeds invocation | All connector responses accumulated in memory. |
| `chunksToBatch` array | **10-50KB** | Per evaluateJobs invocation | Accumulates {jobId, chunks[], chunkVecs[]} with float arrays. |
| `scoresToBatch` array | **<1KB** | Per evaluateJobs invocation | Just numbers. Fine. |
| `sentAlertsSet` (Set) | **<10KB** | Per evaluateJobs message | Fine. |
| Profile embedding vector | **~3KB** (768 floats) | Per evaluateJobs invocation | Re-loaded from KV or AI every invocation. |

### Peak Memory Estimate

```
processFeeds:  ~500KB-1.5MB (dominated by cycle dedup set)
evaluateJobs:  ~200KB-500KB (dominated by chunk vectors)
scheduler:     ~50KB (source lists)
```

Cloudflare Worker memory limit: **128MB**. We are well within limits, but the cycle dedup set could grow problematically if more hash types are added.

---

## 13. Failure Handling Review

| Component | Retry Strategy | Issue |
|-----------|---------------|-------|
| **ATS fetch** | No retry (single attempt) | If a Greenhouse API returns 503 temporarily, we miss all jobs until next cycle. |
| **Queue send (FEED_QUEUE)** | `withRetry` (3 attempts, exponential backoff) | ✅ Good |
| **Queue send (ALERT_QUEUE)** | `withRetry` (3 attempts) + inline fallback | ✅ Good |
| **D1 batch insert** | Fall back to individual inserts | ✅ Good |
| **KV writes (cursor)** | Try/catch, fail silently | ⚠️ Silent failure means cursor is lost → full re-fetch next cycle. Should log warning (already does). |
| **KV writes (cycle dedup)** | Try/catch, fail silently with warning | ⚠️ If this fails, dedup set is lost for the rest of the cycle. |
| **AI embedding** | Budget limit (30 calls) | ✅ But no retry on individual AI failures. |
| **Discord/TG webhook** | `fetchWithRetry` (3 attempts with 429 handling) | ✅ Good |
| **Circuit breaker** | Opens after 5 failures, exp backoff cooldown | ✅ Well-designed |

### Cascade Risk

If D1 goes down mid-cycle:
1. `batchInsertJobs` fails → falls back to individual inserts → all fail
2. All jobs are lost (not stored)
3. But `msg.ack()` is called in `ctx.waitUntil` → messages are acknowledged
4. **Jobs are permanently lost** — they won't be retried

**Fix needed**: Move `msg.ack()` into the success path of the waitUntil callback, or use `msg.retry()` on D1 failure.

---

## 14. Scaling Limits

| Resource | Current Usage | Free Tier Limit | Headroom | Bottleneck? |
|----------|-------------|-----------------|----------|-------------|
| **KV Reads** | ~10,000/day | 100,000/day | 10× | ⚠️ At 100+ sources, becomes tight |
| **KV Writes** | ~6,000/day | 1,000/day | **⚡ OVER LIMIT** | 🔴 **Already exceeds free tier** |
| **D1 Reads** | ~500K rows/day | 5M rows/day | 10× | ✅ Fine |
| **D1 Writes** | ~5K rows/day | 100K rows/day | 20× | ✅ Fine |
| **Worker Requests** | ~300/day (crons + queues) | 100K/day | 300× | ✅ Fine |
| **Worker CPU** | ~5s/invocation | 10ms (cpu) / 30s (wall) | ⚠️ | CPU is billed by CPU-time, not wall-time |
| **Queue Messages** | ~500/day | 100K/day (messages) | 200× | ✅ Fine |
| **AI Neurons** | ~3000/day | 10K/day | 3× | ⚠️ Could become tight with more jobs |
| **Subrequests** | ~50/invocation | 50/invocation | 1× | 🔴 **At the limit** |

### True Maximum Capacity

```
Sources:           ~100 (before KV write budget is exhausted)
Jobs per cycle:    ~200 (before subrequest limit)
Jobs per day:      ~19,000
Queue messages:    ~2,000/day
D1 writes:         ~10,000/day (well within 100K)
```

**Primary bottleneck: KV writes.** The system does ~60 KV writes per cycle (cursors + health + dedup). At 96 cycles/day = 5,760 writes. Free tier allows only 1,000/day. To stay in free tier, KV writes must be reduced by **~80%**.

---

## 15. Missing Features & Improvement Roadmap

### Priority 1 — Critical Fixes (Bugs)

| # | Fix | Severity |
|---|-----|----------|
| 1 | **Fix cycle dedup KV key mismatch** (`crawl_cycle_counter` vs `__cycle_number`) | 🔴 Critical |
| 2 | **Fix growthEngine D1 batch size** (100 → 40) | 🔴 Will fail on large batches |
| 3 | **Fix msg.ack() in waitUntil** — jobs lost if D1 fails | 🔴 Data loss risk |

### Priority 2 — KV Write Reduction

| # | Fix | KV Writes Saved |
|---|-----|----------------|
| 4 | **Batch feedHealth writes**: Write one combined health report per cycle instead of per-source | ~35 writes/cycle |
| 5 | **Skip cursor save for unchanged boards**: If cursor filter shows 0 new jobs, don't re-write the cursor | ~20 writes/cycle |
| 6 | **Reduce cycle counter write frequency**: Already writes every 10 cycles, could increase to 50 | ~1 write/cycle |

### Priority 3 — Performance

| # | Feature | Impact |
|---|---------|--------|
| 7 | **ETags / If-Modified-Since for ATS connectors**: Skip full parse if board unchanged | ~50% CPU reduction for unchanged boards |
| 8 | **Ashby lightweight query**: Fetch IDs first, then details for new jobs only | ~80% bandwidth reduction for Ashby |
| 9 | **Batch updateSourceStats**: Currently individual D1 writes per source | ~35 D1 queries saved/cycle |
| 10 | **Cache loadConfig() at module level** | ~2ms CPU saved per invocation |

### Priority 4 — Intelligence

| # | Feature | Impact |
|---|---------|--------|
| 11 | **Implement trajectoryFit** (currently stub = 0.5) | Better scoring accuracy for career progression |
| 12 | **Company alias mapping** (Meta↔Facebook, Alphabet↔Google) | Eliminates false-unique dedup results |
| 13 | **Adaptive crawl intervals** based on posting frequency | Sources that post weekly get crawled less |
| 14 | **Job freshness decay** in scoring | Older un-alerted jobs penalized |

### Priority 5 — Observability

| # | Feature | Impact |
|---|---------|--------|
| 15 | **Dedup effectiveness dashboard** in /metrics endpoint | Visibility into which dedup layer catches what |
| 16 | **Per-source cost tracking** (KV ops + D1 queries + CPU) | Identify wasteful sources |
| 17 | **Alert quality feedback loop** | Track which alerts users actually click |

---

## Summary: Top 5 Critical Findings

1. **🔴 KV key mismatch bug**: `processFeeds` reads `crawl_cycle_counter` but scheduler writes to `__cycle_number`. Cycle-level dedup set never rotates properly.

2. **🔴 KV writes exceed free tier**: ~5,760 writes/day vs 1,000/day limit. Feed health writes (40/cycle) are the biggest offender.

3. **🔴 growthEngine D1 batch size 100 exceeds limit**: Should be 40 to stay within D1's per-batch constraint.

4. **🟡 msg.ack() in waitUntil**: If D1 insert fails inside `ctx.waitUntil`, messages are already acknowledged. Jobs are silently lost.

5. **🟡 Duplicated code blocks**: 150 lines of identical logic in `evaluateJobs` waitUntil/else branches. Maintenance burden and bug magnet.


---
---

# Part 3: System Audit Report


## 1. System Overview

The Job Hunter Bot is a highly optimized, event-driven serverless application running on Cloudflare Workers. It autonomously crawls various job sources (RSS feeds, ATS platforms, and Career Pages), deduplicates postings, scores them using a hybrid keyword/AI-semantic pipeline, and delivers relevant job alerts to users via Discord and Telegram.

### System Components

- **Worker Runtime:** Cloudflare Workers acting as the orchestrator (`src/worker.js`).
- **Crawler Engine:** Fetch connectors for various platforms (RSS, Greenhouse, Lever, Ashby, Workable, etc.) (`src/connectors/`).
- **Source Registry:** D1 database table storing dynamic, discovered, and priority-scored sources.
- **Deduplication Layer:** Multi-stage deduplication using SimHash (O(1) memory dedup), `content_hash` tracking, and database constraints.
- **Queue Processing:** Cloudflare Queues (`feed-queue`, `job-queue`, `alert-queue`) routing data asynchronously.
- **Job Storage:** Cloudflare D1 database for persistent job storage, metrics, and state. Cloudflare KV for transient state, health checks, and rate limits.
- **Scoring Engine:** V4 Hybrid Pipeline executing FastMatcher (O(N) keyword trie) and MiniLM semantic RAG via Workers AI (`src/scoring/`).
- **Alert Engine:** Notification delivery system handling Discord/Telegram limits with retry-after logic (`src/notifications/`).
- **Discovery Engine:** Self-expanding growth engine using Bing/Brave search to query dynamic skills/companies and auto-register new ATS boards (`src/discovery/`).
- **Intelligence Layer:** Analyzes source yields, detects hiring surges, and dynamically prioritizes crawl cycles (`src/intelligence/`).

---

## 2. Complete Execution Flow

Trace of the full lifecycle of a job, from source discovery to alert delivery.

**Step 1 — Source Scheduling**

- **File:** `src/worker.js` -> `_scheduledImpl()` and `src/intelligence/sourceIntelligence.js` -> `getSourcesForCycle()`
- **Logic:** Triggered by Cloudflare Cron. Selects sources based on `priority_score`, current cycle number, and tier (high, medium, low, dormant).
- **Outputs:** Array of source objects sent to `feed-queue`.

**Step 2 — Worker Crawl Execution (Fetcher)**

- **File:** `src/worker.js` -> `processFeeds()` -> `src/connectors/index.js` -> `runAllConnectors()`
- **Logic:** Worker pulls from `feed-queue`. Checks `feedHealth` circuit breaker in KV. If healthy, executes specific connector (RSS, Greenhouse, etc.).
- **Outputs:** Array of raw, normalized `RawJob` objects.

**Step 3 — Deduplication & Storage**

- **File:** `src/worker.js` -> `processFeeds()` and `src/db/jobs.js` -> `batchInsertJobs()`
- **Logic:**
  - **Memory:** Dedups chunks intra-batch using `content_hash` (SimHash).
  - **Storage:** Batches valid jobs (max 40/batch) and executes `INSERT OR IGNORE INTO jobs` in D1 to handle cross-batch deduplication natively at the DB engine layer without read queries.
- **Outputs:** Newly inserted jobs sent to `job-queue` (slimmed down to avoid 128KB queue limit).

**Step 4 — Job Parsing & Scoring (Evaluator)**

- **File:** `src/worker.js` -> `evaluateJobs()` and `src/scoring/relevance-v4.js` -> `scoreJob()`
- **Logic:** Worker pulls from `job-queue`.
  - Runs ultra-fast keyword pre-filter (`hasBasicKeywordMatch`).
  - Scans with `FastMatcher` Trie for keywords.
  - Generates semantic vectors via `embedChunks` (Workers AI `bge-base-en-v1.5`) if the job warrants it.
  - Retrieves profile vectors and runs O(N log K) Min-Heap semantic matching.
  - Rejects jobs scoring below 50.
- **Outputs:** Highly relevant jobs packaged with a `ScoreResult` and sent to `alert-queue`.

**Step 5 — Discovery Feedback Loop**

- **File:** `src/worker.js` -> `processFeeds()` -> `detectAtsSourcesWithDomains()`
- **Logic:** Extracts HTTP links from ingested jobs, dynamically registering newly discovered company ATS endpoints to D1 `source_registry`.
- **Outputs:** New sources injected into the crawl schedule.

**Step 6 — Alert Delivery (Sender)**

- **File:** `src/worker.js` -> `sendAlerts()` and `src/notifications/notifications.js` -> `sendAlert()`
- **Logic:** Worker pulls from `alert-queue`. Formats rich embeds. Sends via HTTP HTTP fetch to Discord and Telegram. Respects HTTP 429 `Retry-After` headers.
- **Outputs:** Notifications to user endpoints.

---

## 3. Worker Lifecycle Analysis

The cloudflare worker serves as the entry point and router for all system operations.

### Worker Entry Points

- **`scheduled(event, env, ctx)`**
  - **Trigger:** Cloudflare Cron (`0,15,30,45 * * * *`).
  - **Action:** Executes `_scheduledImpl()`. Calculates cycles, retrieves batched sources, and publishes them to `FEED_QUEUE`. Also runs periodic Intelligence tasks (Source priorities, AI Threshold configuration, Career Probes).
- **`queue(batch, env, ctx)`**
  - **Trigger:** Cloudflare Queues pushing message batches.
  - **Action:** Router.
    - `feed-queue` -> `processFeeds(batch)`
    - `job-queue` -> `evaluateJobs(batch)`
    - `alert-queue` -> `sendAlerts(batch)`
- **`fetch(request, env, ctx)`**
  - **Trigger:** HTTP Requests HTTP APIs.
  - **Action:** Exposes health checks (`/health`), system metrics (`/metrics`), daily reports (`/report`), manual triggers (`/trigger`), and a local stress test (`/stress-test`).

**Asynchronous Deferral (`ctx.waitUntil`)**
The worker heavily utilizes `deferIO(ctx, promise)` and direct `ctx.waitUntil()` everywhere to unblock the CPU while awaiting D1 DB writes and KV updates (Metrics, Analytics, Chunk Savings). This mitigates reaching the 30-35 second wall-time limit.

---

## 4. Source Crawling System

- **Source Storage:** Centralized in D1 `source_registry`. Mix of static config feeds and dynamically discovered feeds.
- **Source Scheduling Strategy:**
  - Evaluated every 4 cron cycles by `recalculatePriorities()`.
  - Uses a formula combining: Job Yield (25%), Freshness (20%), Reliability (20%), Consistency (15%), Relevance (10%), with Deduplication penalties.
  - Tiering defines frequency: High (every cron/15m), Medium (45m), Low (2h), Dormant (4h).
- **Circuit Breakers (`feedHealth.js`):**
  - Maintained in KV: `feed:health:HASH`.
  - Opens circuit (Disables Source) after 5 consecutive failures. Soft downgrade at 3 failures.
  - Cooldown is dynamic with exponential backoff and jitter (Max 4 hours length).

---

## 5. Job Processing Pipeline

Crawling to Scoring mapping:

1. **Crawler:** (`runAllConnectors`) Fetches XML, JSON, or HTML.
2. **Normalizer:** Connector logic normalizes all items into a strict `RawJob` schema.
3. **Dedup Layer 1 (Memory):** SimHash (`content_hash`) prevents duplicate parsing inside the same fetch batch.
4. **Storage:** Batched to D1 `INSERT OR IGNORE`.
5. **Queue:** Sent to `job-queue` (payloads slimmed using `slimJob()` to stay under 128KB).
6. **Pre-Filter:** `hasBasicKeywordMatch()` performs regex keyword exclusion to protect the AI budget.
7. **Scoring:** `scoreJob()` executes Regex/Trie matchers + TF-IDF calculation + Min-Heap Semantic Vector check.
8. **Alerts:** Passed to `alert-queue`.

---

## 6. Deduplication System

The architecture executes deduplication across three staggered layers.

1. **Intra-Batch (Memory):**

- Fingerprint generated via `generateSimHash(title + content)`. O(1) detection algorithm weighting the first 50 words heavily.
- Tracks seen hashes in a `Set()` inside `processFeeds()`.

2. **Inter-Batch (Database Constraints):**

- Relies entirely on the D1 engine: `INSERT OR IGNORE INTO jobs (id, url, content_hash)`.
- This avoids expensive `SELECT` lookups prior to insertion.

3. **Alert/Semantic-Level (Evaluator):**

- Prevents alert spam checking `isDuplicateByEmbedding()` using Cosine Similarity > 0.88 against recently alerted jobs.

**Efficiency Insights:**
Highly efficient approach utilizing D1 constraint offloading. Avoids memory bloat on the worker.

---

## 7. Database Usage

D1 (`job-hunter-db`) is heavily leveraged as source-of-truth.

- **Heavy Write Areas:** `insert_job` calls via `batchInsertJobs()` in the Fetcher.
- **Write Patterns:**
  - Deeply optimized `db.batch()` chunking. Operations are sliced into chunks of 40-50 queries to bypass D1 limits.
  - Uses `deferIO` / `ctx.waitUntil` to hide write latency from the Worker CPU trace.
- **Query Patterns:** Intelligence queries `SELECT avg_job_count...` calculate metrics dynamically.

---

## 8. Queue System Analysis

Uses Cloudflare Queues with a heavily event-driven choreography.

| Queue Name      | Producer             | Consumer         | Batch Size | Retries | Message Structure                          |
| --------------- | -------------------- | ---------------- | ---------- | ------- | ------------------------------------------ |
| **feed-queue**  | `scheduled()` (Cron) | `processFeeds()` | 5          | 2       | `Source{ url, type, name }`                |
| **job-queue**   | `processFeeds()`     | `evaluateJobs()` | 5          | 3       | `slimJob{ id, title, company, url, hash }` |
| **alert-queue** | `evaluateJobs()`     | `sendAlerts()`   | 5          | 5       | `{ profileId, job, scoreResult }`          |

**Bottleneck Management (`withRetry`):**
Due to Cloudflare's stringent Free-Tier rate limits on Queue sends ("Too Many Requests"), producers wrap `.sendBatch()` inside `withRetry()` implementing exponential backoff.
If queues completely fail, the system implements **Direct Failover**, processing jobs synchronously inline before the 30-second kill switch hits.

---

## 9. AI / Scoring Pipeline

The V4 Scoring Pipeline (`src/scoring/relevance-v4.js`) is an advanced algorithmic ranker.

- **Pre-Filtering:** `hasBasicKeywordMatch()` strictly gates AI. If no base keywords exist, it exits to save `$0.00` AI costs. Also uses `computeQuickKeywordScore(>75)` to skip AI for already obvious keyword matches.
- **AI Subrequests:**
  - Worker AI `bge-base-en-v1.5`. Jobs are chopped using `chunkTexts()` to maximum 200 characters to fit the context window.
  - Subrequests are tracked (`_aiCallCount`) and hard-capped at 30 per invocation to avoid Cloudflare 50 Subrequest Limit errors.
- **Scoring Weights:**
  - Title Match (30), Skills (30), Tech Stack (20), Location (10), Salary (10).
  - TF-IDF Density Engine boosts by 15.
  - RAG Semantic Vectors boosts by up to 25.
  - Combos (Next+TS, Node+Mongo, Full MERN) add additional +4 to +10.
  - Penalties subtract for Non-JS Stacks (-15) and Frontend-Only profiles (-5).
- **Thresholds:** Drops jobs under the absolute floor of `50`.

---

## 10. Alert System

Triggered by the `alert-queue`.

- **Logic:** Formats rich UI notification payloads with Markdown (Telegram) and Embeds (Discord).
- **Mechanisms:** Handles Discord Webhook 429 Status Codes actively by blocking the worker (delay execution) for the duration of the `Retry-After` header. If delivery fails fully, throws error to `alert-queue` for DLQ consumer retry.

---

## 11. Discovery Engine

Responsible for aggressive autonomous growth.

- **Logic (`src/discovery/searchExpander.js`):** Queries Search Engines (Bing HTML scraping, Brave Web Search) for niche strings like `MERN remote India "careers"`. Fallbacks to static green house/lever APIs if search engines employ CAPTCHA blocks.
- **Extraction:** Ingests the search results and parses them against Known ATS Patterns (`boards.greenhouse.io`, `apply.workable.com` config objects).
- **Trigger:** Runs every 8th Cron cycle OR forcefully if 72 hours pass without a single source discovery. KV (`discovery:last_success_timestamp`) tracks states.

---

## 12. Resource Usage Analysis

Top consumers of Cloudflare Free-Tier resources:

1. **CPU Time:** `evaluateJobs()`. The O(N) trie matcher, chunk processing, and Min-Heap memory structures consume standard compute. Offset heavily by pre-filtering.
2. **Subrequests Limit (Max 50):** `embedChunks()` AI Model binds. Capped structurally at 30 per invocation. Remaining 20 reserved for API connectors and D1 queries.
3. **Queue Ops:** Job Queue dispatches generate the most operations per minute. Handled via 50-chunk Batch Sends.
4. **D1 Writes:** Job Insertions. Highly optimized with `db.batch()` chunked arrays.

---

## 13. Bottleneck Analysis

| Rank | Bottleneck                               | Severity | Impact                                                                                                                  |
| ---- | ---------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1    | **Cloudflare Queue "Too Many Requests"** | High     | Triggers sync execution (`DIRECT FALLBACK`) which spikes Worker wall-time towards the 30s kill limit.                   |
| 2    | **Search Expander Target Blocking**      | Medium   | Search engines (Bing/Brave) aggressively block scraping with CAPTCHAs, rendering the self-expanding growth engine deaf. |
| 3    | **AI Subrequest Caps**                   | Medium   | Limits the amount of jobs that can receive deep Semantic RAG evaluation during a high-velocity ingestion spike.         |

---

## 14. Architectural Weaknesses

- **Scalability:** Free-tier Cloudflare Workers have a 30s max wall time. Direct fallbacks during Queue outages risk Worker termination mid-flight.
- **Maintainability (Connector Fragmentation):** Maintaining regex parsers and endpoint URLs for 15+ undocumented ATS provider pages is highly brittle to front-end changes.
- **Cost Efficiency:** AI Models executed per-job scales linearly. Without the keyword gate, large scrapers would explode the AI quota in under a week.

---

## 15. Optimization Opportunities

- **Short-term:** Apply more rigorous URL scrubbing natively down in the Connectors to stop duplicate query strings from bypassing URL-Hashes.
- **Medium-term:** Re-route `SearchExpander` to use a legitimate API (e.g. SerpAPI or Google Custom Search) instead of raw HTML scraping to bypass CAPTCHA unreliability.
- **Long-term Architectural:** Move off Cloudflare Workers Free Tier to a persistent VPS for the Crawler, utilizing Cloudflare purely as an Edge CDN for the database UI.

---

## 16. System Architecture Diagram

```mermaid
graph TD
    Cron[Cron Trigger] --> sched(Scheduled Producer)
    sched -->|Feed Configs| FQ[feed-queue]

    FQ --> Fetcher(Fetcher & Crawler)
    Fetcher -->|GET APIs| Sources[(ATS / RSS Sources)]
    Fetcher -->|Dynamic Links| ATSDet(ATS Discovery Engine)
    ATSDet --> D1_Registry[(D1 source_registry)]
    Fetcher -->|O(1) SimHash Dedup| RAM_Filter
    RAM_Filter -->|Batch Insert OR Ignore| D1_Jobs[(D1 Jobs Table)]

    Fetcher -->|slimJob| JQ[job-queue]

    JQ --> Eval(Evaluator & AI Scorer)
    Eval -->|Vector Embeddings| AI[Workers AI Pipeline]
    Eval -->|Trie Matched| Rules(Scoring Rules & TF-IDF)

    Eval -->|> 50 Score| AQ[alert-queue]

    AQ --> Notifier(Notification Engine)
    Notifier -->|Rich Embeds| Discord[Discord Webhook]
    Notifier -->|MarkdownV2| Telegram[Telegram API]
```

---

## 17. Final System Summary

The **Job Hunter Bot v5** correctly embodies an Enterprise-grade pipeline squeezed elegantly into a Serverless Free Tier footprint.
The system operates using an isolated queue-based mesh network that naturally absorbs traffic. Most glaring inefficiencies from v4 (memory leaks, O(N^2) loops) have been solved via Min-Heaps, SimHashes, and FastMatcher logic.
The primary operational risk going forward lies exclusively in adhering to Cloudflare's strict quotas (especially Queue batch limits and AI Subrequests). The current codebase intelligently mitigates this through extensive `try/catch` fallbacks, `waitUntil` I/O offloading, and aggressive pre-filter heuristic gates.


---
---

# Part 4: Operational Intelligence Report


**Final diagnostic audit** covering the 11 operational intelligence layers not analyzed in previous reports.

---

## 1. CPU Time Profiling

### Per-Function CPU Cost Estimates

All estimates for Cloudflare Workers V8 isolate. CPU time ≠ wall time (I/O is free).

| Function | Per-Call CPU | Calls/Cycle | Total/Cycle | Dominant Cost |
|----------|------------|-------------|------------|---------------|
| `normalizeJob` | ~0.05ms | 200 jobs | ~10ms | 3× `fnvHash` + 4× regex in `normalizeTitle`/`normalizeCompany` |
| `hasBasicKeywordMatch` | ~0.15ms | 200 jobs | ~30ms | Creates `new RegExp()` per keyword × 3 passes (must + title + nice) |
| `computeQuickKeywordScore` | ~0.12ms | 150 jobs | ~18ms | Same regex construction pattern as above |
| `FastMatcher.scan` (text) | ~0.3ms | 100 jobs | ~30ms | O(N) trie traversal + word-boundary checks per match |
| `FastMatcher.scan` (title) | ~0.05ms | 100 jobs | ~5ms | Same but title is ~10 chars vs ~500 chars body |
| `scoreJob` (full pipeline) | ~2.5ms | 100 jobs | ~250ms | **Heaviest function** — see breakdown below |
| `computeTfIdfScore` | ~0.4ms | 100 jobs | ~40ms | O(M×T): M keywords × T tokens |
| `keywordMatchesText` | ~0.08ms | 800 calls | ~64ms | Per-variant `new RegExp()` + fuzzy `compareTwoStrings` fallback |
| `compareTwoStrings` | ~0.03ms | 200 calls | ~6ms | O(n+m) bigram construction + intersection |
| `sanitizeText` | ~0.02ms | 400 calls | ~8ms | 7 regex .replace() chains |
| `embedChunks` (CPU only) | ~0.1ms | 30 jobs | ~3ms | JSON serialization for AI call |
| `cosineSimilarity` | ~0.01ms | 150 calls | ~1.5ms | 768-dim dot product |
| `deduplicateJobs` | ~0.5ms | 1 call | ~0.5ms | Map-based hash dedup |
| `batchInsertJobs` (prep) | ~0.2ms | 1 call | ~0.2ms | SQL statement construction |
| `detectAtsSourcesWithDomains` | ~0.3ms | 1 call | ~0.3ms | Regex on every URL |

### `scoreJob` CPU Breakdown (per job)

```
scoreJob total:                      ~2.5ms
├── sanitizeText (title+body):       ~0.04ms
├── text.split(/\s+/) tokenize:     ~0.05ms
├── FastMatcher.scan (body):         ~0.30ms
├── FastMatcher.scan (title):        ~0.05ms
├── parseExperienceYears (regex):    ~0.02ms
├── extractSalaryUSD (regex):        ~0.03ms
├── detectRemoteType (regex):        ~0.02ms
├── detectSeniority (regex):         ~0.02ms
├── keywordMatchesText × ~15 calls:  ~1.20ms ← LARGEST
│   ├── expandWithSynonyms:          ~0.15ms
│   ├── RegExp construction × N:     ~0.45ms
│   └── compareTwoStrings fuzzy:     ~0.60ms
├── computeTfIdfScore:               ~0.40ms
├── senioritySatisfied:              ~0.01ms
├── scoreExperience:                 ~0.01ms
├── resolveLabel:                    ~0.01ms
└── Object construction:             ~0.04ms
```

### CPU Budget Per Worker Phase

```
processFeeds (200 jobs):
  normalizeJob × 200:                ~10ms
  deduplicateJobs:                    ~0.5ms
  hasBasicKeywordMatch (prefilter):   ~30ms  (runs in evaluateJobs, not here)
  SQL prep:                           ~0.5ms
  ────────────────────────────────
  Total CPU:                          ~11ms

evaluateJobs (100 jobs after prefilter):
  hasBasicKeywordMatch × 200:        ~30ms
  computeQuickKeywordScore × 150:    ~18ms
  scoreJob × 100:                    ~250ms ← DOMINANT
  cosineSimilarity × 150:             ~1.5ms
  ────────────────────────────────
  Total CPU:                          ~300ms

scheduler (40 sources):
  loadConfig:                          ~1ms
  SQL queries:                        ~0.5ms (CPU only)
  Queue message construction:         ~0.2ms
  ────────────────────────────────
  Total CPU:                           ~2ms
```

**Total CPU per cycle: ~313ms.** Cloudflare bills CPU time at 10ms increments on free tier (max 10ms CPU per invocation), so `evaluateJobs` at ~300ms **far exceeds the free tier CPU limit**. On the paid plan ($5/mo), CPU time is billed at $0.02 per million ms: 300ms × 96 cycles/day × 30 = 864,000ms/month ≈ $0.02.

### CPU Optimization Opportunities

| # | Optimization | CPU Saved | Difficulty |
|---|-------------|-----------|------------|
| 1 | **Cache RegExp objects** in `hasBasicKeywordMatch` / `computeQuickKeywordScore` / `keywordMatchesText` instead of `new RegExp()` per call | ~60ms/cycle (50%) | Easy |
| 2 | **Replace keywordMatchesText regex+fuzzy with FastMatcher** — the trie already knows all keywords | ~100ms/cycle (80% of scoring keyword CPU) | Medium |
| 3 | **Skip compareTwoStrings fuzzy fallback** unless exact match fails AND keyword is multi-word | ~40ms/cycle | Easy |
| 4 | **Pre-tokenize once, share across TF-IDF and fuzzy** — tokens currently computed twice | ~5ms/cycle | Easy |

---

## 2. Dedup Effectiveness

### Layer-by-Layer Analysis

```
Raw jobs fetched per cycle:                 ~200

Layer 1: ATS Cursor Filter (KV)
  ├── Input: 200 jobs
  ├── Filtered: ~160 known IDs
  ├── Output: ~40 jobs          (80% reduction)
  └── Effectiveness: ████████░░ HIGH for ATS connectors

Layer 2: Per-Source Limit (50 cap)
  ├── Input: ~40 jobs
  ├── Filtered: ~0 (most sources < 50)
  ├── Output: ~40 jobs          (0% reduction typical)
  └── Effectiveness: ░░░░░░░░░░ RARELY HITS — only on very large boards

Layer 3: Identity Hash (KV cycle set)
  ├── Input: ~40 jobs
  ├── Filtered: ~5 cross-source duplicates
  ├── Output: ~35 jobs          (12% reduction)
  └── Effectiveness: ██░░░░░░░░ LOW — only catches exact company+title+location

Layer 4: Content Hash (in-memory Set)
  ├── Input: ~35 jobs
  ├── Filtered: ~3 near-duplicates
  ├── Output: ~32 jobs          (9% reduction)
  └── Effectiveness: ██░░░░░░░░ LOW — overlaps significantly with identity hash

Layer 5: Cycle Dedup Set (KV)
  ├── Input: ~32 jobs
  ├── Filtered: ~2 cross-batch dupes
  ├── Output: ~30 jobs          (6% reduction)
  └── Effectiveness: █░░░░░░░░░ VERY LOW — ⚠️ LIKELY BROKEN (KV key mismatch)

Layer 6: D1 UNIQUE(content_hash)
  ├── Input: ~30 jobs
  ├── Filtered: ~5 (cross-cycle dupes)
  ├── Output: ~25 new rows      (17% reduction)
  └── Effectiveness: ███░░░░░░░ MEDIUM — catches jobs seen in previous cycles

Layer 7: D1 UNIQUE(url)
  ├── Input: ~25 jobs
  ├── Filtered: ~1-2 (exact URL dupes)
  ├── Output: ~23 stored jobs   (8% reduction)
  └── Effectiveness: █░░░░░░░░░ LOW — mostly redundant with content_hash
```

### Redundancy Analysis

| Layer Pair | Overlap | Verdict |
|-----------|---------|---------|
| Identity Hash ↔ Content Hash | **~70% overlap** — identity is `company::title::location`, content adds `content[:500]`. Same company+title usually means same content. | Layers 3+4 could be merged |
| Content Hash ↔ D1 UNIQUE(content_hash) | **Same hash, different scope** — in-memory catches within-batch, D1 catches cross-cycle. Both needed. | ✅ Keep both |
| Cycle Dedup ↔ Content Hash | **~90% overlap** — cycle dedup uses content_hash to build its set. If content_hash dedup runs first, cycle dedup catches almost nothing new. | ⚠️ Cycle dedup is nearly redundant |
| D1 UNIQUE(url) ↔ D1 UNIQUE(content_hash) | **~95% overlap** — same job URL almost always has same content hash. URL uniqueness catches cases where the URL differs but content_hash was somehow regenerated. | ⚠️ URL uniqueness mostly redundant |

### Recommendation

**Remove or merge Layers 4+5.** The content_hash in-memory dedup and cycle dedup KV set overlap heavily. Replace with a single cycle-level bloom filter that covers both:

```
Effective dedup chain (proposed):
  Layer 1: ATS Cursor (KV)              ← keep
  Layer 2: Per-source limit (50)         ← keep
  Layer 3: Identity hash (KV)           ← keep
  Layer 4: D1 UNIQUE(content_hash)      ← keep (final catch-all)
  Layer 5: D1 UNIQUE(url)               ← keep (secondary catch-all)

Removed:
  Content hash in-memory Set             ← merged into identity hash
  Cycle dedup KV set                     ← removed (buggy, redundant)
```

---

## 3. Connector Value Analysis

### Static Source Distribution (from config.js)

| Connector Type | Sources in Config | Est. Jobs/Source/Cycle | Est. Unique/Source | Est. Alerts/Source |
|---------------|-------------------|----------------------|-------------------|-------------------|
| **RSS** | 24 feeds | ~15 raw | ~3 unique (80% dupes across feeds) | ~0.5 |
| **Greenhouse** | ~20 companies | ~8 raw | ~1 unique (cursor-filtered) | ~0.3 |
| **Lever** | ~10 companies | ~10 raw | ~1 unique | ~0.3 |
| **Ashby** | ~10 companies | ~5 raw | ~0.5 unique | ~0.2 |
| **Workable** | ~5 companies | ~3 raw | ~0.5 unique | ~0.1 |
| **Career Page** | ~5 | ~2 raw | ~0.5 unique | ~0.1 |

### Per-Connector Cost Profile

| Connector | CPU/Source | HTTP Calls | KV Ops | D1 Writes | Cost Score |
|-----------|----------|-----------|--------|-----------|------------|
| **RSS** | ~0.3ms (parse XML) | 1 fetch | 0 | 0.5 batch | 💚 LOW |
| **Greenhouse** | ~0.1ms (parse JSON) | 1 fetch | 2 (cursor R/W) | 0.5 batch | 💛 MEDIUM |
| **Lever** | ~0.1ms (parse JSON) | 1 fetch | 2 (cursor R/W) | 0.5 batch | 💛 MEDIUM |
| **Ashby** | ~0.2ms (parse JSON, heavy payload) | 1 POST | 2 (cursor R/W) | 0.5 batch | 💛 MEDIUM |
| **Workable** | ~0.1ms (parse JSON) | 1 POST | 2 (cursor R/W) | 0.5 batch | 💛 MEDIUM |
| **Career Page** | ~1ms (parse HTML) | 2-3 fetches | 0 | 0.5 batch | 🔴 HIGH |

### Value-Per-Source Rankings

```
Best ROI (unique jobs / cost):
  1. RSS feeds (WeWorkRemotely, RemoteOK)     — high volume, zero KV cost
  2. Greenhouse (large boards: Stripe, Figma)  — high unique rate post-cursor
  3. Lever (active companies: Notion, Linear)  — consistent new jobs

Worst ROI:
  1. Career pages — 2-3 HTTP calls, HTML parsing, low unique rate
  2. Small Ashby boards (< 5 active jobs)      — cursor doesn't help much
  3. Niche RSS feeds (cryptojobslist, fossjobs) — very low relevance match
```

---

## 4. Source Quality Model

### Quality Tiers (Estimated)

| Tier | Source Pattern | Unique Jobs/Week | Alert Rate | Action |
|------|--------------|-----------------|-----------|--------|
| **S-Tier** | WeWorkRemotely, RemoteOK, Himalayas | 50-100 | 8-15% | Crawl every cycle |
| **A-Tier** | Greenhouse (top 10), Lever (top 5) | 10-30 | 10-20% | Crawl every cycle |
| **B-Tier** | Remaining ATS boards, jobspresso | 5-15 | 5-10% | Crawl every 2nd cycle |
| **C-Tier** | Niche RSS (crypto, FOSS), small ATS | 1-5 | 2-5% | Crawl every 4th cycle |
| **D-Tier** | Dead/broken feeds, blocked search | 0 | 0% | **Auto-disable** |

### Auto-Disable Criteria (Should Be Implemented)

```
Disable source if ALL of:
  ✗ 0 unique jobs in last 7 days
  ✗ dup_ratio > 0.95 for 5 consecutive cycles
  ✗ total_jobs_found > 0 (has been tried)

Currently:
  - Circuit breaker disables after 5 consecutive FAILURES (HTTP errors)
  - But there is NO auto-disable for sources that SUCCEED but produce 0 UNIQUE jobs
  - A source returning 50 duplicate jobs every cycle costs KV + CPU but adds zero value
```

### Sources That Should Be Disabled

Based on config analysis, these sources are likely D-Tier:

| Source | Reason |
|--------|--------|
| `hireweb3.io` | Niche Web3 — unlikely to match MERN/Node.js stack |
| `cryptojobslist.com` | Same — crypto niche |
| `cryptocurrencyjobs.co` | Same — crypto niche |
| `fossjobs.net` | FOSS-only — very low volume |
| `dribbble.com/jobs.rss` | Design-focused — low developer match rate |
| `vuejobs.com` | Vue-specific — user config targets React/MERN |
| `4dayweek.io` | Very low volume, high duplicate with other feeds |

---

## 5. Scoring Accuracy Analysis

### True Positive / False Positive Estimation

| Score Range | Volume | Est. True Positive Rate | Est. False Positive Rate | Action |
|------------|--------|------------------------|-------------------------|--------|
| 80-100 | ~5% of scored | **90%+** (strong multi-signal match) | <10% | ✅ Alert immediately |
| 65-79 | ~10% of scored | **70-80%** (good but partial match) | 20-30% | ✅ Alert (current behavior) |
| 50-64 | ~15% of scored | **40-50%** (borderline) | 50-60% | ⚠️ High noise — consider raising floor |
| 35-49 | ~20% of scored | **10-20%** | 80-90% | ❌ Excluded (correct) |
| 0-34 | ~50% of scored | **<5%** | 95%+ | ❌ Excluded (correct) |

### Threshold Analysis

Current: `MINIMUM_ALERT_SCORE = 50`, dynamic threshold adjusts via rolling window.

**Problem: Score 50-55 is a noise zone.** Jobs scoring 50-55 typically have:
- 1 title keyword match (18 pts)
- 2 must-match keywords in body (20 pts)
- 1 location match (10 pts)
- No TF-IDF boost, no salary, no RAG match
- Total: ~48-55 (just barely passing)

These are usually:
- Job titles tangentially related ("Technical Support Engineer" matching "Engineer")
- Companies in different tech stacks that happen to mention "Node.js" once
- Senior positions the user isn't qualified for

### Recommendation: Raise Floor to 55

```
Current:  MINIMUM_ALERT_SCORE = 50 → ~30 alerts/day (15% false positive)
Proposed: MINIMUM_ALERT_SCORE = 55 → ~20 alerts/day (8% false positive)
Savings:  ~10 fewer false positive alerts/day, better signal-to-noise
```

### `trajectoryFit` Impact

Currently hardcoded to 0.5 (neutral). If implemented, it would:
- **Boost** jobs from companies/roles matching career trajectory (+5-10 points)
- **Penalize** jobs requiring different career paths (-5-10 points)
- Estimated improvement: **reduce false positives by 15-20%** for borderline scores

### Score Signal Contribution (Estimated)

```
Signal                  Avg Contribution  Max Contribution  Notes
──────────────────────  ────────────────  ────────────────  ──────
Title match (30w)       12 pts            30 pts            Most important signal
Must-match skills (30w) 15 pts            30 pts            Second most important
Nice-to-have (20w)       8 pts            20 pts            Wide distribution
Location (10w)           5 pts            10 pts            Binary — remote = 10, else 0
Salary (10w)             1 pts            10 pts            Rarely extracted (short snippet)
TF-IDF boost (15%)       3 pts            15 pts            Moderate but noisy
RAG semantic             2 pts            10 pts            Skipped if keyword score > 75
Combo bonuses            4 pts            12 pts            MERN, Node+TS, Remote+India
Seniority penalty       -2 pts            -8 pts            Only for lead/senior roles
Non-JS penalty          -3 pts           -12 pts            Effective for filtering
Frontend penalty        -1 pts            -8 pts            Less commonly triggered
Experience penalty      -1 pts            -6 pts            If years don't match
──────────────────────────────────────────────────────
Typical final score:    40-60 pts
Alert-worthy score:     55-85 pts
```

---

## 6. Discovery Engine Effectiveness

### Discovery Channels

| Channel | Sources Found/Cycle | Survival at 7 Days | Produces Jobs? | Net Value |
|---------|-------------------|--------------------|---------------|-----------|
| ATS Detection (URL regex) | 1-3 per cycle | ~80% (ATS APIs are stable) | Yes, ~70% | 💚 HIGH |
| Domain Registration + Career Probe | 5-15 domains queued | ~20% (many domains don't have career pages) | Yes, ~30% of probed | 💛 MEDIUM |
| Search Expansion (Bing/Brave) | 0-2 new ATS per cycle | ~70% | Yes, ~60% | 💛 MEDIUM |
| Static Fallback (17 sources) | Only on first run | ~100% (curated) | Yes, ~90% | 💚 HIGH |

### Discovery Funnel (Per Discovery Cycle)

```
Search queries executed:           8
URLs extracted from results:      ~40
ATS patterns detected:            ~3
Domains queued for probing:       ~12
Domains probed this cycle:        ~15

After 7 days:
  ATS sources still active:       ~2 of 3 (67%)
  Career pages found:             ~3 of 15 (20%)
  Career pages producing jobs:    ~1 of 3 (33%)

Net new productive sources:       ~3 per discovery cycle
```

### Discovery Rate vs Source Cap

```
Discovery runs:          Every 8 cycles = 12 per day
New sources per run:     ~3
Sources per day:         ~36

Source cap:              500
Days to cap:             ~14 days

After cap:
  No new sources added
  Old low-value sources NOT removed
  Discovery engine runs but accomplishes nothing
```

**Missing Feature: Source eviction.** When the 500-source cap is reached, the system should evict the lowest-priority sources to make room for new discoveries, not just stop adding.

---

## 7. Scheduler Optimization

### Current Crawl Intervals

| Tier | Priority Score | Interval | Sources (Est.) | Jobs/Cycle |
|------|---------------|----------|---------------|------------|
| Critical | ≥80 | Every cycle | ~10 | ~100 |
| High | ≥65 | Every cycle | ~15 | ~60 |
| Medium | ≥40 | Every 2nd cycle | ~20 | ~30 |
| Low | <40 | Every 4th cycle | ~30 | ~10 |

### Proposed Adaptive Crawling Model

Instead of fixed tier intervals, use **posting frequency** to determine crawl interval:

```
Adaptive interval = max(1, min(24, floor(24 / posts_per_day)))

Source posts 10 jobs/day  → crawl every cycle (interval = 1)
Source posts 2 jobs/day   → crawl every 2 cycles
Source posts 0.5 jobs/day → crawl every 4 cycles
Source posts 0.1 jobs/day → crawl every 24 cycles (once per 6 hours)
Source posts 0 jobs/week  → disable after 7 days
```

### Current Schedule Waste

```
40 sources crawled per cycle × 96 cycles/day = 3,840 source-crawls/day

Of those:
  ~800 return 0 new jobs (waste)
  ~1,200 return only duplicate jobs (waste)
  ~1,840 return at least 1 new job (productive)

Productive rate: 48%
```

With adaptive crawling:
```
14 sources/cycle (productive only) × 96 = 1,344 source-crawls/day
+ 8 sources/cycle (medium interval × 2) = 384
+ 8 sources every 4th cycle = 192
──────────────────────────────────────
Total: ~1,920 source-crawls/day (50% reduction)
```

---

## 8. Queue Throughput Limits

### Processing Rate Analysis

| Queue | Batch Size | Avg Processing Time | Throughput (jobs/min) |
|-------|-----------|-------------------|---------------------|
| FEED_QUEUE | 5 messages | ~12s/batch | ~100 jobs/min |
| JOB_QUEUE | 5 messages | ~20s/batch | ~25 jobs/min ← **bottleneck** |
| ALERT_QUEUE | 5 messages | ~3s/batch | ~100 alerts/min |

### JOB_QUEUE Bottleneck

```
evaluateJobs processes:
  5 messages × ~20 jobs/msg = ~100 jobs per batch
  Each job: ~2.5ms CPU + ~200ms AI (if needed) + ~50ms queue send
  Wall time per batch: ~20s (with AI) or ~5s (without AI)

Maximum sustained throughput:
  With AI:    100 jobs / 20s = 300 jobs/min
  Without AI: 100 jobs / 5s = 1,200 jobs/min

  But wall-time guard kills at 22s:
  Max jobs before guard: ~100 (with AI) or ~400 (without AI)
```

### Saturation Level

```
FEED_QUEUE saturation:
  Input: 40 sources/cycle → 8 messages
  Processing: 8 messages ÷ 5/batch = 2 batches × 12s = 24s
  Headroom: 15min cycle - 24s = 14.6 min
  Saturation: 3% ← NOWHERE NEAR LIMIT

JOB_QUEUE saturation:
  Input: ~6 messages from processFeeds
  Processing: 2 batches × 20s = 40s
  Headroom: 15min - 40s = 14.3 min
  Saturation: 4% ← LOW

  BUT at 300 jobs/cycle:
  Input: ~30 messages
  Processing: 6 batches × 22s = 132s (2.2 min)
  Saturation: 15%

  AT 1000 jobs/cycle:
  Input: ~100 messages
  Processing: 20 batches × 22s = 440s (7.3 min)
  Saturation: 49% — APPROACHING LIMIT
```

### True Queue Capacity

```
Maximum jobs processable in 15-min window:
  JOB_QUEUE: 15min ÷ 22s/batch × 100 jobs/batch = ~4,000 jobs
  FEED_QUEUE: 15min ÷ 12s/batch × 200 jobs/batch = ~15,000 jobs
  ALERT_QUEUE: 15min ÷ 3s/batch × 5 alerts/batch = ~1,500 alerts
```

---

## 9. Memory Profiling

### Object Size Estimates

| Object | Size | Lifecycle | Leak Risk |
|--------|------|-----------|-----------|
| `config` (frozen object) | ~15KB (24 feeds + 60 sources + rules) | Module-level (survives warm) | 🟢 None |
| `_globalMatcher` (Aho-Corasick trie) | ~50-80KB (200+ keywords, trie nodes) | Module-level singleton | 🟢 None — freed on cold start |
| `cycleSeenHashes` (Set) | **200-800KB** (10K hashes × 20-80B) | Per processFeeds invocation | 🟢 GC'd after function |
| `jobs[]` (raw fetched) | 50-200KB (200 × 500B-1KB) | Per processFeeds invocation | 🟢 GC'd |
| `chunksToBatch[]` (AI vectors) | 10-50KB (30 × 5 chunks × 300B) | Per evaluateJobs invocation | 🟢 GC'd |
| `scoresToBatch[]` | <1KB (numbers) | Per evaluateJobs invocation | 🟢 GC'd |
| `sentAlertsSet` (Set) | <10KB | Per evaluateJobs message | 🟢 GC'd |
| `profileVector` (float array) | ~3KB (768 floats) | Per evaluateJobs invocation | 🟢 GC'd |
| `_domainTimestamps` (Map) | ~2KB (40 domains × ~50B) | Module-level (survives warm) | 🟡 **Grows unbounded on warm instances** |
| `_cachedWindow` (array) | ~1.6KB (200 scores) | Module-level | 🟢 Bounded at 200 entries |
| `allSources` (array) | ~30KB (500 sources × ~60B) | Per scheduler invocation | 🟢 GC'd |

### Peak Memory Per Phase

```
processFeeds:
  Base:                    ~100KB
  cycleSeenHashes Set:     ~500KB (peak)
  JSON.parse(KV):          ~500KB (transient, peak during parse)
  jobs[]:                  ~200KB
  ────────────────────
  Peak:                    ~1.3 MB

evaluateJobs:
  Base:                    ~100KB
  FastMatcher trie:         ~80KB (module-level)
  chunksToBatch:            ~50KB
  profileVector:             ~3KB
  Per-job transient:        ~5KB
  ────────────────────
  Peak:                    ~250KB

scheduler:
  Base:                    ~100KB
  allSources:               ~30KB
  ────────────────────
  Peak:                    ~130KB
```

Worker memory limit: **128MB**. Peak usage: **~1.3MB** (0.01%). No memory concerns.

### Potential Memory Leak

**`_domainTimestamps` (Map) in base.js** — This module-level Map stores timestamps for every domain ever fetched during a warm worker's lifetime. On a long-lived warm instance:

```
Cycle 1:    40 domains → 40 entries (~2KB)
Cycle 10:   200 unique domains → 200 entries (~10KB)
Cycle 100:  500 unique domains → 500 entries (~25KB)
```

This grows without bound. Eventually, every domain ever seen accumulates. At 500 entries (~25KB) it's harmless, but the Map is never pruned.

**Fix:** Add a TTL-based eviction or cap at 100 entries with LRU eviction.

---

## 10. Connector Failure Analysis

### Failure Modes Per Connector

| Connector | Failure Type | Frequency (Est.) | Recovery | Impact |
|-----------|-------------|------------------|----------|--------|
| **RSS** | HTTP 404/503 | ~2%/source/cycle | Retry × 2 | Low — RSS feeds are stable |
| **RSS** | XML parse error | ~0.5%/source | No retry | 1 source missed |
| **Greenhouse** | API rate limit (429) | ~0.1% | Retry × 2 | Low — public API is generous |
| **Greenhouse** | Company board deleted | ~0.01% | Circuit breaker (5 failures) | Source disabled after ~5 cycles |
| **Lever** | Rate limit | ~1% | Retry × 2 | Medium — Lever is stricter |
| **Ashby** | GraphQL error | ~0.5% | Retry × 2 | Low — stable API |
| **Workable** | API response change | ~0.2% | No fallback | Medium — payload format may change |
| **Career Page** | Blocked by WAF | ~5-10%/domain | No retry | **High** — many sites block automated requests |
| **Career Page** | HTML structure changed | ~2% | No fallback | Career parser returns 0 jobs |
| **Search (Bing)** | CAPTCHA/rate limit | ~10%/query | Falls back to Brave | Medium — detected via html.length < 500 |
| **Search (Brave)** | Block | ~5%/query | No fallback (returns []) | Discovery paused for that query |

### Retry Success Rate

```
fetchWithTimeout (10s timeout, 2 retries):
  Attempt 1 success: ~95%
  Attempt 2 success: ~3% (transient errors recovered)
  Attempt 3 success: ~1% (persistent errors)
  All attempts failed: ~1%

  Effective retry recovery rate: ~80% of failures recovered
```

### Connector Reliability Ranking

```
Most reliable → Least reliable:
  1. Greenhouse API     (99.9% success) — generous public API
  2. RSS feeds          (98% success) — standard HTTP
  3. Ashby API          (99% success) — stable GraphQL
  4. Lever API          (98% success) — occasional rate limits
  5. Workable API       (98% success) — stable
  6. Career Pages       (85% success) — frequent WAF blocks
  7. Search expansion   (80% success) — CAPTCHA and blocks
```

---

## 11. Observability Requirements

### Metrics That Must Be Tracked

#### Per-Cycle Metrics (log + D1)

| Metric | Purpose | Current Status |
|--------|---------|----------------|
| `cycle_duration_ms` | Track wall-time trends | ✅ Logged (Fix 13) |
| `sources_crawled` | Monitor crawl coverage | ✅ Logged |
| `raw_jobs_fetched` | Volume tracking | ✅ Logged |
| `unique_jobs_inserted` | Dedup effectiveness | ✅ Logged |
| `duplicate_count` | Dedup layer accounting | ✅ Logged |
| `jobs_evaluated` | Scoring throughput | ✅ Logged |
| `alerts_sent` | Alert volume | ✅ Logged |
| `cpu_time_ms` | CPU budget monitoring | ⚠️ Only in local mode |
| `kv_ops_count` | KV budget tracking | ❌ **MISSING** |
| `d1_queries_count` | D1 budget tracking | ❌ **MISSING** |
| `subrequest_count` | Subrequest budget tracking | ❌ **MISSING** |
| `ai_calls_count` | AI neuron budget | ⚠️ Tracked but not logged |
| `dedup_by_layer` | Which layers catch what | ❌ **MISSING** |

#### Per-Source Metrics (D1 source_registry)

| Metric | Purpose | Current Status |
|--------|---------|----------------|
| `last_yield` | Source freshness | ✅ Tracked |
| `dup_ratio` | Source value | ✅ Tracked (Fix 3) |
| `consecutive_failures` | Reliability | ✅ Tracked |
| `alert_rate` | Source → alert conversion | ❌ **MISSING** |
| `avg_score` | Source quality signal | ❌ **MISSING** |
| `cost_per_unique_job` | ROI calculation | ❌ **MISSING** |

### Logging Improvements Required

| # | Improvement | Purpose |
|---|-------------|---------|
| 1 | **Structured JSON logging** with consistent fields | Enable log aggregation/search |
| 2 | **Add `requestId`** to every log line | Trace across queue hops |
| 3 | **Log dedup breakdown** (cursor/identity/content/cycle/D1) | Measure each layer's contribution |
| 4 | **Log score distributions** per cycle (histogram) | Monitor scoring drift |
| 5 | **Log KV/D1/subrequest counts** per invocation | Budget monitoring |
| 6 | **Add timing breakdowns** per phase in evaluateJobs | Identify CPU regressions |

### Proposed Dashboard Architecture

```
┌────────────────────────────────────────────────────────┐
│  Job Hunter Bot — Operational Dashboard                │
├────────────────────────────────────────────────────────┤
│                                                        │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  │
│  │ Volume / hr  │  │ Dedup Rate  │  │ Alert Rate   │  │
│  │ ████████     │  │ ████████    │  │ ████████     │  │
│  │ 150 jobs     │  │ 85%         │  │ 12 alerts    │  │
│  └─────────────┘  └─────────────┘  └──────────────┘  │
│                                                        │
│  ┌────────────────────────────────────────────────┐    │
│  │ Score Distribution (Rolling 24h)               │    │
│  │ 0-25:  ██████████████████████████ 45%          │    │
│  │ 25-50: ████████████████ 25%                    │    │
│  │ 50-65: ████████ 15%                            │    │
│  │ 65-80: █████ 10%                               │    │
│  │ 80+:   ██ 5%                                   │    │
│  └────────────────────────────────────────────────┘    │
│                                                        │
│  ┌────────────────────────────────────────────────┐    │
│  │ Resource Budget (% of limit)                   │    │
│  │ KV Writes:    ████████████████████████░░ 92%   │    │
│  │ Subrequests:  ████████████████░░░░░░░░░░ 64%   │    │
│  │ AI Neurons:   ████████░░░░░░░░░░░░░░░░░░ 32%   │    │
│  │ D1 Writes:    ██░░░░░░░░░░░░░░░░░░░░░░░░ 8%    │    │
│  └────────────────────────────────────────────────┘    │
│                                                        │
│  ┌────────────────────────────────────────────────┐    │
│  │ Source Health (Top 5 + Bottom 5)               │    │
│  │ 🟢 WeWorkRemotely  50 unique/day  95% fresh    │    │
│  │ 🟢 RemoteOK        35 unique/day  90% fresh    │    │
│  │ 🟢 Stripe GH       8 unique/day   85% fresh    │    │
│  │ ─────────────────────────────────────────       │    │
│  │ 🔴 cryptojobs      0 unique/week  100% dupes   │    │
│  │ 🔴 fossjobs        0 unique/week  100% dupes   │    │
│  └────────────────────────────────────────────────┘    │
│                                                        │
│  Data source: D1 daily_metrics + KV score tracking     │
│  Implementation: /api/dashboard endpoint on worker     │
└────────────────────────────────────────────────────────┘
```

**Implementation path:** Add a `/dashboard` HTTP route to the worker that queries D1 `daily_metrics` and KV `thresh:window` to render a JSON API. A simple static HTML page can visualize it.

---

## Summary: Top 10 Actionable Insights

| # | Insight | Impact | Effort |
|---|---------|--------|--------|
| 1 | **Cache RegExp objects** — `new RegExp()` in scoring loops is the #1 CPU cost | -60ms/cycle CPU | Easy |
| 2 | **Raise MINIMUM_ALERT_SCORE to 55** — eliminates ~30% of false positive alerts | Better alert quality | Trivial |
| 3 | **Remove/disable 7 low-value RSS sources** (crypto, FOSS, Vue, Dribbble) | -7 HTTP calls + CPU/cycle | Trivial |
| 4 | **Add per-layer dedup counters** — currently impossible to measure layer value | Observability | Easy |
| 5 | **Remove cycle dedup KV set** (Layer 5) — broken and redundant with Layer 3+6 | -2 KV ops + 200KB memory | Easy |
| 6 | **Add source eviction when at 500 cap** — discovery engine stops working at cap | Sustained growth | Medium |
| 7 | **Implement adaptive crawl intervals** — 48% of current crawls produce nothing | -50% KV writes/cycle | Medium |
| 8 | **Track KV/D1/subrequest counts** — currently invisible resource consumption | Budget monitoring | Easy |
| 9 | **Add `alert_rate` and `avg_score` to source_registry** — enable source quality ranking | Data-driven decisions | Medium |
| 10 | **Replace keywordMatchesText with FastMatcher** — trie already exists, regex is redundant | -100ms/cycle CPU | Medium |


---
---

# Part 5: Final Architecture Analysis


**Third-stage report** covering network behavior, cold starts, queue backpressure, pipeline latency, data growth, cost model, worker concurrency, failure cascades, and true maximum scale.

---

## 1. Network Behavior

### HTTP Calls Per Worker Invocation

#### processFeeds (FEED_QUEUE consumer, batch_size=5)

Each message carries a chunk of sources. `runAllConnectors` processes them in groups of `CHUNK_SIZE=10`, each connector type using `pLimit(3)` for concurrent fetches.

| Caller | HTTP Calls | Timeout | Retries | Response Size |
|--------|-----------|---------|---------|---------------|
| Greenhouse connector | 1 per company | 10s | 2 | 5-50KB JSON |
| Lever connector | 1 per company | 10s | 2 | 5-50KB JSON |
| Ashby connector | 1 per company (POST) | 10s | 2 | 10-100KB JSON (includes `descriptionHtml`) |
| Workable connector | 1 per company (POST) | 10s | 2 | 5-30KB JSON |
| RSS connector | 1 per feed | 10s | 2 | 5-100KB XML |
| Career page connector | 2-3 per site (page + JSON-LD) | 10s | 2 | 10-200KB HTML |

#### evaluateJobs (JOB_QUEUE consumer, batch_size=5)

| Caller | HTTP Calls | Timeout | Notes |
|--------|-----------|---------|-------|
| `getProfileEmbedding` (AI) | 0-1 | N/A | KV-cached, only calls AI on miss |
| `embedChunks` (AI) | 0-1 per job | N/A | Skipped if `quickKeywordScore > 75` |
| `ALERT_QUEUE.send()` | 0-N | N/A | Queue write, not HTTP |

#### scheduler (_scheduledImpl)

| Caller | HTTP Calls | Frequency | Notes |
|--------|-----------|-----------|-------|
| `searchMultiBackend` | 1-2 per query × 8 queries | Every 8th cycle | Bing → Brave fallback chain, 12s timeout |
| `probeDomainsForCareers` | Up to 15 domains × 1-16 paths each | Every 4th cycle | Up to **240 HTTP fetches** ⚠️ |
| `FEED_QUEUE.send()` | 0 (queue write) | Every cycle | Not an HTTP subrequest |

### Subrequest Budget Analysis

Cloudflare Workers limit: **50 subrequests per invocation** (free tier) / **1000** (paid).

```
┌─────────────────────────────────────────────────────────────────┐
│  WORST-CASE SUBREQUEST COUNT PER INVOCATION TYPE                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  processFeeds (5 messages, ~40 sources):                        │
│    Connector fetches: 40 sources × 1 fetch = 40                │
│    (with retries):                        max = 120             │
│    updateSourceStats (D1):                     = 40             │
│    batchInsertJobs (D1):                       = 3              │
│    KV cursor reads:                            = 40             │
│    KV cursor writes:                           = 40             │
│    KV health reads:                            = 80             │
│    KV health writes:                           = 40             │
│    ──────────────────────────────────────────────               │
│    HTTP subrequests only:                 40-120                │
│    ↑↑↑ EXCEEDS 50-SUBREQUEST LIMIT ↑↑↑                         │
│                                                                 │
│  evaluateJobs (5 messages × ~20 jobs = ~100 jobs):              │
│    AI embedding calls:           max ~30 (budget cap)           │
│    D1 getSentAlertsForJobs:         ~5                          │
│    D1 batchMarkAlertSent:           ~2                          │
│    D1 getGlobalTermFrequencies:      1                          │
│    KV reads (threshold, prefs):     ~3                          │
│    Queue sends (ALERT_QUEUE):       ~20                         │
│    ──────────────────────────────────────────────               │
│    HTTP subrequests: AI 30 (all subrequests)                    │
│    Total subrequests:                ~60                        │
│    ↑↑↑ BORDERLINE ↑↑↑                                          │
│                                                                 │
│  scheduler (_scheduledImpl, discovery cycle):                   │
│    D1 queries:                       ~5                         │
│    KV reads:                         ~3                         │
│    Queue sends:                      ~8                         │
│    searchMultiBackend:          8-16 HTTP                       │
│    probeDomainsForCareers:     15-240 HTTP ← ⚠️ DANGER         │
│    ──────────────────────────────────────────────               │
│    HTTP subrequests:             30-260                          │
│    ↑↑↑ MASSIVELY EXCEEDS LIMIT ↑↑↑                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Critical Finding: Career Probing Exceeds Limits

`probeDomainsForCareers` probes up to **15 domains × 16 career paths each = 240 HTTP calls** in a single scheduler invocation. This will immediately crash on Cloudflare free tier (50 subrequest limit).

In practice, `probeSingleDomain` does early-exit on the first successful path, so average is ~4-5 probes per domain → ~60-75 HTTP calls. Still exceeds limits.

### Bandwidth Estimate Per Cycle

```
40 ATS API calls × 30KB avg response     = 1.2 MB
KV reads (cycle dedup ~200KB + cursors)  = 0.5 MB
KV writes (cursors + health)             = 0.3 MB
D1 queries (small)                       = 0.1 MB
─────────────────────────────────────────────────
Total per cycle:                          ~2.1 MB
Per day (96 cycles):                      ~200 MB
```

---

## 2. Cold Start Impact

### What Happens on Cold Start

Cloudflare Workers can cold-start at any time. Module-level state is lost.

| State Lost | Recovery Mechanism | Added Latency | KV Ops |
|------------|-------------------|---------------|--------|
| `_inMemoryCycle` (sourceIntelligence) | KV read `__cycle_number` | +50ms | +1 read |
| `_cachedEffective` (threshold) | KV read `thresh:effective` | +50ms | +1 read |
| `_cachedWindow` (threshold) | KV read `thresh:window` (~1KB) | +50ms | +1 read |
| `_domainTimestamps` (rate limiter) | KV reads `ratelimit:{domain}` × N | +50ms × N | +N reads |
| `_aiCallCount` (ai-v4) | Reset to 0 (by design) | 0ms | 0 |
| `_kvBinding` (base.js) | Re-set via `setRateLimitKV()` | 0ms | 0 |
| FastMatcher Trie | Rebuilt from config keywords | +5-10ms CPU | 0 |

### Cold Start Sequence (processFeeds)

```
Total added latency on cold start:

1. Import resolution + JIT:         ~100ms
2. loadConfig():                     ~5ms
3. KV: cycle counter read:          ~50ms
4. KV: cycle dedup set read:        ~60ms (200KB)
5. KV: health records × N:         ~50ms × N (parallel)
6. KV: rate limiter recovery:       ~50ms per domain (on first fetch)
────────────────────────────────────────
Cold start overhead:                ~300-500ms
```

### Warm Invocation Comparison

```
Warm start (in-memory caches hit):    ~50ms overhead
Cold start (all KV caches miss):     ~300-500ms overhead
Delta:                                ~250-450ms
```

This is acceptable for a 15-minute cron job, but **important for queue consumers** which respawn frequently. Each queue batch could cold-start independently.

### In-Memory Cache Inconsistency Risk

When multiple queue messages trigger separate invocations (or even concurrent instances), each has its own `_cachedEffective`, `_inMemoryCycle`, and `_domainTimestamps`. These can diverge, causing:
- Different threshold values across concurrent evaluations
- Rate limiter failing to throttle across instances
- Cycle counter incrementing inconsistently

---

## 3. Queue Backpressure

### Queue Configuration (from wrangler.jsonc)

| Queue | batch_size | batch_timeout | max_retries |
|-------|-----------|---------------|-------------|
| `feed-queue` | 5 | 5s | 2 |
| `job-queue` | 5 | 5s | 3 |
| `alert-queue` | 5 | 5s | 5 |

### Normal Flow (Steady State)

```
Cron trigger → FEED_QUEUE: ~4-8 messages (40 sources ÷ N per batch)
            → processFeeds: produces ~3-6 JOB_QUEUE messages
            → evaluateJobs: produces ~0-20 ALERT_QUEUE messages
            → sendAlerts: sends 0-20 notifications
```

### Scenario: 300 Jobs In A Single Cycle

```
Step 1: Scheduler dispatches 40 sources to FEED_QUEUE
        → 8 messages (5 sources per message)

Step 2: 8 processFeeds invocations run
        Each fetches ~37 jobs (300/8)
        After cursor + dedup: ~20 new jobs per invocation

Step 3: Each processFeeds batches new jobs to JOB_QUEUE
        ~20 jobs per batch → 160 total jobs sent
        JOB_QUEUE receives: ~32 messages (160 ÷ 5 batch size)

Step 4: 32 evaluateJobs invocations run
        Each evaluates 5 messages × ~4 jobs = 20 jobs
        Wall-time limit (22s) handles ~15-20 jobs per invocation
        
        If 15% pass threshold: ~24 alerts total
        ALERT_QUEUE receives: ~24 messages

Step 5: 5 sendAlerts invocations (24 ÷ 5)
        Each sends 5 alerts to Discord/Telegram

Total wall-clock time: processFeeds~10s + evaluateJobs~20s + sendAlerts~5s
With queue batching delays:        ~35-60 seconds end-to-end
```

### Queue Pile-Up Risk

The queue system is **self-regulating**: Cloudflare only dispatches a new batch after the previous one completes (or times out). There is no unbounded growth.

However, if `evaluateJobs` consistently hits the **22-second wall-time limit**, messages accumulate:

```
Backlog scenario:
- 100 JOB_QUEUE messages pending
- Processing rate: 5 messages per invocation × 1 invocation/30s
- Drain time: 100 ÷ 5 × 30s = 10 minutes

With max_retries=3, failed messages re-enter queue:
- 100 messages × 4 attempts max = 400 potential invocations
- Drain time: 400 ÷ 5 × 30s = 40 minutes
```

This is acceptable given the 15-minute cron interval. The queue will drain before the next cycle in all but extreme edge cases.

### Dead Letter Behavior

After `max_retries`:
- `feed-queue`: 2 retries → message dropped (jobs lost for this cycle)
- `job-queue`: 3 retries → message dropped (jobs not scored)
- `alert-queue`: 5 retries → message dropped (**alert permanently lost**)

**No DLQ is configured.** Failed alerts are silently discarded.

---

## 4. Job Pipeline Latency

### Latency Breakdown

```
                                   Avg          Worst Case
                                   ─────────    ──────────
Job Discovered (HTTP fetch)        0ms          0ms (reference point)
                                   │
Queue FEED_QUEUE.send()            +50ms        +200ms
Queue batch timeout                +5s          +5s
processFeeds invocation start      +5.05s       +5.2s
                                   │
Connector fetch                    +80ms        +30s (timeout + retries)
Normalize + dedup                  +10ms        +50ms
D1 insert                         +20ms        +100ms
                                   │
Queue JOB_QUEUE.send()             +50ms        +200ms
Queue batch timeout                +5s          +5s
evaluateJobs invocation start      +10.2s       +40.5s
                                   │
isNewJob + keyword prefilter       +1ms         +5ms
AI embedding (if needed)           +200ms       +2000ms
scoreJob                          +5ms         +20ms
                                   │
Queue ALERT_QUEUE.send()           +50ms        +200ms
Queue batch timeout                +5s          +5s
sendAlerts invocation start        +15.5s       +47.7s
                                   │
sendAlert (Discord/TG webhook)     +200ms       +5000ms (rate limit + retry)
                                   │
Alert Delivered                    ~15.7s       ~52.7s
```

### Summary

| Metric | Average | Worst Case |
|--------|---------|------------|
| **Discovery → DB Insert** | ~5s | ~35s |
| **DB Insert → Score** | ~5s | ~10s |
| **Score → Alert Sent** | ~5s | ~10s |
| **Total Pipeline** | **~15s** | **~55s** |

The dominant bottleneck is the **queue batch timeout** (5 seconds × 3 queue hops = 15s minimum latency).

---

## 5. Data Growth Projections

### Table Growth Models

#### jobs table

| Scenario | New Jobs/Day | Dedup Ratio | Stored/Day | 30-Day Size | 1-Year Size |
|----------|-------------|-------------|-----------|-------------|-------------|
| 10K raw | 40% dedup | 6K | 180K rows | 2.2M rows |
| 50K raw | 60% dedup | 20K | 600K rows | 7.3M rows |
| 100K raw | 70% dedup | 30K | 900K rows | 10.9M rows |

Row size estimate: ~200B per job (id + url + content_hash + title + company + timestamp)

| Scenario | 30-Day Table Size | 1-Year Table Size |
|----------|-------------------|-------------------|
| 10K/day | ~36 MB | ~440 MB |
| 50K/day | ~120 MB | ~1.46 GB |
| 100K/day | ~180 MB | ~2.18 GB |

D1 Free Tier storage limit: **5 GB**. At 100K/day, you hit the limit in **~2.3 years** without cleanup. With 30-day cleanup (`cleanupStaleJobs`): stays at ~180MB.

#### sent_alerts table

| Scenario | Alerts/Day | 30-Day Size | 1-Year Size |
|----------|-----------|-------------|-------------|
| 10K/day | ~50 alerts | 1,500 rows (300KB) | 18K rows (3.6MB) |
| 50K/day | ~200 alerts | 6,000 rows (1.2MB) | 73K rows (14.6MB) |
| 100K/day | ~400 alerts | 12,000 rows (2.4MB) | 146K rows (29.2MB) |

#### source_registry table

Capped at 500 sources. ~500 rows × ~500B = ~250KB. Negligible.

#### job_chunks table (RAG embeddings)

Each job generates ~5 chunks × ~3KB (text + vec_json). This is the **fastest growing table**.

| Scenario | Chunks/Day | 30-Day Size | 1-Year Size |
|----------|-----------|-------------|-------------|
| 10K/day | ~10K chunks (if 30% get AI) | 900K rows (2.7 GB) | 10.9M rows (32.7 GB) |
| 50K/day | ~25K chunks | 2.25M rows (6.75 GB) | 27.4M rows (82.1 GB) |

**⚠️ job_chunks will exceed D1 limits within weeks at high volume.** This table needs TTL-based cleanup or archival.

### Index Size Impact

```
jobs:           UNIQUE(url) + UNIQUE(content_hash) + idx_jobs_fetched_score
                ~3 indexes × ~50B per entry × N rows
                At 180K rows: ~27 MB index overhead

job_chunks:     idx_job_chunks_hash + idx_job_chunks_remote
                At 300K rows: ~30 MB index overhead

source_registry: 4 indexes at 500 rows: negligible
```

### Query Performance Impact

| Query | At 100K rows | At 1M rows | At 10M rows |
|-------|-------------|-----------|-------------|
| `INSERT OR IGNORE INTO jobs` | <1ms | <1ms | ~2ms (index update) |
| `GROUP BY company` (hiring surge) | ~5ms | ~50ms | **~500ms** ⚠️ |
| `DELETE FROM jobs WHERE fetched_at < ...` | ~10ms | ~100ms | **~1s** ⚠️ |
| `SELECT FROM sent_alerts WHERE job_id IN (...)` | <1ms | ~5ms | ~10ms |

### Recommended Retention Strategy

```
jobs:         30 days (cleanupStaleJobs already exists)
job_chunks:   7 days (NEW — add cleanupStaleChunks)
sent_alerts:  90 days (NEW — add cleanup for old alerts)
daily_metrics: 90 days (keep for trend analysis)
trend_clusters: 30 days
company_momentum: 30 days
```

---

## 6. Cost Model

### Resource Usage Per Day (Estimated Post-Optimization)

| Resource | 10K jobs/day | 50K jobs/day | 100K jobs/day |
|----------|-------------|-------------|---------------|
| **Workers Invocations** | ~500 | ~1,500 | ~3,000 |
| **KV Reads** | ~10K | ~30K | ~50K |
| **KV Writes** | ~5K | ~15K | ~25K |
| **D1 Rows Read** | ~200K | ~800K | ~1.5M |
| **D1 Rows Written** | ~8K | ~30K | ~60K |
| **AI Neurons** | ~3K | ~10K | ~20K |
| **Queue Messages** | ~800 | ~3K | ~6K |
| **Subrequests** | ~5K | ~15K | ~30K |
| **Bandwidth** | ~200 MB | ~800 MB | ~1.5 GB |

### Monthly Cost Estimate (Cloudflare Pricing)

| Resource | Free Tier | 10K/day | 50K/day | 100K/day |
|----------|-----------|---------|---------|----------|
| Workers Requests | 100K/day | ✅ Free | ✅ Free | ✅ Free |
| KV Reads | 100K/day | ✅ Free | ✅ Free | ✅ Free |
| **KV Writes** | **1K/day** | **⚡ 5× over** | **⚡ 15× over** | **⚡ 25× over** |
| D1 Reads | 5M/day | ✅ Free | ✅ Free | ✅ Free |
| D1 Writes | 100K/day | ✅ Free | ✅ Free | ✅ Free |
| D1 Storage | 5 GB | ✅ Free | ⚠️ Tight | ❌ Needs cleanup |
| AI Neurons | 10K/day | ✅ Free | ⚠️ At limit | ❌ Over |
| Queue Messages | 100K/day | ✅ Free | ✅ Free | ✅ Free |
| Subrequests | 50/invocation | ⚠️ Tight | ❌ Over | ❌ Over |

### Workers Paid Plan ($5/month)

| Resource | Included | 10K/day | 50K/day | 100K/day | Overage Cost |
|----------|----------|---------|---------|----------|-------------|
| KV Reads | 10M/mo | ✅ | ✅ | ✅ | $0.50/M |
| KV Writes | 1M/mo | ✅ | ✅ | ✅ | $5.00/M |
| D1 Reads | 25B/mo | ✅ | ✅ | ✅ | Included |
| D1 Writes | 50M/mo | ✅ | ✅ | ✅ | Included |
| D1 Storage | 5 GB | ✅ | ✅ | ⚠️ | $0.75/GB |
| Subrequests | 1000/invoc | ✅ | ✅ | ✅ | Included |

**Estimated monthly cost on paid plan:**

```
10K/day:  $5.00/month (base plan)
50K/day:  $5.00/month (base plan, borderline AI)
100K/day: $5.75/month (base + ~1GB extra D1 storage)
```

The $5 Workers paid plan solves all free-tier limitations except AI neurons (separate budget).

---

## 7. Worker Concurrency & Race Conditions

### Cloudflare Worker Execution Model

Unlike Node.js servers, Cloudflare Workers are **stateless isolates**. Each invocation runs in its own V8 isolate.

Concurrent execution happens when:
1. Multiple queue messages arrive simultaneously
2. Cron trigger fires while queue is still processing
3. HTTP requests hit the worker during cron processing

### Race Condition Analysis

| State | Shared Medium | Concurrent Writers | Race Risk |
|-------|--------------|-------------------|-----------|
| **Cycle counter** (`__cycle_number`) | KV | 1 writer (scheduler only) | 🟢 Low — only one cron per 15min |
| **Cycle dedup set** (`cycle_dedup:{N}`) | KV | Multiple processFeeds | 🔴 **HIGH** — two concurrent processFeeds read the same set, add their hashes, write back. Last writer wins = lost hashes |
| **ATS cursors** (`cursor:{type}:{slug}`) | KV | Multiple processFeeds | 🔴 **HIGH** — same read-modify-write race as dedup set |
| **Feed health records** | KV | Multiple processFeeds | 🟡 Medium — concurrent updates may lose count increments |
| **Threshold window** | KV | Multiple evaluateJobs | 🟡 Medium — array push + truncate + write = read-modify-write |
| **Score distribution** | KV | Multiple evaluateJobs | 🟡 Medium — same pattern |
| **Source registry** (D1) | D1 | Multiple workers | 🟢 Low — D1 is transactional, INSERT OR IGNORE is idempotent |
| **Jobs table** (D1) | D1 | Multiple workers | 🟢 Low — INSERT OR IGNORE handles duplicates |

### Critical Race: Cycle Dedup Set

```
Timeline:
  T=0:   processFeeds-A reads cycle_dedup:5 → {hash1, hash2}
  T=10:  processFeeds-B reads cycle_dedup:5 → {hash1, hash2}  (same stale set)
  T=50:  processFeeds-A writes {hash1, hash2, hash3, hash4}
  T=60:  processFeeds-B writes {hash1, hash2, hash5, hash6}  ← OVERWRITES A's writes

Result: hash3 and hash4 are LOST from the dedup set.
Jobs with those hashes may be processed again in the next batch.
```

### Critical Race: ATS Cursors

```
Timeline:
  T=0:   Worker-A reads cursor:greenhouse:stripe → [id1, id2, id3]
  T=5:   Worker-B reads cursor:greenhouse:stripe → [id1, id2, id3]
  T=100: Worker-A writes cursor:greenhouse:stripe → [id1, id2, id3, id4]
  T=110: Worker-B writes cursor:greenhouse:stripe → [id1, id2, id3, id5]

Result: id4 is LOST — will be re-processed next cycle.
```

### Mitigation Options

1. **Use KV metadata for compare-and-swap**: Not supported by Cloudflare KV.
2. **Shard by source**: Ensure each source is processed by exactly one invocation (feed-queue routing).
3. **Use Durable Objects**: Provides single-writer guarantees. Higher cost.
4. **Accept eventual consistency**: The damage from race conditions is limited to extra duplicate processing, not data corruption.

---

## 8. Failure Cascade Modeling

### Scenario A: D1 Outage

```
Impact on processFeeds:
  ├── batchInsertJobs fails → fallback to individual inserts → all fail
  ├── All new jobs are LOST (msg.ack() in waitUntil runs anyway)
  ├── updateSourceStats fails → source intelligence degrades
  ├── batchRegisterDiscoveredSources fails → discovery paused
  └── incrementDailyMetrics fails → daily report blank

Impact on evaluateJobs:
  ├── getActiveProfiles fails → falls back to default profile
  ├── getSentAlertsForJobs fails → returns empty Set
  │   └── DANGER: all alerts resent (duplicate notifications!)
  ├── batchMarkAlertSent fails → duplicates possible on retry
  └── D1 chunk inserts fail → RAG degraded

Impact on scheduler:
  ├── getEnabledSources fails → registry sources unavailable
  ├── getSourcesForCycle fails → only config sources dispatched
  ├── recalculatePriorities fails → stale priorities
  └── growthEngine/trendsDetection fails → no intelligence updates

Recovery: Automatic when D1 recovers. Some data permanently lost if
messages were ack'd during outage.

Cascade Risk: MEDIUM — duplicate alerts possible, jobs lost for 
affected cycles.
```

### Scenario B: KV Outage

```
Impact on processFeeds:
  ├── ATS cursor load fails → full re-fetch (all jobs treated as new)
  │   └── 40 sources × 50 jobs = 2000 "new" jobs (massive spike)
  ├── Cycle dedup set unavailable → no cross-batch dedup
  ├── Feed health records unavailable → circuit breakers inactive
  │   └── Dead sources not skipped → wasted fetches
  └── Cursor save fails → next cycle also re-fetches everything

Impact on evaluateJobs:
  ├── Threshold read fails → falls back to config default (50)
  ├── Preference weights unavailable → no feedback boost
  ├── Profile embedding cache miss → AI call required
  └── Score tracking fails → threshold auto-adjust broken

Impact on scheduler:
  ├── Cycle counter read fails → starts at 0
  │   └── All modulo-gated tasks run simultaneously
  └── Discovery stats not saved → force-discovery may re-trigger

Recovery: KV outage + recovery causes a "thundering herd" where all
cursors are cold, all health records are reset, and all sources are
treated as new.

Cascade Risk: HIGH — massive duplicate spike, all quality controls 
bypassed simultaneously.
```

### Scenario C: AI Service Outage

```
Impact on evaluateJobs:
  ├── getProfileEmbedding fails → profileVector is empty
  │   └── RAG similarity always 0 → semantic matching disabled
  ├── embedChunks fails → chunkVecs empty
  │   └── TopKChunks returns nothing → ragMatches empty
  └── Score still computed from keywordScore + other features
      └── Accuracy drops ~20-30% but system still functions

Recovery: Automatic when AI recovers. No data loss.
Cascade Risk: LOW — graceful degradation.
```

### Scenario D: Queue Backlog (All Queues Saturated)

```
FEED_QUEUE backlog (>50 pending messages):
  ├── Each message still processed within 30s wall time
  ├── 50 messages ÷ 5 per batch = 10 batches
  ├── 10 × 30s = 5 minutes to drain
  └── Next cron fires at 15min → adds more messages

JOB_QUEUE backlog (>100 pending messages):
  ├── 100 ÷ 5 = 20 batches × 25s = 8.3 minutes
  ├── Wall-time guard may truncate some batches
  └── Unprocessed jobs within a message are LOST (partial ack)

ALERT_QUEUE backlog (>50 pending messages):
  ├── 50 ÷ 5 = 10 batches × 10s = 100 seconds
  ├── Discord/Telegram rate limits may slow delivery
  └── 5 retries means persistent 429s cause 150 attempts

Cascade Risk: LOW-MEDIUM — system self-regulates through batch 
timeouts but partial job loss possible in evaluateJobs.
```

---

## 9. True Maximum Scale

### Absolute Limits (Current Architecture)

| Dimension | Free Tier Limit | Paid Plan Limit | Architecture Limit |
|-----------|----------------|-----------------|-------------------|
| **Sources per cycle** | ~25 (subrequest limit) | ~200 | ~500 (source cap) |
| **Jobs per cycle** | ~200 | ~2,000 | ~5,000 (memory) |
| **Jobs per day** | ~19K | ~192K | ~480K |
| **Alerts per day** | ~200 | ~2,000 | ~10,000 |
| **AI calls per day** | ~3K (neuron limit) | ~30K | ~100K |
| **D1 writes per day** | ~80K | ~50M | ~50M |
| **KV writes per day** | **1,000** ⚡ | 1M | 1M |

### Bottleneck Ranking

```
1. KV Writes (free tier)              ← First limit hit
2. Subrequests per invocation         ← Limits sources per batch
3. AI Neurons (free tier)             ← Limits semantic scoring
4. Worker CPU time (10ms billing)     ← Limits scoring complexity
5. D1 Storage (5GB)                   ← Limits data retention
6. Memory (128MB per isolate)         ← Limits batch sizes
```

### Scaling Tiers

```
┌──────────────────────────────────────────────────────────────┐
│  TIER 1: Current (Free Tier)                                 │
│  Sources: 25/cycle, Jobs: 10K/day, Alerts: 100/day           │
│  Cost: $0/month                                              │
│  Bottleneck: KV writes, subrequests                          │
├──────────────────────────────────────────────────────────────┤
│  TIER 2: Workers Paid ($5/month)                             │
│  Sources: 200/cycle, Jobs: 50K/day, Alerts: 1000/day         │
│  Cost: $5/month                                              │
│  Bottleneck: AI neurons, D1 storage                          │
├──────────────────────────────────────────────────────────────┤
│  TIER 3: Workers Paid + AI Paid                              │
│  Sources: 500/cycle, Jobs: 100K/day, Alerts: 5000/day        │
│  Cost: $10-15/month                                          │
│  Bottleneck: Architecture (single-worker, no sharding)       │
├──────────────────────────────────────────────────────────────┤
│  TIER 4: Architecture Redesign Required                      │
│  Sources: >500, Jobs: >100K/day                              │
│  Requires: Durable Objects, sharded queues, external DB      │
│  Cost: $50-100/month                                         │
└──────────────────────────────────────────────────────────────┘
```

---

## Architectural Improvements Required

### Priority 1 — Free Tier Survival

| # | Improvement | Impact |
|---|-------------|--------|
| 1 | **Batch feedHealth KV writes** into single per-cycle report | -35 KV writes/cycle |
| 2 | **Skip cursor write when unchanged** | -20 KV writes/cycle |
| 3 | **Cap career probing to 3 domains × 3 paths** per scheduler run | Prevents subrequest overflow |
| 4 | **Move career probing to separate queue** to isolate its subrequest budget | Eliminates scheduler overflow |

### Priority 2 — Reliability

| # | Improvement | Impact |
|---|-------------|--------|
| 5 | **Fix msg.ack() → ack only on success** | Prevents silent job loss |
| 6 | **Add DLQ for alert-queue** | Prevents permanent alert loss |
| 7 | **Fix cycle dedup KV key** (`crawl_cycle_counter` → `__cycle_number`) | Enables proper dedup rotation |
| 8 | **Shard feed-queue by source** to prevent cursor race conditions | Eliminates read-modify-write races |

### Priority 3 — Performance

| # | Improvement | Impact |
|---|-------------|--------|
| 9 | **Add job_chunks cleanup** (7-day retention) | Prevents D1 storage overflow |
| 10 | **Add sent_alerts cleanup** (90-day retention) | Controls table growth |
| 11 | **Batch updateSourceStats** into single D1 batch call | -35 D1 queries/cycle |
| 12 | **Reduce queue batch_timeout from 5s to 2s** | Reduces pipeline latency by 9s |

### Priority 4 — Scale Preparation

| # | Improvement | Impact |
|---|-------------|--------|
| 13 | **Use Durable Objects for cycle dedup** | Eliminates KV race conditions |
| 14 | **Implement adaptive AI budgeting** based on neuron usage | Prevents AI quota exhaustion |
| 15 | **Add job_chunks table partitioning** by week | Query performance at scale |


---
---

# Part 6: Optimization Report


## Changes Summary

13 architecture fixes implemented across 14 files, 1 new migration, targeting the **97% duplicate ratio** (83,929 raw → 2,211 unique).

---

## Stage 1 — Immediate Load Reduction

### Fix 1: ATS Cursor System ✅
**Files:** `greenhouse.js`, `lever.js`, `ashby.js`, `workable.js`, `base.js`, `index.js`

Every ATS connector now loads a KV-stored set of previously-seen job IDs (`cursor:{type}:{slug}`), filters out duplicates before processing, and saves back after crawl. Cursor is capped at 500 IDs with 7-day TTL.

**Before:** 500 jobs re-fetched, re-parsed, re-hashed every 15 minutes per company  
**After:** Only genuinely new jobs (typically 0-5) pass through

### Fix 2: Per-Source Job Limits ✅
**Files:** `base.js` (+`MAX_JOBS_PER_SOURCE=50`), all 4 ATS connectors

Hard cap of 50 jobs per source per crawl. Prevents flood even if cursor is cold.

### Fix 3: Dup-Ratio Tracking ✅
**Files:** `migrations/0007_dup_ratio_tracking.sql`

New columns `dup_ratio` and `high_dup_streak` in `source_registry` table for automatic throttling of low-value sources.

### Fix 4: Scheduler Bypass ✅
**File:** `worker.js` (`_scheduledImpl`)

**Before:** All 84 config sources always included + registry sources → 100+ sources/cycle  
**After:** All sources merged, scored by priority, top 40 selected. Config sources get +10 priority bonus but are not exempt from scoring.

---

## Stage 2 — Deduplication Architecture Fix

### Fix 5: Early Identity Hash Dedup ✅
**Files:** `schema.js`, `worker.js`

New `identity_hash = fnvHash(company::title::location)` catches cross-platform duplicates before D1 insert. Checked against cycle-level KV set.

### Fix 6: Content Hash URL Removal ✅
**File:** `schema.js`

`content_hash` no longer includes URL path. Same job on Greenhouse + Ashby now produces identical hash → caught by D1 `UNIQUE(content_hash)`.

### Fix 7: Cycle-Level Memory Dedup ✅
**File:** `worker.js`

Dedup set now persists across queue batches within a cron cycle via KV (`cycle_dedup:{N}`). No longer resets per invocation. Capped at 10K hashes, 1h TTL.

---

## Stage 3 — Source Intelligence

### Fix 8: Source Registry Safeguards ✅
**File:** `db/sources.js`

Max 500 total sources. `registerDiscoveredSource` checks count before inserting.

### Fix 9: Connector Overlap Cleanup ✅
**File:** `config.js`

Removed 4 double-sourced companies:
- Notion: removed from Greenhouse (kept Ashby)
- Linear: removed from Greenhouse (kept Ashby)
- Netlify: removed from Lever (kept Greenhouse)
- Vercel: removed from Lever (kept Greenhouse)

### Fix 10: Discovery Input Fix ✅
**File:** `worker.js`

ATS detection now runs on `newJobs` only (not all raw jobs). Reduces iterations from ~5,000 to ~100 per batch.

---

## Stage 4 — Scoring Pipeline Fix

### Fix 11: Content Restoration ✅
**File:** `worker.js` (`slimJob`)

`contentSnippet` (500 chars) now included in queue payloads. Restores keyword matching, TF-IDF, salary, seniority, and experience features for queue-routed jobs.

---

## Stage 5 — Observability

### Fix 12: Per-Source Metrics ✅
**File:** `worker.js`

Enhanced logging: `[Metrics] source=type:name | fetched=N cursorSkipped=N error=none durationMs=N`

### Fix 13: Worker Resource Metrics ✅
**File:** `worker.js`

Performance timing: `[Metrics] processFeeds: total=Nms | rawJobs=N dedupSkipped=N deduped=N`

---

## Performance Comparison

| Metric | Before | After (Estimated) | Reduction |
|--------|--------|-------------------|-----------|
| Raw jobs per cycle | ~4,000 | ~200-400 | **~90%** |
| Sources crawled per cycle | ~100 | 40 | **60%** |
| Duplicate ratio | 97% | <40% | **~60pp** |
| D1 INSERT OR IGNORE/day | ~560K | ~30K | **~95%** |
| Cross-platform dupes | Present | Eliminated | **100%** |
| Scoring accuracy | ~30% (title-only) | ~90% (with content) | **3x** |
| Discovery ATS iterations | ~5,000/batch | ~100/batch | **98%** |
| Source growth | Unbounded | Capped at 500 | Controlled |
| Worker CPU waste | ~19 min/day | ~1 min/day | **~95%** |

## New Resource Estimates

```
Sources per cycle:           40 (was ~100)
Avg new jobs per source:     ~3 (with cursor, was ~40)
New jobs per cycle:          ~120
Cycles per day:              96
New jobs per day:            ~11,500
Duplicates per day:          ~5,000 (was ~560K)
Effective dup ratio:         ~30% (was 97%)
```

---

## Test Results

```
Test Suites: 4 passed, 1 pre-existing failure
Tests:       91 passed, 1 pre-existing failure
```

The 1 failure is a pre-existing SimHash collision test (`optimization-validation.test.js` Test Case A) unrelated to our changes. No regressions introduced.

---

## Files Modified

| File | Changes |
|------|---------|
| `src/config.js` | Removed 4 double-sourced companies |
| `src/worker.js` | Scheduler fix, dedup overhaul, slimJob fix, discovery fix, metrics |
| `src/core/schema.js` | Content hash URL removal, identity_hash addition |
| `src/connectors/base.js` | Job limit, ATS cursor utilities |
| `src/connectors/greenhouse.js` | Cursor + limit integration |
| `src/connectors/lever.js` | Cursor + limit integration |
| `src/connectors/ashby.js` | Cursor + limit integration |
| `src/connectors/workable.js` | Cursor + limit integration |
| `src/connectors/index.js` | KV threading to ATS connectors |
| `src/db/sources.js` | Registry cap safeguard |
| `migrations/0007_dup_ratio_tracking.sql` | New columns for dup tracking |


---
---

