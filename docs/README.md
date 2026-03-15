# Job Hunter Bot v5.3 — System Documentation

Complete end-to-end architectural documentation generated from source code analysis.  
Each file covers one layer of the system lifecycle, from cron trigger to Discord/Telegram alert.

> **v5.3 Update:** All 9 architecture issues from [step13](./step13.md) have been resolved. See [step15](./step15.md) for full details.

---

## Document Index

| Doc                      | Topic                      | Key Content                                                                                     |
| ------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------- |
| [step1.md](./step1.md)   | **System Entry Point**     | Cron schedule, `_scheduledImpl()`, env bindings, HTTP endpoints                                 |
| [step2.md](./step2.md)   | **Discovery Engine**       | ATS passive detection, career page probing, Bing/Brave search expansion, 72h force-run guard    |
| [step3.md](./step3.md)   | **Crawler Pipeline**       | 6 connectors (RSS, Greenhouse, Lever, Ashby, Workable, CareerPage), job normalization           |
| [step4.md](./step4.md)   | **Deduplication**          | 4-layer dedup: identity_hash, content_hash (in-memory), D1 UNIQUE, SimHash + cosine similarity  |
| [step5.md](./step5.md)   | **Queue Architecture**     | 3 queues, batch sizes, retry policies, rate-limit fallback cascade                              |
| [step6.md](./step6.md)   | **Processing Workers**     | CPU model, wall-time guards, `processFeeds`/`evaluateJobs`/`sendAlerts` CPU profiles            |
| [step7.md](./step7.md)   | **Scoring & Filtering**    | 13-layer 0–100 scoring engine: TF-IDF, FastMatcher Trie, RAG/AI semantic, dynamic threshold     |
| [step8.md](./step8.md)   | **Storage Layer**          | D1 schema (12 tables), KV key patterns, retention policies, daily write budgets                 |
| [step9.md](./step9.md)   | **Alerting Pipeline**      | Discord rich embeds, Telegram MarkdownV2, alert dedup, 5×15min retry resilience                 |
| [step10.md](./step10.md) | **Monitoring & Telemetry** | `daily_metrics` D1 table, score histogram, feed health, daily intelligence report               |
| [step11.md](./step11.md) | **Failure Handling**       | Circuit breaker, exponential backoff, direct fallback cascade, FK protection, wall-time guard   |
| [step12.md](./step12.md) | **Scaling Model**          | Invocation math, KV write budget, D1 write budget, concurrency model, scaling path              |
| [step13.md](./step13.md) | **Optimization Analysis**  | Critical issues, scalability risks, resource waste, design improvements with severity matrix    |
| [step14.md](./step14.md) | **Architecture Summary**   | Full system diagram, complete job lifecycle walkthrough, technology decisions, health scorecard |
| [step15.md](./step15.md) | **Architecture Fixes**     | All 9 fixes: KV→D1 migration, cron staggering, metrics buffering, queue depth monitoring      |

---

## Quick Reference — System At a Glance

```
Cron (3 staggered triggers — v5.3)
  :00/:15/:30/:45  →  Batch 0 (high-priority sources)
  :05/:20/:35/:50  →  Batch 1 (medium-priority sources)
  :10/:25/:40/:55  →  Batch 2 (low-priority + exploration)
    └▶ _scheduledImpl() [worker.js]
        ├▶ getBatchId() → only this batch's sources → FEED_QUEUE
        ├▶ [/4 cycles] recalculatePriorities + probeDomainsForCareers
        ├▶ [/8 cycles] runSearchExpansion (with 24h query cache)
        ├▶ bufferMetrics() → single flushMetricsBuffer(D1)
        └▶ [midnight] sendDailyReport

FEED_QUEUE (batch:10) → processFeeds() [6 connectors]
    └▶ Circuit breaker → fetch → parse → normalize → in-mem dedup
        └▶ batchInsertJobs(D1) → batchRecordFeedResults(D1) → JOB_QUEUE

JOB_QUEUE (batch:10) → evaluateJobs() [scoring/relevance-v4.js]
    └▶ Queue depth check → Keyword gate → [AI if not backlogged] → 13-layer scoreJob()
        └▶ score ≥ threshold(D1) → ALERT_QUEUE

ALERT_QUEUE (batch:10) → sendAlerts() [notifications.js]
    └▶ Discord rich embed + Telegram MarkdownV2 (5× retry, 75min resilience)
```

---

## Key Numbers

| Metric                 | Value                                                   |
| ---------------------- | ------------------------------------------------------- |
| Cron frequency         | Every 5 minutes (3 staggered batches)                   |
| Sources per cycle      | Up to ~14 per batch (40 total across 3 batches)         |
| Connectors             | 6 (RSS, Greenhouse, Lever, Ashby, Workable, CareerPage) |
| Scoring layers         | 13                                                      |
| Alert threshold        | Dynamic: 55–70 (D1-backed, auto-adjusts)                |
| Alert channels         | Discord + Telegram                                      |
| Alert retries          | 5 × 15 minutes = 75 min resilience                      |
| D1 tables              | 15 (3 new: feed_health, threshold_state, score_histogram)|
| Dedup layers           | 4 (in-memory × 2, D1 UNIQUE, AI cosine similarity)      |
| KV writes/day          | ~192 (was ~4,876 — ✅ within 1,000 free tier)            |
| Worker invocations/day | ~1,200 (~1.2% of free tier)                             |
| Job retention          | 30 days                                                 |

---

_Generated by deep source code analysis of `src/worker.js` and all supporting modules._  
_System version: v5.3.0 | Architecture: event-driven-queues | Platform: Cloudflare Workers_
