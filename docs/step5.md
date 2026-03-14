# Step 5 — Queue Architecture

## Overview

The system uses **three Cloudflare Queues** to decouple stages of the pipeline. Each queue is independently scalable, has its own consumer, retry policy, and batch configuration.

```
FEED_QUEUE  →  processFeeds()  →  JOB_QUEUE  →  evaluateJobs()  →  ALERT_QUEUE  →  sendAlerts()
```

---

## 5.1 Why Queues?

Without queues, the Worker would need to:
1. Fetch all 30+ feeds
2. Score every new job
3. Send alert notifications

All in one synchronous execution within Cloudflare's **30-second wall-time limit** and **10–50ms CPU time limit**.

Queues break this into three **independent, fault-tolerant stages**:
- Each stage can retry independently
- Stages don't block each other
- Backpressure is handled naturally

---

## 5.2 Queue Configuration (`wrangler.jsonc`)

```json
"queues": {
  "producers": [
    { "queue": "feed-queue",  "binding": "FEED_QUEUE"  },
    { "queue": "job-queue",   "binding": "JOB_QUEUE"   },
    { "queue": "alert-queue", "binding": "ALERT_QUEUE" }
  ],
  "consumers": [
    { "queue": "feed-queue",  "max_batch_size": 5, "max_batch_timeout": 2, "max_retries": 2 },
    { "queue": "job-queue",   "max_batch_size": 5, "max_batch_timeout": 2, "max_retries": 3 },
    { "queue": "alert-queue", "max_batch_size": 5, "max_batch_timeout": 2, "max_retries": 5 }
  ]
}
```

---

## 5.3 Queue 1: `feed-queue`

| Property | Value |
|---|---|
| **Purpose** | Deliver source definitions (URLs) to the fetcher |
| **Producer** | `_scheduledImpl()` cron handler |
| **Consumer** | `processFeeds()` |
| **Batch size** | 5 messages |
| **Timeout** | 2 seconds max wait |
| **Retries** | 2 (lowest — upstream failure is discarded to avoid re-scanning dead sources) |
| **Message payload** | Source definition: `{ url, type, name, etag, lastModified }` |

### Message Flow:
```
_scheduledImpl() builds source list (up to 40 sources)
    → sendBatch() in chunks of 10 with 100ms pacing
    → feed-queue receives 40 messages
    → Cloudflare delivers them in batches of 5 to processFeeds()
    → processFeeds() runs 8 times (40 / 5)
```

### Why max_retries=2?
Feed sources that fail twice in a row should be handled by the circuit breaker, not retried forever. Aggressive retry here wastes queue budget.

---

## 5.4 Queue 2: `job-queue`

| Property | Value |
|---|---|
| **Purpose** | Deliver new jobs from fetcher to evaluator/scorer |
| **Producer** | `processFeeds()` (inside waitUntil) |
| **Consumer** | `evaluateJobs()` |
| **Batch size** | 5 messages |
| **Timeout** | 2 seconds |
| **Retries** | 3 |
| **Message payload** | Slim job object (stripped of heavy fields) |

### Slim Job Projection:

To stay under the **128KB Cloudflare Queue payload limit**, jobs are stripped of heavy text before being queued:

```js
function slimJob(job) {
  return {
    id, title, company, url, link,
    categories, matchedTerms, content_hash,
    contentSnippet: job.contentSnippet || "",  // truncated
    sourceUrl, publishedAt, isoDate, pubDate,
    // DROPPED: description, content, body, other large fields
  };
}
```

### Chunk Size:
```js
const JOB_CHUNK_SIZE = 10; // 10 jobs per queue message
```

For 50 new jobs: 5 queue messages sent, each carrying 10 slim job objects.

---

## 5.5 Queue 3: `alert-queue`

| Property | Value |
|---|---|
| **Purpose** | Deliver qualified match events to the notifier |
| **Producer** | `evaluateJobs()` |
| **Consumer** | `sendAlerts()` |
| **Batch size** | 5 messages |
| **Timeout** | 2 seconds |
| **Retries** | 5 (highest — alert delivery is business-critical) |
| **Retry delay** | 15 minutes between retries |
| **Message payload** | `{ profileId, job (slim), scoreResult (slim) }` |

