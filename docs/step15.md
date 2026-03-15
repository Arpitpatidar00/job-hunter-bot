# Step 15 — Architecture Fixes (v5.3)

## Overview

This document covers the 9 architecture-level fixes implemented to resolve critical production issues identified in [step13.md](./step13.md). These changes preserve the core event-driven queue architecture while eliminating operational bottlenecks — specifically KV write quota exhaustion on Cloudflare's free tier.

**Deployment date:** March 2026  
**Migration:** `0013_arch_fixes.sql`  
**Version:** v5.3.0

---

## 15.1 Summary of All Fixes

| # | Fix | Severity | Status | Impact |
|---|---|---|---|---|
| 1 | [KV → D1 storage migration](#fix-1--kv-write-volume-migrated-to-d1) | 🔴 Critical | ✅ Implemented | KV writes: ~4,876 → ~120/day |
| 2 | [Cron batch staggering](#fix-2--true-cron-batch-staggering) | 🔴 Critical | ✅ Implemented | CPU spikes eliminated |
| 3 | [Remove persistent job chunks](#fix-3--job-chunk-storage-removed) | 🟡 Medium | ✅ Implemented | -500 D1 writes/day |
| 4 | [Increase queue batch size](#fix-4--queue-batch-size-increased) | 🟡 Medium | ✅ Implemented | Worker invocations halved |
| 5 | [Search query caching](#fix-5--search-discovery-caching) | 🟡 Medium | ✅ Implemented | Repeated API calls eliminated |
| 6 | [Metrics write buffering](#fix-6--metrics-write-buffering) | 🟡 Medium | ✅ Implemented | -66% metrics D1 writes |
| 7 | [Queue depth monitoring](#fix-7--queue-depth-monitoring) | 🟡 Medium | ✅ Implemented | Backlog auto-mitigation |
| 8 | [Source priority scoring](#fix-8--source-priority-scoring) | 🟢 Existing | ✅ Already present | Dynamic crawl scheduling |
| 9 | [Multi-stage scoring pipeline](#fix-9--multi-stage-scoring-pipeline) | 🟢 Existing | ✅ Already present | 70% fewer AI calls |

---

## Fix 1 — KV Write Volume Migrated to D1

### Problem
The system was making ~4,876 KV writes/day against a free tier limit of 1,000/day. The primary offenders:

| KV Key Pattern | Writes/Day | Source |
|---|---|---|
| `feed:health:{hash}` | ~3,840 | 40 sources × 96 cron cycles |
| `metrics:score_histogram` | ~96 | Per evaluateJobs batch |
| `thresh:window` | ~96 | Per evaluateJobs batch |
| `thresh:effective` | ~48 | When threshold changes |
| Other (cursors, discovery, cycle) | ~100 | Various |
| **Total** | **~4,876** | Exceeds 1,000 limit by 5× |

### Solution
Moved all high-frequency mutable state from KV to D1.

#### New Storage Mapping (v5.3)

| Data Type | Before (v5.2) | After (v5.3) | Why |
|---|---|---|---|
| Feed health records | KV `feed:health:{hash}` | D1 `feed_health` table | ~3,840 writes/day eliminated |
| Threshold rolling window | KV `thresh:window` | D1 `threshold_state` table | ~96 writes/day eliminated |
| Effective threshold | KV `thresh:effective` | D1 `threshold_state` table | ~48 writes/day eliminated |
| Score histogram | KV `metrics:score_histogram` | D1 `score_histogram` table | ~96 writes/day eliminated |
| Circuit breaker flags | KV `feed:circuit:{hash}` | **KV (unchanged)** | Needs TTL for auto-recovery |
| Feed cursors | KV `cursor:{type}:{slug}` | **KV (unchanged)** | Low writes (~40/day) |
| AI embedding cache | KV `embed:{key}` | **KV (unchanged)** | Read-heavy, low writes |
| Cycle counter | KV `__cycle_number` | **KV (unchanged)** | 1 write per 10 cycles |
| Discovery stats | KV `discovery:*` | **KV (unchanged)** | 2-3 writes per run |

#### Estimated KV Writes After Migration

```
Circuit breaker flags:    ~20/day  (only on failure state changes)
Feed cursors:             ~40/day  (one per source per crawl)
Cycle counter:            ~10/day  (every 10th cycle)
Discovery stats:          ~6/day   (2 writes × ~3 runs)
Embedding cache:          ~20/day  (new profiles/config changes)
Search query cache:       ~24/day  (up to 8 queries × 3 runs)
                           ──────
Total:                   ~120/day  ✅ Well within 1,000 limit
```

### Files Changed

| File | Change |
|---|---|
| `src/intelligence/feedHealth.js` | Complete rewrite: D1 `feed_health` table for health records, `batchRecordFeedResults()` for batched upserts |
| `src/intelligence/threshold.js` | Complete rewrite: D1 `threshold_state` table for window + effective threshold, D1 `score_histogram` for histogram |
| `src/intelligence/dailyReport.js` | `trackScoreDistribution()` now a no-op (histogram in D1); reads histogram from D1 via `getScoreHistogram()` |
| `src/worker.js` | All `getFeedHealthRecord()`, `recordFeedResult()`, `getEffectiveThreshold()`, `recordJobScoresBatch()` calls updated to pass `env.DB` |
| `migrations/0013_arch_fixes.sql` | Creates `feed_health`, `threshold_state`, `score_histogram` tables |

### New D1 Tables

```sql
-- Feed health (replaces KV feed:health:{hash})
CREATE TABLE feed_health (
    url_hash TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    consecutive_failures INTEGER DEFAULT 0,
    total_latency_ms INTEGER DEFAULT 0,
    sample_count INTEGER DEFAULT 0,
    last_seen TEXT,
    last_error TEXT DEFAULT '',
    etag TEXT,
    last_modified TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Threshold state (replaces KV thresh:window + thresh:effective)
CREATE TABLE threshold_state (
    key TEXT PRIMARY KEY,       -- 'thresh:window' or 'thresh:effective'
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Score histogram (replaces KV metrics:score_histogram)
CREATE TABLE score_histogram (
    date TEXT NOT NULL,
    bucket INTEGER NOT NULL,    -- 0, 10, 20, ..., 90
    count INTEGER DEFAULT 0,
    PRIMARY KEY (date, bucket)
);
```

### API Changes

```
OLD: getFeedHealthRecord(kv, url)
NEW: getFeedHealthRecord(db, kv, url)

OLD: recordFeedResult(kv, url, result)
NEW: recordFeedResult(db, kv, url, result)
NEW: batchRecordFeedResults(db, kv, results)    ← batch API

OLD: getEffectiveThreshold(kv, configThreshold)
NEW: getEffectiveThreshold(db, configThreshold)

OLD: recordJobScoresBatch(kv, scores)
NEW: recordJobScoresBatch(db, scores)
```

---

## Fix 2 — True Cron Batch Staggering

### Problem
The system had a single cron expression `0,15,30,45 * * * *`. The `batcher.js` module was designed for 3 staggered batches, but only batch 0 ever activated. All 40 sources were crawled simultaneously.

### Solution
Added 3 staggered cron triggers in `wrangler.jsonc`:

```jsonc
"crons": [
    "0,15,30,45 * * * *",     // Batch 0 — high-priority sources
    "5,20,35,50 * * * *",     // Batch 1 — medium-priority sources
    "10,25,40,55 * * * *"     // Batch 2 — low-priority + exploration
]
```

### How It Works

```
:00  Batch 0 fires → getBatchId() returns 0 → processes sources[0..13]
:05  Batch 1 fires → getBatchId() returns 1 → processes sources[14..27]
:10  Batch 2 fires → getBatchId() returns 2 → processes sources[28..40]
:15  Batch 0 fires → cycle repeats
```

The `_scheduledImpl()` function now:
1. Calls `getBatchId(event.scheduledTime, 3)` from `batcher.js`
2. Splits the priority-ranked source list into 3 batches via `splitFeedsIntoBatches()`
3. Only queues the batch matching the current cron trigger

### Files Changed

| File | Change |
|---|---|
| `wrangler.jsonc` | Added 2 additional cron expressions |
| `src/worker.js` | Added `getBatchId` + `splitFeedsIntoBatches` imports; `_scheduledImpl()` now splits sources by batch ID |

### Impact

| Metric | Before | After |
|---|---|---|
| Sources per cron trigger | 40 | ~14 |
| CPU per invocation | High (all sources) | ~33% of original |
| Network spike | All 40 concurrent | Distributed across 3 windows |
| Crawl overlap | 100% | 0% |

---

## Fix 3 — Job Chunk Storage Removed

### Problem
The scoring engine stored AI embedding chunks to D1 (`job_chunks` table) after every `evaluateJobs()` run. However, chunks are only used **within the same invocation** for cosine similarity scoring — they are never re-read from D1 in a later invocation.

### Solution
Removed the `INSERT INTO job_chunks` batch write from `postEvaluationCleanup()`. Chunks now only exist in-memory during the scoring cycle.

```js
// BEFORE (v5.2): Persisted to D1
for (let i = 0; i < allChunks.length; i += 40) {
    await env.DB.batch(allChunks.slice(i, i + 40));
}

// AFTER (v5.3): In-memory only — no D1 writes
if (chunksToBatch.length > 0) {
    logger.info(`Processed ${chunksToBatch.length} job chunks in-memory (not persisted)`);
}
```

### Impact

- **~500 fewer D1 writes/day** (100 jobs × 5 chunks)
- `job_chunks` table stabilizes (existing rows still cleaned by `cleanupStaleChunks(7)`)
- No functional change — scoring produces identical results

---

## Fix 4 — Queue Batch Size Increased

### Problem
All three queue consumers used `max_batch_size: 5`, causing excessive Worker invocations.

### Solution
Increased to `max_batch_size: 10` in `wrangler.jsonc`:

```jsonc
"consumers": [
    { "queue": "feed-queue",  "max_batch_size": 10, "max_retries": 2 },
    { "queue": "job-queue",   "max_batch_size": 10, "max_retries": 3 },
    { "queue": "alert-queue", "max_batch_size": 10, "max_retries": 5 }
]
```

### Impact

| Queue | Before | After |
|---|---|---|
| Feed queue invocations | 8 per cron (40/5) | 4 per cron (40/10) |
| Job queue invocations | ~10 per cron | ~5 per cron |
| Alert queue invocations | ~2 per cron | ~1 per cron |
| **Total daily invocations** | ~2,016 | ~1,200 |

---

## Fix 5 — Search Discovery Caching

### Problem
`runSearchExpansion()` ran identical search queries (e.g., `site:greenhouse.io "software engineer"`) every 8 cycles with no caching, wasting API calls and risking rate limits.

### Solution
Added `searchWithCache()` wrapper with KV-backed 24h cache:

```js
async function searchWithCache(query, kv) {
    const cacheKey = `search:cache:${hashQuery(query)}`;

    // Cache hit → return immediately
    const cached = await kv.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // Cache miss → live search + store result
    const urls = await searchMultiBackend(query);
    if (urls.length > 0) {
        await kv.put(cacheKey, JSON.stringify(urls), { expirationTtl: 86400 });
    }
    return urls;
}
```

### Impact

- Eliminates repeated Bing/Brave queries for the same search terms
- ~24 KV writes/day max (8 queries × 3 runs) — fits within budget
- Prevents search engine rate limiting
- First query of each day still executes live

---

## Fix 6 — Metrics Write Buffering

### Problem
`incrementDailyMetrics()` was called 3-6 times per cron cycle from different stages:

| Call Site | Frequency |
|---|---|
| `processFeeds()` Phase 1 | Every cycle |
| `processFeeds()` Phase 2 (discovery) | Every cycle (if discoveries) |
| `evaluateJobs()` | Every cycle |
| `sendAlerts()` | Every cycle |
| `_scheduledImpl()` (cycles_completed) | Every cycle |
| `_scheduledImpl()` (career/search) | Conditional |

That's **3-6 D1 batch calls per cycle × 96 cycles = 288-576 D1 writes/day** just for metrics.

### Solution
Added in-memory buffer with single flush:

```js
// Buffer during execution (no I/O)
bufferMetrics({ sources_scanned: 5, raw_jobs_found: 42, ... });
bufferMetrics({ new_sources_ats: 2 });
bufferMetrics({ cycles_completed: 1 });

// Flush once at end of handler (single D1 batch call)
await flushMetricsBuffer(env.DB);
```

### How It Works

1. `bufferMetrics(deltas)` — accumulates deltas in module-level `_metricsBuffer` object
2. Numeric values are summed; `score_max` uses `Math.max()`; `skill_counts` are merged
3. `flushMetricsBuffer(db)` — calls `incrementDailyMetrics()` once with the accumulated buffer
4. Buffer is reset immediately before the async write to prevent double-flush

### Files Changed

| File | Change |
|---|---|
| `src/intelligence/dailyReport.js` | Added `bufferMetrics()` and `flushMetricsBuffer()` exports |
| `src/worker.js` | All `incrementDailyMetrics()` calls replaced with `bufferMetrics()` + one `flushMetricsBuffer()` per handler |

### Impact

- Metrics D1 writes: **~576/day → ~192/day** (~66% reduction)
- Same data accuracy — all deltas are accumulated, just written less frequently

---

## Fix 7 — Queue Depth Monitoring

### Problem
No mechanism to detect when `job ingestion rate > scoring rate`. If AI scoring slows down, the job-queue can accumulate unbounded backlog, causing delayed alerts and stale recommendations.

### Solution
Added queue depth detection at the start of `evaluateJobs()`:

```js
// Count total pending jobs in this batch
let totalJobsInBatch = 0;
for (const msg of messages) {
    const msgJobs = msg.body.jobs || [msg.body];
    totalJobsInBatch += msgJobs.length;
}

const QUEUE_DEPTH_THRESHOLD = 200;
const queueBacklogDetected = totalJobsInBatch > QUEUE_DEPTH_THRESHOLD;
```

When backlog is detected, **AI embedding is disabled** — the system falls back to keyword-only scoring:

```js
if (quickKeywordScore < SKIP_AI_THRESHOLD && !queueBacklogDetected) {
    // Normal: embedChunks() → AI scoring
    chunkVecs = await embedChunks(env.AI, env.SEEN_JOBS, job.id, chunks);
} else {
    // Backlog mode: skip AI, use keyword score only
}
```

### Impact

- System remains responsive under load
- Prevents backlog accumulation
- Alerts still sent (keyword-scored), just without AI semantic enhancement
- Automatic — no manual intervention needed

---

## Fix 8 — Source Priority Scoring (Already Implemented)

This was already fully implemented in `src/intelligence/sourceIntelligence.js`. The priority scoring system uses 6 signals:

| Signal | Weight | Description |
|---|---|---|
| Job yield | 25% | Recent job count vs historical average |
| Freshness | 20% | Hours since last new job found |
| Reliability | 20% | Success rate (success / total attempts) |
| Consistency | 15% | Average yield per fetch |
| Relevance | 10% | Posting frequency proxy |
| Dedup penalty | 10% | Penalizes high-duplication sources |

Additional behaviors:
- **Exploration bonus:** New sources (< 10 attempts) get 52-70 priority
- **Adaptive crawl intervals:** Based on posting frequency
- **Auto-disable:** Zero-yield after 10+ attempts, or 95%+ dupes with no new jobs in 7 days
- **Hiring surge detection:** Sources with 30%+ volume increase get promoted to `high` tier
- **48h re-enable:** Disabled sources get retried every 48 hours at `dormant` tier

---

## Fix 9 — Multi-Stage Scoring Pipeline (Already Implemented)

The scoring pipeline already implements a multi-stage architecture:

```
Stage 1: hasBasicKeywordMatch()
    └── Requires ≥1 title match OR ≥2 mustMatch OR ≥3 total hits
    └── ~30% of jobs filtered out (no I/O, pure CPU)

Stage 2: computeQuickKeywordScore()
    └── 0-100 keyword score based on title + content matching
    └── If score > 75 → skip AI embedding entirely
    └── ~40% of remaining jobs skip AI

Stage 3: embedChunks() + scoreJob()
    └── AI embedding via Workers AI (only ~30% of total jobs reach here)
    └── 13-layer scoring with RAG semantic matching

Stage 4 (NEW): Queue backlog emergency mode
    └── If batch > 200 jobs → ALL AI scoring disabled
    └── Keyword-only scoring ensures throughput
```

**Net result:** Only ~30% of jobs require AI calls — saving ~70% of AI compute costs.

---

## 15.2 D1 Migration Reference

### Migration: `0013_arch_fixes.sql`

Apply before deploying v5.3:

```bash
# Apply to remote D1 (production)
npx wrangler d1 migrations apply job-hunter-db --remote

# Then deploy worker
npx wrangler deploy
```

### Tables Created

| Table | Purpose | Replaces KV Key |
|---|---|---|
| `feed_health` | Per-URL health records with success/failure/latency | `feed:health:{hash}` |
| `threshold_state` | Rolling score window + effective threshold | `thresh:window`, `thresh:effective` |
| `score_histogram` | Per-day score distribution buckets | `metrics:score_histogram` |

### Columns Added

| Table | Column | Purpose |
|---|---|---|
| `daily_metrics` | `queue_depth_estimate` | Tracks queue backlog for monitoring |

---

## 15.3 Updated KV Key Map (v5.3)

After migration, the KV namespace `SEEN_JOBS` only stores these keys:

| Key Pattern | Purpose | TTL | Writes/Day |
|---|---|---|---|
| `feed:circuit:{hash}` | Circuit breaker open flag | 5min–4hrs | ~20 |
| `cursor:{type}:{slug}` | ATS connector pagination cursor | 7 days | ~40 |
| `feed:cursor:{hash}` | RSS pubDate cursor | 7 days | ~40 |
| `__cycle_number` | Global cycle counter | None | ~10 |
| `profile:{hash}` | Cached profile embedding | 1 hour | ~20 |
| `embed:{key}` | AI embedding cache | Varies | ~20 |
| `discovery:last_run_stats` | Search expansion telemetry | 48 hours | ~6 |
| `discovery:last_success_timestamp` | Last successful discovery | 7 days | ~3 |
| `search:cache:{queryHash}` | Search query result cache (Fix 5) | 24 hours | ~24 |
| `scoring:thresholds:v4` | Calibration threshold | None | ~4 |
| `ratelimit:{domain}` | Domain rate limit flag | 5 min | ~5 |
| **Total** | | | **~192** |

**Removed from KV:** `feed:health:{hash}` (~3,840 writes), `thresh:window` (~96), `thresh:effective` (~48), `metrics:score_histogram` (~96) = **~4,080 writes eliminated**.

---

## 15.4 Updated Resource Budget (v5.3)

| Resource | Before (v5.2) | After (v5.3) | Free Tier Limit | Status |
|---|---|---|---|---|
| KV writes/day | ~4,876 | ~192 | 1,000 | ✅ 19% used |
| Worker invocations/day | ~2,016 | ~1,200 | 100,000 | ✅ 1.2% used |
| D1 writes/day | ~2,500 | ~2,300 | 100,000 | ✅ 2.3% used |
| D1 reads/day | ~3,000 | ~3,200 | 5,000,000 | ✅ 0.06% used |
| AI calls/day | ~30 | ~30 | Included | ✅ Safe |

**Key result:** All resources are now well within Cloudflare free tier limits. No paid plan required.

---

## 15.5 Updated System Diagram (v5.3)

```
Cron (3 staggered triggers — Fix 2)
  :00/:15/:30/:45  →  Batch 0 (high-priority sources)
  :05/:20/:35/:50  →  Batch 1 (medium-priority sources)
  :10/:25/:40/:55  →  Batch 2 (low-priority + exploration)

Each batch:
  _scheduledImpl(event, env, ctx)
    ├── getBatchId(event.scheduledTime, 3) → batch 0/1/2
    ├── splitFeedsIntoBatches(prioritySources, 3) → this batch's sources
    ├── FEED_QUEUE.sendBatch(~14 sources)
    ├── [/4 cycles] recalculatePriorities(D1)
    ├── [/8 cycles] runSearchExpansion() with query caching (Fix 5)
    ├── bufferMetrics() for all metrics (Fix 6)
    └── flushMetricsBuffer(D1) — single D1 write

FEED_QUEUE (batch:10 — Fix 4) → processFeeds()
    ├── getFeedHealthRecord(D1, KV, url) — reads D1 (Fix 1)
    ├── runAllConnectors → in-mem dedup → batchInsertJobs(D1)
    ├── batchRecordFeedResults(D1, KV, results) — writes D1 (Fix 1)
    ├── JOB_QUEUE.sendBatch()
    ├── bufferMetrics() (Fix 6)
    └── flushMetricsBuffer(D1)

JOB_QUEUE (batch:10 — Fix 4) → evaluateJobs()
    ├── Queue depth check (Fix 7) — if >200 jobs, keyword-only mode
    ├── getEffectiveThreshold(D1) (Fix 1)
    ├── Per job: keyword gate → [AI if not backlogged] → scoreJob()
    ├── recordJobScoresBatch(D1) — scores + histogram (Fix 1)
    ├── In-memory chunks only (Fix 3) — no D1 chunk writes
    ├── bufferMetrics() (Fix 6)
    └── flushMetricsBuffer(D1)

ALERT_QUEUE (batch:10 — Fix 4) → sendAlerts()
    ├── Discord + Telegram delivery
    ├── bufferMetrics() (Fix 6)
    └── flushMetricsBuffer(D1)
```

---

## 15.6 Verification Checklist

| Check | Command | Expected |
|---|---|---|
| Migration applies cleanly | `npx wrangler d1 migrations apply job-hunter-db` | All ✅ |
| 3 cron triggers deployed | `npx wrangler deploy` | Shows 3 `schedule:` lines |
| KV writes within budget | Check daily report → Resource Safety section | < 1,000 writes |
| Queue batch size | Check wrangler.jsonc consumers | `max_batch_size: 10` |
| No chunk D1 writes | Check Worker logs for "not persisted" | Present in evaluateJobs logs |
| Metrics buffered | Check Worker logs for "Metrics flush" | Single flush per handler |
| Search cache hits | Check Worker logs for "Cache HIT" | After first run of each day |

---

_Implemented as part of the architecture optimization sprint. See [architecture_issues_and_fixes.md](../architecture_issues_and_fixes.md) for the original analysis._  
_System version: v5.3.0 | Architecture: event-driven-queues | Platform: Cloudflare Workers_
