# Step 13 — Architecture Optimization Analysis

## Overview

This document provides an expert-level analysis of the system's current architecture, identifying performance bottlenecks, scalability risks, resource waste, and concrete improvement recommendations.

---

## 13.1 ✅ What Works Well (Strengths)

| Strength | Reason |
|---|---|
| **Three-queue pipeline** | Decouples stages, allows independent retry/scaling |
| **SimHash + FNV-1a dedup** | O(1) per job, no network I/O for in-batch dedup |
| **FastMatcher (Trie)** | O(N) scan vs O(N×K) regex — critical for high job volume |
| **Module-level config cache** | Prevents re-parsing JSON on every invocation |
| **ctx.waitUntil() offloading** | Returns queue ack quickly; I/O finishes asynchronously |
| **AI skip optimization** | Skips embedding for >70% of jobs → 60-70% fewer AI calls |
| **Batch D1 writes (40 per tx)** | Dramatically reduces D1 round-trips |
| **Dynamic threshold engine** | Self-tuning; prevents alert fatigue without manual tuning |
| **Circuit breaker + jitter** | Prevents thundering herd; auto-recovers failing feeds |
| **Direct fallback cascade** | Three-tier fallback ensures partial operation under queue failures |

---

## 13.2 🔴 Critical Issues

### Issue 1: KV Write Volume Exceeds Free Tier

**Problem:** Current operations sum to ~4,876 KV writes/day vs. 1,000/day free limit.

**Root Cause:** Per-feed circuit breaker writes (40 writes × 96 cron = 3,840/day) dominate the budget.

**Fix:**
```
Option A: Migrate feed health records from KV to D1 
  → Feed health as a D1 table column (source_registry already exists)
  → Only KV for: threshold, embedding cache, discovery stats → ~150 writes/day

Option B: Upgrade to Workers Paid plan (~$5/mo)
  → 1M KV writes/day → completely solved
```

**Estimated impact:** Bringing KV writes from ~5K to ~150/day on the free tier.

---

### Issue 2: Feed Queue Batch Size Is Too Small

**Problem:** `max_batch_size: 5` for `feed-queue` means 8 separate Worker invocations per cron to process 40 sources. Each invocation has overhead.

**Fix:** Increase to `max_batch_size: 10`:
```json
{ "queue": "feed-queue", "max_batch_size": 10, "max_batch_timeout": 5 }
```

**Impact:** Halves the number of `processFeeds` invocations (8 → 4 per cron), reducing overhead by ~50%.

---

### Issue 3: AI Chunk Storage Growing Unboundedly

**Problem:** `job_chunks` TTL is 7 days. At 100 jobs/day × 5 chunks each = 500 rows/day × 7 days = **3,500 rows** always present.

**Observation:** Chunks are only used at query time within the same `evaluateJobs()` invocation. Cross-invocation chunk retrieval is not currently implemented — chunks are rebuilt from AI each run.

**Fix:** Reduce TTL to 24 hours or switch to in-memory-only storage:
```js
// Instead of storing chunks in D1, keep them only in memory during evaluateJobs()
// Saves ~500 D1 writes/day and reduces job_chunks table growth
```

**Impact:** Reduces D1 storage by ~3,000+ rows. Reduces daily D1 writes by ~500.

---

### Issue 4: Single Cron Expression — No True Batch Stagger

**Problem:** The `batcher.js` logic maps cron minute → batch ID, but the current `wrangler.jsonc` only has ONE cron expression (`0,15,30,45 * * * *`). All triggers are batch 0 since minutes `:00/:15/:30/:45` always map to `batchId=0`.

**Fix:** Add two more cron expressions:
```json
"crons": [
  "0,15,30,45 * * * *",   // Batch 0
  "5,20,35,50 * * * *",   // Batch 1
  "10,25,40,55 * * * *"   // Batch 2
]
```

**Impact:** True 3-batch staggering — each cron processes only 1/3 of feeds, reducing CPU per invocation by ~66%.

---

## 13.3 🟡 Scalability Risks

### Risk 1: Search Expansion Has No Per-Query Caching

`runSearchExpansion()` re-queries Bing/Brave for the same queries every 8 cycles. Companies like Stripe and Vercel appear in queries repeatedly.

**Fix:** Cache query → domains results in KV for 24 hours:
```js
const cacheKey = `search:cache:${fnvHash(query)}`;
const cached = await kv.get(cacheKey);
if (cached) return JSON.parse(cached);
```

---

### Risk 2: No Back-Pressure Signal to D1 Writes

When a high-volume feed returns 500 new jobs in one cycle, the system attempts to insert all 500 in one `batchInsertJobs()` call (40 per transaction = 13 D1 batches). At high volume, this causes CPU spikes.

