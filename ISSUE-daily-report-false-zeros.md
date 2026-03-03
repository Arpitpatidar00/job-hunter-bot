# ISSUE: Daily Intelligence Report Shows All Zeros Despite Active Job Processing

**Date Identified:** March 3, 2026  
**Severity:** Critical  
**Status:** Root causes identified, partial fixes applied, not fully resolved  
**Component:** Daily Metrics Pipeline (`daily_metrics` table, queue consumers, `incrementDailyMetrics`)

---

## Summary

The Daily Intelligence Report generates a report with **all zero values** across every metric (sources scanned, jobs stored, alerts sent, AI calls, etc.), even though the system is actively fetching, storing, and delivering jobs. The D1 `jobs` table had **3,706 jobs (1,889 inserted today)** but `daily_metrics` showed zeros for everything except `worker_invocations: 2` and `cycles_completed: 2`.

---

## Evidence

### Remote D1 `daily_metrics` (all zeros):
```
sources_scanned: 0, crawl_successes: 0, crawl_failures: 0,
raw_jobs_found: 0, unique_jobs_stored: 0, duplicates_filtered: 0,
alerts_sent: 0, ai_calls: 0, worker_invocations: 2,
queue_messages: 0, cycles_completed: 2
```

### Remote D1 `jobs` table (active data):
```
total: 3706, today: 1889, latest: 2026-03-03T04:46:xx
```

### Local D1 (via `wrangler dev --local`) had correct metrics:
```
sources_scanned: 165, unique_jobs_stored: 2209, crawl_successes: 155, ...
```

This proves the `incrementDailyMetrics` function **works correctly in code** — it just never executes in the deployed queue consumers.

---

## Root Causes (3 Layered Issues)

### 1. `ctx.waitUntil` in Queue Consumer (Instead of `await`)

**Location:** `queue()` export in `src/worker.js`

```js
// BEFORE (broken)
async queue(batch, env, ctx) {
    ctx.waitUntil(queueHandler(batch, env));
}

// AFTER (fixed)
async queue(batch, env, ctx) {
    await queueHandler(batch, env);
}
```

**Impact:** `ctx.waitUntil` tells the runtime "I'm done, but keep the Worker alive for this promise." In queue consumers, this caused the handler to return immediately, and the runtime could kill the Worker before `incrementDailyMetrics` (which runs at the END of processing) had a chance to write to D1. The D1 binding context may also become invalid after the consumer returns.

### 2. Metrics Update Placed at END of Processing

**Location:** `processFeeds()`, `evaluateJobs()`, `sendAlerts()` in `src/worker.js`

All three queue consumers had the pattern:
```js
async function processFeeds(messages, env) {
    // ... 100+ lines of RSS fetching, dedup, DB inserts ...
    // ... source discovery, domain registration ...
    
    // Metrics update at the VERY END
    await incrementDailyMetrics(env.DB, { ... });  // ← Never reached if Worker times out
}
```

**Impact:** If any step before the metrics write fails, times out, or the Worker is killed, metrics are never recorded — even though jobs were successfully inserted into D1 earlier in the function.

### 3. Cloudflare Queues Free Tier Quota Exhaustion (PRIMARY CAUSE)

**The biggest issue.** The bot exhausted its **1,000,000 free queue operations/month** in just ~3 days.

**How:**
- Each cron cycle (every 15 min) sends **45 individual queue messages** to `FEED_QUEUE` (one per source)
- Each source produces ~40-50 jobs → each job sent as **individual message** to `JOB_QUEUE`
- Each matching job sent as **individual message** to `ALERT_QUEUE`
- Per cycle: ~45 (feed) + ~2000 (job) + ~50 (alert) = **~2,095 queue operations**
- Per day: 2,095 × 96 cycles = **~201,120 operations/day**
- By Day 3: **~600,000+ operations** consumed, quota exhausted

**Result:** All queue `send()` and `sendBatch()` calls return HTTP 429 "Too Many Requests". Since the entire pipeline is queue-driven:
- `scheduled()` can't send sources to `FEED_QUEUE` → no feeds fetched
- `processFeeds` can't send jobs to `JOB_QUEUE` → no jobs evaluated  
- `evaluateJobs` can't send alerts to `ALERT_QUEUE` → no alerts delivered
- Only `cycles_completed` and `worker_invocations` increment (they run in the scheduled handler before queue sends)

