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

## 12.2 Worker Invocation Math (v5.3 Config)

| Event | Frequency | Daily Count |
|---|---|---|
| Cron fires (3 staggered) | Every 5 min (3 batches) | 288 |
| processFeeds (10 sources/batch) | ~2 batches × 288 = 576 | 576 |
| evaluateJobs (10 per batch) | ~50 new jobs → 5 batches | ~480/day |
| sendAlerts | ~8 alerts per cycle → 1 batch | ~96/day |
| **Total invocations** | — | **~1,440/day** |

At 100,000/day free tier capacity → **~1.4% of free tier used**.

> **v5.3 change:** Batch size 5→10 halved processFeeds and evaluateJobs invocations. 3 cron triggers add more cron events but each processes only 1/3 of sources.

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

## 12.6 KV Write Budget Management (v5.3 — Resolved)

The KV free tier (1,000 writes/day) was the tightest constraint. **v5.3 migrated all high-write keys to D1:**

| Operation | Writes/Day (v5.2) | Writes/Day (v5.3) |
|---|---|---|
| Feed health records | ~3,840 | **0** (D1) |
| Score histogram | ~960 | **0** (D1) |
| Threshold updates | ~50 | **0** (D1) |
| Circuit breaker flags | ~20 | ~20 |
| Feed cursors | ~40 | ~40 |
| Discovery stats | ~25 | ~6 |
| Search query cache (NEW) | 0 | ~24 |
| Profile embedding cache | ~1 | ~20 |
| Cycle counter | ~10 | ~10 |
| Other (rate limits, calibration) | ~10 | ~10 |
| **Total** | **~4,876** ❌ | **~192** ✅ |

> **Result:** KV writes reduced by **96%**. System runs entirely within the free tier — no paid plan needed.

---

## 12.7 D1 Write Budget Management

For 300 new jobs/day:

| Operation | D1 Writes/Day |
|---|---|
| Job inserts | ~300 |
| Source stats | ~96 cycles × 8 sources = ~768 |
| Term frequencies | ~96 cycles |
| Feed health upserts (v5.3) | ~3,840 (moved from KV) |
| Threshold state (v5.3) | ~192 (moved from KV) |
| Score histogram (v5.3) | ~96 (moved from KV) |
| Source yields | ~96 cycles |
| Alert records | ~20 |
| Daily metrics (v5.3 buffered) | ~96 (was ~288; 66% reduction via bufferMetrics) |
| Chunk embeddings | **0** (in-memory only since v5.3; was ~500) |
| **Total** | **~5,500/day** |

Free tier: 100K writes/day → **5.5% utilized** (increased due to KV→D1 migration, but well within limits).

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
| KV write budget | ✅ Resolved in v5.3 — migrated to D1 |
| D1 storage | Add retention cleanup frequency |
| Worker CPU | Split `evaluateJobs` into smaller units per message |
| Alert volume | Add per-profile rate limiting |
| Search expansion | Add more `SEARCH_BACKENDS` (e.g., SerpAPI) |

---

## Flow Diagram — Scaling

```
288 cron fires/day (every 5 min, 3 staggered batches)
    │
    Each cron: ~14 sources → FEED_QUEUE (~14 messages per batch)
        │
        ~2 processFeeds() invocations (10 sources each, parallel inside)
            │
            ~100 new jobs → JOB_QUEUE (10 messages, 10 jobs each)
                │
                10 evaluateJobs() invocations (10 per batch)
                    │
                    ~7 qualifying jobs → ALERT_QUEUE
                        │
                        1 sendAlerts() invocation (10 per batch)
                            │
                            Discord + Telegram delivery
```

**Current resource usage:** ~1.4% invocations, ~5.5% D1 writes, ~19% KV writes — **all within free tier ✅**  
**Max practical scale:** ~500 sources/cycle, ~1,000 new jobs/hour before CPU constrains