**Fix:** Add a `MAX_JOBS_PER_BATCH = 200` cap:
```js
const cappedJobs = dedupedJobs.slice(0, 200); // Process rest next cycle via queue
```

---

### Risk 3: Profile Embedding TTL Is 24 Hours

The profile embedding is cached in KV for 24 hours. If the user modifies `config.json` (add/remove mustMatch), the old embedding is used until TTL expires.

**Fix:** Include a hash of the profile spec in the KV key:
```js
const profileHash = fnvHash(profileSpecs);
const cacheKey = `profile:embedding:${profileHash}`;
```

---

### Risk 4: No Alerting on Queue Backlog Buildup

If `evaluateJobs()` runs slower than incoming jobs (high AI usage days), the `job-queue` can build up a backlog. There's no monitoring for this.

**Fix:** Track queue depth via `incrementDailyMetrics(DB, { queue_backlog: pendingCount })` and add a dashboard warning when backlog > 100.

---

## 13.4 🟡 Resource Waste

### Issue 1: Daily Metrics Writes Are Redundant

`incrementDailyMetrics()` is called multiple times per cron cycle:
- Phase 1: after job insert
- Phase 2: after discovery  
- Once in `_scheduledImpl()`

That's **3 D1 batch calls per cron** for metrics alone = 288 writes/day just for daily_metrics.

**Fix:** Accumulate all metrics in a local object and write once at the end of each stage:
```js
const metricsBuffer = {};
// ... all stages ...
await incrementDailyMetrics(env.DB, metricsBuffer); // 1 write instead of 3
```

**Savings:** ~66% reduction in daily_metrics D1 writes.

---

### Issue 2: `getTerm Frequencies()` Pre-Fetch Is Underused

`getGlobalTermFrequencies()` fetches IDF data for all mustMatch terms before scoring. But if AI skip fires for >70% of jobs, TF-IDF is computed for those jobs anyway. The IDF data is used even when AI is skipped, which is fine — but it's fetched once per `evaluateJobs()` batch, which is correct behavior.

**Assessment:** No waste — this is already optimally batched.

---

### Issue 3: Discovery Runs Even When Source Registry Is Healthy

If there are already 100+ active, healthy sources with high yields, running discovery every 8 cycles still incurs Bing/Brave HTTP requests with no benefit.

**Fix:** Skip discovery if source health is strong:
```js
if (sources.active >= 80 && successRate >= 90) {
  logger.info('[SearchExpander] Skipping — source registry is healthy');
  return;
}
```

---

## 13.5 Design Improvements

### Improvement 1: Move Chunk Embeddings to In-Memory Only
- RAG v4 stores chunks in D1 but only uses them during the same `evaluateJobs()` invocation
- Storing them wastes D1 writes with no cross-invocation reuse
- **Implement:** Build `TopKChunks` purely in-memory, remove `job_chunks` D1 table writes

### Improvement 2: Dedicated Score Cache per Profile
- Currently all profiles use the same global threshold
- Per-profile score windows would allow personalized adaptive thresholds
- **Implement:** `thresh:window:{profileId}` in KV

### Improvement 3: Add Job Quality Signals
- Jobs could be weighted by company reputation (GitHub stars, employee count)
- Or weighted by source quality (historically high-yield sources surface better jobs)
- **Implement:** `source.avg_job_score` tracked in `source_registry`

### Improvement 4: Webhook Push from Job Boards
- Instead of polling every 15 minutes, subscribe to RSS webhooks (some boards support PubSubHubbub/WebSub)
- Near-instant notification instead of up-to-15-minute delay

---

## 13.6 Summary Table

| Category | Issue | Severity | Effort |
|---|---|---|---|
| Resources | KV writes exceed free tier | 🔴 Critical | Low (migrate to D1) |
| Scaling | Single cron — no true stagger | 🔴 Critical | Low (add 2 cron expressions) |
| Resources | job_chunks growing unboundedly | 🟡 Medium | Low (reduce TTL or remove) |
| Performance | Feed queue batch too small | 🟡 Medium | Low (config change) |
| Reliability | Profile embedding stale after config change | 🟡 Medium | Low (hash-keyed cache) |
| Resources | Daily metrics 3× writes per cycle | 🟡 Medium | Medium (buffer + single write) |
| Scaling | No queue backlog monitoring | 🟡 Medium | Medium |
| Scaling | Discovery runs always (no health gate) | 🟢 Low | Low |
| Design | Chunk embeddings stored but unreused | 🟢 Low | Medium |
| Design | No per-profile score windows | 🟢 Low | Medium |
