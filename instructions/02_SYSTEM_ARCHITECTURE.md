# 02 — System Architecture (Real)

## Verified Data Flow

```
Cron (every 15 min)
    ↓
worker.js → scheduled()
    ↓
intelligence/sourceIntelligence.js → selects sources from D1
    ↓
FEED_QUEUE.sendBatch() — one message per source
    ↓
worker.js → queue consumer (feed-queue)
    ↓
connectors/index.js → picks connector by source type
  ├── connectors/rss.js        (L1 RSS feeds)
  ├── connectors/greenhouse.js (L2 ATS)
  ├── connectors/lever.js      (L2 ATS)
  ├── connectors/ashby.js      (L2 ATS — currently 401ing)
  ├── connectors/workable.js   (L2 ATS)
  └── connectors/careerPage.js (L4 HTML scraping)
    ↓
JOB_QUEUE.sendBatch() — normalized job messages
    ↓
worker.js → queue consumer (job-queue)
    ↓
scoring/relevance.js → score 0–100
    ↓   (if score ≥ 50)
ALERT_QUEUE.sendBatch()
    ↓
worker.js → queue consumer (alert-queue)
    ↓
notifications/notifications.js → Discord / Telegram
```

---

## File Map (Real Files Confirmed in `src/`)

```
src/
  worker.js                     ← Main Worker entry (~33KB, HTTP + queues + cron)
  config.js                     ← Runtime config parser
  env.ts                        ← Env var validation
  core/
    logger.js                   ← Structured logging (MUST use instead of console.log)
    utils.js                    ← General helpers (retry, timeout, slugging)
    schema.js                   ← Job normalization schema + content hash dedup
    batcher.js                  ← Batching and chunking utilities
  connectors/
    index.js                    ← Connector dispatcher
    base.js                     ← Base connector class (fetch + pLimit — pLimit currently unused!)
    rss.js                      ← RSS parser
    greenhouse.js               ← Greenhouse ATS
    lever.js                    ← Lever ATS
    ashby.js                    ← Ashby ATS (BROKEN: 401 errors, possibly truncated file)
    workable.js                 ← Workable ATS
    careerPage.js               ← HTML career page scraper (sync HTML issue on large pages)
  discovery/
    sourceDiscovery.js          ← L3 auto ATS detection (idle, URL patterns unvalidated)
    careerDetector.js           ← Career page URL detection
    searchExpander.js           ← L5 DDG search expansion (idle, no rate limits)
  intelligence/
    sourceIntelligence.js       ← Source prioritisation + dispatch
    feedHealth.js               ← Circuit breaker + failure tracking (silent catch{} BUG)
    threshold.js                ← Adaptive threshold tuning
    dailyReport.js              ← Report data aggregation
  scoring/
    relevance.js                ← 7-layer scorer (BUG: threshold=80 hardcoded, should use config=50)
    feedback.js                 ← User feedback adjustments
  db/
    index.js                    ← D1 instance export
    jobs.js                     ← Job CRUD (BUG: per-job queries instead of db.batch())
    sources.js                  ← Source registry CRUD
    profiles.js                 ← User profile CRUD
    terms.js                    ← Search terms CRUD
  notifications/
    notifications.js            ← Alert formatting + send
    notificationQueue.js        ← Alert queue processor
    ai.js                       ← Workers AI embeddings (cosine similarity)
  storage/
    storage.js                  ← KV abstraction
    runLock.js                  ← Per-cycle run lock (prevents overlapping crons)
    feeds.js                    ← Per-feed KV state tracking
```

---

## D1 Schema Summary (from migrations/)

| Table | Key columns | Notes |
|-------|-------------|-------|
| `jobs` | `id, url, title, company, score, content_hash, source_id, created_at` | Dedup: `content_hash` + `url` |
| `sources` | `id, url, type, priority, status, last_checked` | Circuit state here |
| `profiles` | `id, skills, location, experience_level` | Scoring context |
| `terms` | `id, term, weight` | Keyword tuning |
| `source_metrics` | Tracks per-source yield stats | Added in migration 0006 |
| `daily_metrics` | `date, jobs_fetched, jobs_inserted, alerts_sent` | BUG: updated per-job not per-batch |
| `seen_alerts` | Dedup guard for notifications | Idempotency for alert-queue |

---

## Architecture Invariants (Enforce These)

- `worker.js` orchestrates only — no business logic / SQL inline
- `db/` is the ONLY place with D1 queries
- `connectors/` fetch and normalize only — no DB writes, no scoring
- `notifications/` never imports `db/` directly
- `intelligence/` coordinates scheduling — does not embed HTTP fetch logic
- All state is in D1/KV — **no** global in-memory state that persists across invocations

## Known Architecture Violations (Fix These)

- `jobs.js`: Per-job `dedup → insert → metrics` loop (D1 rate-limit source)
- `relevance.js`: Hardcoded score threshold instead of reading `config.notificationThreshold`
- `feedHealth.js`: `catch{}` with no logging swallows circuit-breaker errors
- `base.js`: `pLimit` imported but never applied — connectors run fully concurrently