### Slim Alert Payload:
```js
const slimAlertJob = {
  id, title, company,
  url: job.url || job.link,
  link, categories,
  contentSnippet: (job.contentSnippet || "").slice(0, 300),
  sourceUrl, isoDate,
  // Reduces payload from ~5KB to ~2KB
};
const slimScoreResult = {
  score, label, color, matchedSkills, reasons,
  // DROP: full breakdown/features to save queue space
};
```

### Why max_retries=5?
Alert delivery to Discord/Telegram can fail due to rate limits (429) or transient network issues. With 5 retries at 15-minute intervals, the system can survive up to ~75 minutes of downtime and still deliver the notification.

---

## 5.6 Queue Router

**`queueHandler(batch, env, ctx)`** routes messages to the correct consumer:

```js
async function queueHandler(batch, env, ctx) {
  const queueName = batch.queue;
  if (queueName === "feed-queue")  return processFeeds(batch.messages, env, ctx);
  if (queueName === "job-queue")   return evaluateJobs(batch.messages, env, ctx);
  if (queueName === "alert-queue") return sendAlerts(batch.messages, env, ctx);
  // Unknown queue → log error, ack all messages
}
```

Wrapped in a global try-catch:
```js
async queue(batch, env, ctx) {
  try {
    await queueHandler(batch, env, ctx);
  } catch (err) {
    // Retry ALL messages on unhandled crash to prevent message loss
    for (const msg of batch.messages) msg.retry();
  }
}
```

---

## 5.7 Message Acknowledgment Strategy

| Scenario | Action |
|---|---|
| Successful processing | `msg.ack()` — message removed from queue |
| Transient failure | `msg.retry()` — message re-queued after delay |
| Circuit breaker skip | `msg.ack()` — silently drop (not a failure) |
| D1 insert succeeds | `msg.ack()` — only after successful insert |
| D1 insert fails | `msg.retry()` — re-queued so no job is lost |

### Critical Pattern:
```js
// Only ack messages AFTER D1 insert succeeds.
// If D1 insert failed, retry the messages
for (const msg of messages) {
  try { msg.ack(); } catch { /* already acked */ }
}
```

---

## 5.8 Rate-Limit Handling + Direct Fallbacks

Cloudflare Queues can return HTTP 429 (Too Many Requests) during bursts. The system handles this with:

### Retry with Exponential Backoff:
```js
async function withRetry(fn, maxRetries = 3, baseDelayMs = 200) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); }
    catch (err) {
      const delay = baseDelayMs * 2**attempt + Math.random() * 200;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
```
Worst-case wait: ~1.5 seconds total (well within 30s wall-time).

### Direct Fallback (Queue Failure):
If all retries fail:
- **Feed queue fail:** Process top 3 priority sources inline
- **Job queue fail:** Evaluate top 10 jobs directly (via `evaluateJobsFallback()`)
- **Alert queue fail:** Send alert directly via `sendAlert()` inline

```js
if (!jobQueueSuccess && newJobs.length > 0) {
  const fallbackJobs = newJobs.slice(0, 10);
  ctx.waitUntil(evaluateJobsFallback(fallbackJobs, env, ctx));
}
```

---

## 5.9 Message Pacing

To avoid overloading the queue:
```js
for (const batch of batches) {
  await withRetry(() => env.FEED_QUEUE.sendBatch(batch));
  await new Promise(r => setTimeout(r, 100)); // 100ms between batch sends
}
```

This introduces a controlled 100ms delay between batch sends.

---

## Flow Diagram

```
Cron
 └─→ _scheduledImpl()
      └─→ FEED_QUEUE.sendBatch(40 sources, in 10-message batches)

FEED_QUEUE delivers (batches of 5)
 └─→ processFeeds()
      └─→ JOB_QUEUE.sendBatch(new jobs, in 10-job chunks)

JOB_QUEUE delivers (batches of 5)
 └─→ evaluateJobs()
      └─→ ALERT_QUEUE.send(qualified matches)

ALERT_QUEUE delivers (batches of 5)
 └─→ sendAlerts()
      └─→ Discord webhook / Telegram API
```

**Queues used:** `feed-queue`, `job-queue`, `alert-queue`  
**Retry policy:** 2 / 3 / 5 (ascending by criticality)  
**Fallback:** Inline direct processing when queues are rate-limited