**Evidence:**
```
POST /trigger → {"status":"ok","msg":"Triggered 0/45 source messages to queue."}
```
Zero messages sent despite no code errors — pure quota exhaustion.

---

## Reproduction Steps

1. Deploy the Worker with the original queue architecture (1 message per job)
2. Let cron run for 2-3 days at 15-minute intervals with 45 sources
3. Check `daily_metrics` — all zeros except `worker_invocations` and `cycles_completed`
4. Check `jobs` table — thousands of jobs present (inserted before quota ran out)
5. Try `/trigger` endpoint — returns `0/45 sent`

---

## Attempted Fixes & Current State

| Fix | Status | Notes |
|-----|--------|-------|
| `ctx.waitUntil` → `await` in queue handler | Applied | Ensures queue consumer waits for full processing |
| Silent `catch {}` blocks → proper `logger.error()` | Applied | 6 silent catches replaced with error logging |
| Metrics moved to 2-phase approach (before discovery) | Applied | Phase 1 writes core metrics immediately after job loop |
| Metrics moved BEFORE evaluateJobs fallback | Applied | Ensures D1 write happens even if evaluation times out |
| Ground-truth backfill in report | Applied | Queries actual `jobs`/`sent_alerts` tables as fallback when `daily_metrics` shows zeros |
| JOB_QUEUE chunking (50 jobs per message) | Applied | Reduces queue ops from ~2000/cycle to ~40/cycle |
| evaluateJobs updated for batched `{ jobs: [...] }` format | Applied | Backward-compatible with legacy single-job format |
| `sendBatch()` for FEED_QUEUE in scheduled handler | Applied | Reduces 45 individual sends to 1 batch call |
| Direct-processing fallback when queues are rate-limited | Applied | Falls back to inline processing, but limited by Worker wall-time |
| ALERT_QUEUE direct fallback | Applied | Sends alerts inline when queue send fails |
| Wall-time guard (25s limit) | Applied | Prevents Worker timeout, but limits how many sources can be processed per cycle |

---

## Remaining Issues

1. **Queue quota still exhausted for the rest of the month** — the batching fix will prevent this in future months, but current month is blocked
2. **Direct fallback limited by Worker wall-time** — can only process ~5/45 sources per trigger/cron cycle (each batch of 5 sources takes ~20-25 seconds of RSS fetching + D1 writes + AI embedding)
3. **Metrics still showing zeros after direct fallback** — the metrics D1 write may be failing silently or the Worker is being killed before the write completes even with the earlier placement
4. **No monitoring/alerting for queue quota usage** — the bot silently degrades when quota runs out

---

## Queue Operations Budget (Post-Fix)

| Component | Before (per cycle) | After (per cycle) | Reduction |
|-----------|-------------------|-------------------|-----------|
| FEED_QUEUE | 45 individual sends | 1 sendBatch call | 98% |
| JOB_QUEUE | ~2000 individual sends | ~40 chunked sends (50 jobs each) | 98% |
| ALERT_QUEUE | ~50 individual sends | ~50 individual sends | 0% (not yet optimized) |
| **Total** | **~2,095 ops** | **~91 ops** | **~96%** |

**Projected monthly usage (post-fix):** 91 × 96 cycles/day × 30 days = **~262,080 ops/month** (well under 1M free limit)

---

## Affected Files

- `src/worker.js` — Main Worker: queue consumers, scheduled handler, HTTP endpoints
- `src/intelligence/dailyReport.js` — `incrementDailyMetrics()`, `getDailyReportData()`, `formatDailyReport()`
- `test-daily-report.js` — CLI test script for daily report
- `migrations/0007_daily_metrics.sql` — `daily_metrics` table schema

---

## Key Takeaway

The root cause was an **architecture cost miscalculation**: treating Cloudflare Queues as unlimited when the free tier has a hard 1M operations/month cap. Sending each individual job as a separate queue message was the design flaw that exhausted the quota in 3 days. Combined with `ctx.waitUntil` (instead of `await`) and metrics placed at the end of processing, this created a situation where the bot appeared fully functional (jobs were stored, alerts delivered) but the reporting/metrics layer was completely blind.
