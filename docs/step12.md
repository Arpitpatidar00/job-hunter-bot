# Step 12 — Scaling Model

## Overview

The system runs entirely on Cloudflare's global edge network. Scaling is inherent — the Worker runtime handles concurrency through queue delivery, not thread management. This step explains the concurrency model, resource limits, and how the system scales with feed count and job volume.

---

## 12.1 Cloudflare Worker Resource Limits

| Resource | Free Tier Limit | Paid Tier |
|---|---|---|
| Worker invocations | 100,000/day | 10 million+/day |
| CPU time (per invocation) | 10ms (cron: 400ms) | 30 seconds |
| Wall-clock time | 30 seconds | 30 seconds |
| Memory | 128 MB | 128 MB |
| Subrequests (fetch) | 50/invocation | 50/invocation |
| D1 reads | 5M/day | 25M/day |
| D1 writes | 100K/day | 50M/day |
| KV reads | 100K/day | 10M+/day |
| KV writes | 1,000/day | 1M+/day |
| Queue messages | 5M/month (free) | Tiered |

---

## 12.2 Worker Invocation Math (Current Config)

| Event | Frequency | Daily Count |
|---|---|---|
| Cron fires | Every 15 min | 96 |
| processFeeds (5 sources/batch) | 8 batches × 96 = 768 | 768 |
| evaluateJobs (5 per batch) | ~50 new jobs → 10 batches | ~960/day |
| sendAlerts | ~8 alerts per cycle → 2 batches | ~192/day |
| **Total invocations** | — | **~2,016/day** |

At 100,000/day free tier capacity → **~2% of free tier used**.

---

## 12.3 Concurrency Model

Cloudflare Workers are **single-threaded but concurrently deployed**:

- Each queue batch delivery creates a **new Worker isolate**
- Multiple isolates can run simultaneously across Cloudflare's PoPs
- Each isolate gets its own module-level state (no shared memory)

### Parallel Fetches Within One Invocation:
```js
// Up to 7 concurrent HTTP fetches in processFeeds()
const results = await Promise.allSettled([
  fetchRssFeed(url1),
  fetchGreenhouseBoard(url2),
  fetchLeverBoard(url3),
  // ...
]);
```

### How Queue Consumers Scale:

| Queue | Max Concurrent Batches | Effective Concurrency |
|---|---|---|
| `feed-queue` | Cloudflare-managed | Multiple processFeeds() in parallel |
| `job-queue` | Cloudflare-managed | Multiple evaluateJobs() in parallel |
| `alert-queue` | Cloudflare-managed | Multiple sendAlerts() in parallel |

As feed count grows, Cloudflare automatically delivers more batches in parallel.

---

## 12.4 Source Scaling

| Scale | Sources | Cron Batches | processFeeds Invocations |
|---|---|---|---|
| Current | ~47 sources | 40 per cycle | 8 per cron |
| 100 sources | 100 | 100 per cycle | 20 per cron |
| 500 sources | 500 | 100 (capped at MAX_SOURCES_PER_CYCLE=40 + priority selection) | 8 per cron |

**Scaling governor:** `MAX_SOURCES_PER_CYCLE = 40`

Only the **top 40 priority-ranked sources** are crawled per cycle. As sources multiply via discovery, low-yield sources are automatically tier-demoted and crawled less frequently — not more frequently.

---

## 12.5 Job Volume Scaling

| Jobs Found | Unique After Dedup | Queue Messages | evaluateJobs Invocations |
|---|---|---|---|
| 200 | 50 | 5 (10 jobs each) | 1 |
| 500 | 100 | 10 | 2 |
| 2,000 | 300 | 30 | 6 |

The AI skip optimization significantly reduces cost as volume grows:
- If 70% of jobs pass the keyword threshold with score > 75 → 70% skip AI
- At 300 jobs/cycle: ~90 AI calls vs ~300 without optimization

---

## 12.6 KV Write Budget Management

The KV free tier (1,000 writes/day) is the tightest constraint:

| Operation | Writes Per Cycle | Per Day (96 cycles) |
|---|---|---|
| Feed circuit breaker updates | 5/batch × 8 batches = 40 | 3,840 |
| Score histogram (batched) | 1/evaluateJobs batch | ~960 |
| Threshold updates | 1–2 (only if changed) | ~50 |
| Discovery stats | 1–2/expansion run | ~25 |
| Profile embedding cache | 1/24h | 1 |
| **Total** | | **~4,876/day** |

> **Exceeds free tier.** The system assumes Workers Paid Plan for KV or careful per-feature optimization.

### KV Write Throttling Techniques:
1. Batch score writes: `recordJobScoresBatch()` → 1 write for N scores
2. Threshold: skip write if change < 2 points
3. `kvPutRetry()` with backoff for 429 errors
4. Discovery stats budget: `MAX_KV_WRITES_PER_RUN = 3`

---

## 12.7 D1 Write Budget Management

For 300 new jobs/day:

| Operation | D1 Writes/Day |
|---|---|
| Job inserts | ~300 |
| Source stats | ~96 cycles × 8 sources = ~768 |
| Term frequencies | ~96 cycles |
| Source yields | ~96 cycles |
| Alert records | ~20 |
| Daily metrics | ~96 × 3 stages = ~288 |
| Chunk embeddings | ~100 jobs × 5 chunks = ~500 |
| **Total** | **~2,168/day** |

Free tier: 100K writes/day → **2.2% utilized**.

---

## 12.8 Queue Throughput

Cloudflare Queues can deliver millions of messages per day. Current queue usage:

| Queue | Messages/Day |
|---|---|
| feed-queue | 96 crons × ~40 sources = ~3,840 |
| job-queue | ~300 new jobs ÷ 10 = ~30 batches |
| alert-queue | ~20 alerts |
| **Total** | **~3,890/day** |

---

## 12.9 Horizontal Scaling Path

If the system outgrows the current constraints:

| Bottleneck | Solution |
|---|---|
| >40 high-priority sources | Increase `MAX_SOURCES_PER_CYCLE` |
| KV write budget | Move health records to D1, keep KV for hot data only |
| D1 storage | Add retention cleanup frequency |
| Worker CPU | Split `evaluateJobs` into smaller units per message |
| Alert volume | Add per-profile rate limiting |
| Search expansion | Add more `SEARCH_BACKENDS` (e.g., SerpAPI) |

---

## Flow Diagram — Scaling

```
96 cron fires/day (every 15 min)
    │
    Each cron: 40 sources → FEED_QUEUE (40 messages)
        │
        8 processFeeds() invocations (5 sources each, parallel inside)
            │
            ~300 new jobs → JOB_QUEUE (30 messages, 10 jobs each)
                │
                30 evaluateJobs() invocations (5 per batch)
                    │
                    ~20 qualifying jobs → ALERT_QUEUE
                        │
                        4 sendAlerts() invocations (5 per batch)
                            │
                            Discord + Telegram delivery
```

**Current resource usage:** ~2% invocations, ~2.2% D1 writes, ~5× KV (requires paid plan)  
**Max practical scale:** ~500 sources/cycle, ~1,000 new jobs/hour before CPU constrains
