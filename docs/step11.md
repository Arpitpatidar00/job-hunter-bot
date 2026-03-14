# Step 11 — Failure Handling

## Overview

The system has multiple layers of fault tolerance designed to prevent data loss and maintain operation during partial failures. Every critical operation has either a retry mechanism, a circuit breaker, or a direct fallback.

```
Failure Type          → Handler
─────────────────────────────────────────────────────
Queue rate-limited    → withRetry() → direct inline fallback
Feed HTTP failure     → circuit breaker (KV) → skip until recovered
D1 insert failure     → msg.retry() (messages re-queued)
Alert delivery fail   → msg.retry({ delay: 15min }) × 5
Worker crash          → msg.retry() for all messages
Feed parsing error    → feedStats[].error recorded, next source proceeds
CPU time exceeded     → wall-time guard (22s) → remaining jobs deferred
```

---

## 11.1 Circuit Breaker Pattern

**Module:** `src/intelligence/feedHealth.js`

Each feed has a circuit breaker that opens after **5 consecutive failures** and stays open for a dynamic cooldown period:

```
Failure count < 3  → HEALTHY (crawl normally)
Failure count 3–4  → DEGRADED (soft downgrade, crawl less often)
Failure count ≥ 5  → CIRCUIT OPEN (skip entirely until cooldown expires)
```

### Cooldown Calculation:
```js
function calculateCooldown(consecutiveFailures) {
  const factor = Math.pow(2, Math.max(0, consecutiveFailures - OPEN_THRESHOLD));
  const cooldown = Math.min(MAX_COOLDOWN_SECONDS, BASE_COOLDOWN_SECONDS * factor);
  const jitter = cooldown * 0.2 * (Math.random() * 2 - 1); // ±20% jitter
  return Math.round(cooldown + jitter);
}
```

| Consecutive Failures | Cooldown |
|---|---|
| 5 | ~5 minutes |
| 6 | ~10 minutes |
| 7 | ~20 minutes |
| 8+ | up to 4 hours |

**Jitter** (±20%) prevents the thundering herd problem where all failed sources retry simultaneously.

### Auto-Recovery:
```js
if (success) {
  record.consecutiveFailures = 0;
  await kv.delete(circuitKey(feedUrl)); // Remove circuit-open flag
}
```

The circuit resets **on first success** — no manual intervention required.

---

## 11.2 Retry with Exponential Backoff

**Used for:** Queue send operations, search engine KV writes

```js
async function withRetry(fn, maxRetries = 3, baseDelayMs = 200) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 200;
      logger.warn(`[Retry] Attempt ${attempt+1}/${maxRetries+1}, retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
```

Worst-case total wait: 200ms + 400ms + 800ms + jitter ≈ **~1.5 seconds**  
Designed to stay well within the 30-second wall-time limit.

---

## 11.3 Direct Fallback Cascade

When queues are rate-limited (HTTP 429), the system has a **three-tier fallback**:

### Tier 1: FEED_QUEUE fails
```js
// Only process top 3 priority sources inline, deferred via waitUntil
ctx.waitUntil(processFeeds(top3Sources, env, ctx));
```

### Tier 2: JOB_QUEUE fails
```js
// Process only top 10 jobs directly (avoids CPU time limit)
const fallbackJobs = newJobs.slice(0, 10);
ctx.waitUntil(evaluateJobsFallback(fallbackJobs, env, ctx));
```

### Tier 3: ALERT_QUEUE fails
```js
// Send alert inline, synchronously  
await sendAlert(job, scoreResult, { dryRun, config, env, attempt: 1 });
```

This three-tier cascade ensures that even a complete queue failure results in at least **partial coverage** for the highest-priority items.

---

## 11.4 Message Acknowledgment Safety

The critical pattern for preventing message loss:

```js
ctx.waitUntil(
  (async () => {
    const { inserted } = await batchInsertJobs(env.DB, dedupedJobs);
    // ... all writes complete ...
    
    // Only ack AFTER all writes succeed
    for (const msg of messages) msg.ack();
  })().catch(criticalErr => {
    // If anything fails → RETRY (not ack) to prevent data loss
    for (const msg of messages) msg.retry();
  })
);
```

**Messages are never acked until the D1 insert succeeds.** If the worker crashes mid-write, Cloudflare delivers the messages again.

---

## 11.5 Wall-Time Guard (CPU Overflow Protection)

```js
const WALL_TIME_LIMIT_MS = 22_000; // 22-second self-limit (Cloudflare kills at 30s)

