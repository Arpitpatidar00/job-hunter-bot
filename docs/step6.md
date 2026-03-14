# Step 6 — Processing Workers & CPU Model

## Overview

The Cloudflare Worker has exactly **three worker functions** — one per queue. Each function is invoked independently and must complete within Cloudflare's strict CPU and wall-time limits.

```
Worker export:
  fetch()      → HTTP handler
  scheduled()  → Cron producer
  queue()      → Queue consumer router
```

---

## 6.1 Worker 1: Producer (`scheduled()`)

**Function:** `_scheduledImpl()`  
**CPU budget:** ~10–50ms CPU time  
**Wall-time limit:** 30 seconds  

This worker's job is to **dispatch work to queues** — it itself does minimal computation:

| Task | CPU Cost |
|---|---|
| `getAndIncrementCycle()` | ~2ms (one KV read+write) |
| `buildSourceList()` | <1ms (in-memory array ops) |
| `getEnabledSources()` | ~5ms (D1 query) |
| `getSourcesForCycle()` | ~5ms (D1 query + sort) |
| `FEED_QUEUE.sendBatch()` | ~50ms (network round-trips × batches) |
| `recalculatePriorities()` | ~10ms (every 4 cycles, D1 update) |
| `runSearchExpansion()` | ~500–2000ms (every 8 cycles, external search) |
| `cleanupStale*()` | ~5ms (D1 DELETE queries) |

> **Total CPU for a normal cycle:** ~50–100ms CPU  
> **With search expansion:** ~2–3 seconds wall-time

---

## 6.2 Worker 2: Fetcher (`processFeeds()`)

**Function:** `processFeeds(messages, env, ctx)`  
**CPU budget:** ~200–500ms per batch  
**Wall-time limit:** 30 seconds  

The heaviest worker in terms of **network I/O**. It has to:
1. Fetch up to 5 sources in parallel (per batch)
2. Parse XML/JSON responses
3. Normalize jobs
4. Run in-memory dedup
5. Batch insert to D1

### CPU Profile:
| Task | CPU Cost |
|---|---|
| Circuit breaker check | ~10ms (KV reads × 5 sources) |
| RSS XML parsing | ~20–80ms per feed |
| ATS JSON parsing | ~5–20ms per source |
| In-memory dedup | <1ms (Set operations) |
| D1 batch insert | ~30–100ms |
| Queue sendBatch | ~50ms |
| KV health writes | ~20ms (circuit breaker update) |

> **Total wall-time per batch:** ~500ms–2 seconds

### Non-Blocking I/O Pattern:

The worker returns control to Cloudflare quickly and uses `ctx.waitUntil()` for the heavy D1/queue operations:

```js
ctx.waitUntil(
  (async () => {
    const { inserted, duplicates } = await batchInsertJobs(env.DB, dedupedJobs);
    // ... D1 source stats, queue send, source discovery
    for (const msg of messages) msg.ack();
  })().catch(err => {
    for (const msg of messages) msg.retry();
  })
);
```

This ensures the Worker returns a `200 OK` to Cloudflare's queue infrastructure immediately, while the actual work completes after.

---

## 6.3 Worker 3: Evaluator (`evaluateJobs()`)