for (let i = 0; i < newJobsToEvaluate.length; i++) {
  if (Date.now() - EVAL_START > WALL_TIME_LIMIT_MS) {
    logger.warn(`[Evaluator] Wall-time guard hit at ${jobsEvaluated} jobs`);
    break; // Remaining jobs stay in queue, retried next delivery
  }
  // ... score job
}
```

Remaining un-evaluated jobs stay in the queue and are re-delivered in the next batch cycle.

---

## 11.6 Foreign Key Constraint Protection (D1)

`batchMarkAlertSent()` uses a subquery join to ensure both `jobs.id` AND `profiles.id` exist before inserting:

```sql
INSERT INTO sent_alerts (job_id, profile_id, sent_at)
  SELECT j.id, p.id, datetime('now')
  FROM jobs j
  JOIN profiles p ON p.id = ?
  WHERE j.id = ?
```

This prevents FK constraint failures that could corrupt the `sent_alerts` table during race conditions.

---

## 11.7 Error Classification

| Error Type | Recovery Action |
|---|---|
| `HTTP 429 (Queue rate limit)` | `withRetry()` × 3, then direct fallback |
| `HTTP 429 (Discord rate limit)` | `Retry-After` header wait, up to 3 attempts |
| `HTTP 503/504 (Feed down)` | Circuit breaker: skip for 5min+ |
| `D1 insert failure` | `msg.retry()` — re-queue all messages |
| `D1 FK constraint` | Subquery join guard prevents occurrence |
| `KV write 429` | `kvPutRetry()` with exponential backoff |
| `Worker CPU exceeded` | Wall-time guard breaks loop, messages retried |
| `Worker crash (unhandled)` | Global try-catch → `msg.retry()` for all |
| `Parsing error (XML/JSON)` | Per-feed error recorded in feedStats, others continue |
| `AI embedding failure` | Gracefully continues without AI boost |

---

## 11.8 Unhandled Exception Safety Net

Every exported handler is wrapped in a global try-catch:

```js
// scheduled()
async scheduled(event, env, ctx) {
  try { await _scheduledImpl(event, env, ctx); }
  catch (err) { logger.error(`Unhandled cron error: ${err.message}`, { stack: err.stack }); }
}

// queue()
async queue(batch, env, ctx) {
  try { await queueHandler(batch, env, ctx); }
  catch (err) {
    logger.error(`Unhandled queue error (${batch.queue}): ${err.message}`);
    for (const msg of batch.messages) msg.retry(); // Retry all
  }
}
```

This ensures no failure causes silent message loss.

---

## Failure Resilience Map

```
Feed HTTP error
    └─→ recordFeedResult(failure) → consecutive_failures++
            → ≥3 failures → DEGRADED (log warning)
            → ≥5 failures → CIRCUIT OPEN (KV flag set, dynamic cooldown)
            → First success → circuit reset, KV flag deleted

Queue rate limit
    └─→ withRetry(fn, maxRetries=3, baseDelay=200ms)
            → if still failing → direct fallback (top 3/10 inline)
            → msg.retry() for remaining

Worker CPU exceeded
    └─→ wall-time guard (22s) → break scoring loop
            → remaining messages stay queued → retried next delivery

Full worker crash
    └─→ global catch → msg.retry() → Cloudflare re-delivers

Alert channel down
    └─→ msg.retry({ delaySeconds: 900 }) × 5 = 75min resilience window
```