**Function:** `evaluateJobs(messages, env, ctx)`  
**CPU budget:** ~500ms–3 seconds per batch  
**Wall-time limit:** 22 seconds (hard-coded guard, 8s before Cloudflare's 30s kill)

This is the most CPU-intensive worker. For each job it:
1. Pre-filters with keyword gate
2. Optionally generates AI embedding (Workers AI call)
3. Scores the job (13-layer algorithm)
4. Checks alert threshold
5. Queues alerts

### CPU Guard:
```js
const WALL_TIME_LIMIT_MS = 22_000;
if (Date.now() - EVAL_START > WALL_TIME_LIMIT_MS) {
  logger.warn(`[Evaluator] Wall-time guard: evaluated ${jobsEvaluated} jobs... deferring rest.`);
  break;
}
```

Jobs evaluated after 22 seconds are deferred to the next queue delivery (messages are retried).

### AI Skip Optimization:
```js
const quickKeywordScore = computeQuickKeywordScore(job, config);
const SKIP_AI_THRESHOLD = 75;

if (quickKeywordScore < SKIP_AI_THRESHOLD) {
  // Run AI embedding (expensive)
  chunkVecs = await embedChunks(env.AI, env.SEEN_JOBS, job.id, chunks);
} else {
  // Skip AI — keyword score is strong enough
}
```

**Impact:** Reduces AI API calls by ~60–70% on days with strong keyword matches.

### CPU Profile Per Job:

| Task | CPU Cost |
|---|---|
| `hasBasicKeywordMatch()` | <1ms (regex cache + Set) |
| `computeQuickKeywordScore()` | <1ms |
| `embedChunks()` (if needed) | 100–300ms (Workers AI network call) |
| `scoreJob()` (13-layer) | 5–15ms |
| `applyFeedbackBoost()` | <1ms |
| `ALERT_QUEUE.send()` | 50ms |

> **Per-job cost:** ~10ms (keyword skip) to ~500ms (with AI)

---

## 6.4 Worker 4: Sender (`sendAlerts()`)

**Function:** `sendAlerts(messages, env, ctx)`  
**CPU budget:** ~100–300ms per batch  
**Wall-time limit:** 30 seconds  

The simplest worker — receives an alert payload and sends it:

```js
for (const msg of messages) {
  const { profileId, job, scoreResult } = msg.body;
  const stats = await sendAlert(job, scoreResult, { dryRun, config, env });

  if (stats.sent > 0) {
    msg.ack();
  } else {
    msg.retry({ delaySeconds: 60 * 15 }); // Retry after 15 minutes
  }
}
```

### Retry Behavior:
- If Discord returns 429 → `fetchWithRetry()` waits `Retry-After` header duration
- If Telegram returns 4xx/5xx → error logged, thrown
- If ALL channels fail → `msg.retry({ delaySeconds: 900 })` — retry in 15 min
- Up to **5 retries** before Cloudflare drops the message

---

## 6.5 CPU Optimization Techniques

| Technique | Module | Savings |
|---|---|---|
| Module-level config cache | `worker.js` | ~15ms per invocation |
| Regex cache (`_regexCache`) | `worker.js` | ~60ms/cycle |
| Scoring regex cache | `relevance-v4.js` | ~40ms/cycle |
| FastMatcher (Trie pattern scan) | `fastMatcher.js` | O(N) instead of O(N×K) |
| Batch D1 inserts (vs per-job) | `worker.js` | ~200–500ms per batch |
| Batch KV writes | `threshold.js` | ~50ms per evaluation batch |
| Profile embedding cache (KV) | `ai.js` | Saves 1 AI call / 24h |
| AI skip for high keyword score | `worker.js` | Saves ~60% AI calls |
| Wall-time guard (22s) | `worker.js` | Prevents hard kill |

---

## 6.6 Concurrency Model

Cloudflare Workers use a **single-threaded event loop** with async I/O:
- No shared memory between invocations
- No threads or worker pools
- Concurrency is achieved through `Promise.allSettled()` for parallel fetches
- `ctx.waitUntil()` extends the execution context without blocking

```js
// Parallel connector execution (up to 7 concurrent)
const results = await Promise.allSettled([
  fetchRssFeed(url1),
  fetchGreenhouseBoard(url2),
  fetchLeverBoard(url3),
  // ...
]);
```

---

## Flow Diagram

```
FEED_QUEUE (5 messages)
    └─→ processFeeds()
         ├── Parallel HTTP fetches (up to 7)
         ├── In-memory dedup
         ├── ctx.waitUntil(batchInsertJobs + sendBatch)
         └── msg.ack() / msg.retry()

JOB_QUEUE (5 messages × 10 jobs each = up to 50 jobs)
    └─→ evaluateJobs()
         ├── Profile embedding (cached in KV)
         ├── Per-job: keyword gate → [AI?] → scoreJob() → threshold
         ├── ctx.waitUntil(postEvaluationCleanup)
         └── msg.ack()

ALERT_QUEUE (5 messages)
    └─→ sendAlerts()
         ├── Discord embed → HTTP POST
         ├── Telegram message → HTTP POST
         └── msg.ack() / msg.retry(delay=15min)
```

**CPU limits:** 10ms–50ms (producer), 500ms–3s (evaluator)  
**Wall-time limit:** 30 seconds (22s self-imposed in evaluator)  
**Concurrency:** Up to 7 parallel HTTP fetches per processFeeds batch
