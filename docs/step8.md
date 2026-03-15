# Step 8 — Storage Layer

## Overview

The system uses **two types of storage**: D1 (SQLite database) for persistent structured data, and KV (key-value store) for fast ephemeral state. Each serves a distinct role.

```
D1 (SQLite)         → Jobs, alerts, sources, metrics, profiles, embeddings, feed health, thresholds, histograms
KV (key-value)      → Circuit breakers, cursors, discovery stats, search cache, config cache
```

> **v5.3 Update:** Feed health records, threshold state, and score histogram migrated from KV to D1. See [step15.md](./step15.md).

---

## 8.1 D1 Database — Schema Overview

**D1 database name:** `job-hunter-db`  
**Database ID:** `5ac7ed56-2edd-42ae-9ec8-28c8d57af629`  
**Migrations:** 16 migration files in `/migrations/`

### Tables

| Table | Purpose | Key Fields |
|---|---|---|
| `jobs` | All fetched and stored jobs | `id`, `identity_hash` (UNIQUE), `content_hash`, `title`, `company`, `url`, `fetched_at` |
| `profiles` | User notification profiles | `id`, `notification_threshold`, `enabled` |
| `sent_alerts` | Alert dedup log | `job_id`, `profile_id`, `sent_at` (FK: jobs.id) |
| `source_registry` | All crawled sources (config + discovered) | `url` (UNIQUE), `type`, `name`, `enabled`, `priority_score`, `crawl_tier`, `failure_count` |
| `job_source_metrics` | Per-source yield tracking | `source_url`, `successes`, `failures`, `last_yield` |
| `job_chunks` | AI embedding chunks (v4 RAG) — in-memory only since v5.3 | `job_hash`, `chunk_text`, `vec_json`, `remote_type` |
| `daily_metrics` | One row per day, all system counters | `date` (UNIQUE), `unique_jobs_stored`, `alerts_sent`, `ai_calls`, `queue_depth_estimate` |
| `term_frequencies` | Global IDF data for TF-IDF scoring | `term`, `doc_count` |
| `career_probe_queue` | Domains pending career page probing | `domain`, `source_job_url`, `probed` |
| `skill_market_trends` | Trending skill signals | `skill`, `count`, `week` |
| `company_hiring_trends` | Company hiring velocity | `company`, `job_count`, `week` |
| `stress_test_logs` | Load test telemetry | `id`, `timestamp`, `log` |
| `feed_health` | Per-URL reliability records (NEW v5.3) | `url_hash` (PK), `url`, `success_count`, `failure_count`, `consecutive_failures`, `etag` |
| `threshold_state` | Dynamic threshold + rolling window (NEW v5.3) | `key` (PK: 'thresh:window' or 'thresh:effective'), `value`, `updated_at` |
| `score_histogram` | Per-day score distribution buckets (NEW v5.3) | `date` + `bucket` (composite PK), `count` |

---

## 8.2 Key D1 Operations

### `batchInsertJobs()` — `src/db/jobs.js`

The most frequent write:
```js
// INSERT OR IGNORE (D1 UNIQUE constraint catches dupes)
db.prepare(`INSERT OR IGNORE INTO jobs (id, identity_hash, content_hash, ...) VALUES (?, ...)`)
// Executed in batches of 40 (D1 limit per transaction)
await db.batch(stmts.slice(i, i + 40));
```

**Returns:** `{ inserted: RawJob[], duplicates: number }`

### `cleanupStaleJobs()` — Retention Policy
```js
await db.prepare(`DELETE FROM jobs WHERE fetched_at < datetime('now', '-? days')`).bind(30).run();
// 30-day job retention (keeps DB lean)
```

Other retention policies:
- `job_chunks` → 7 days (table still exists but no new D1 writes since v5.3; chunks are in-memory only)
- `sent_alerts` → 90 days

### `batchMarkAlertSent()` — FK-Safe Alert Logging
```js
// Ensures both job AND profile exist before inserting alert record
// Prevents FK constraint violations from race conditions
INSERT INTO sent_alerts (job_id, profile_id, sent_at)
  SELECT j.id, p.id, datetime('now')
  FROM jobs j, profiles p
  WHERE j.id = ? AND p.id = ?
```

---

## 8.3 D1 Query Patterns

All D1 access is through typed modules in `src/db/`:

| Module | Responsibility |
|---|---|
| `jobs.js` | CRUD for job records, batch insert, cleanup |
| `profiles.js` | User profiles, notification thresholds |
| `sources.js` | source_registry CRUD, stats updates |
| `terms.js` | Term frequency tracking for TF-IDF |
| `index.js` | Re-exports all modules |

---

## 8.4 KV Namespace — `SEEN_JOBS`

**KV ID:** `9606d0c7fcda4e69bb04cc351bd7fd5a`

KV is used for **fast, ephemeral, or infrequently-written** data. Since v5.3, high-write-volume keys have been migrated to D1.

### KV Key Patterns (v5.3 — updated)

| Key Pattern | Purpose | TTL | Writes/Day |
|---|---|---|---|
| `feed:circuit:{urlHash}` | Circuit breaker open flag | Dynamic (5min–4hrs) | ~20 |
| `feed:cursor:{urlHash}` | Latest pubDate seen for RSS dedup | 7 days | ~40 |
| `profile:embedding` | Cached profile semantic vector | 24 hours | ~20 |
| `search:cache:{queryHash}` | Search query result cache (v5.3) | 24 hours | ~24 |
| `discovery:last_run_stats` | Last search expansion stats | 48 hours | ~6 |
| `discovery:last_success_timestamp` | Timestamp of last new source found | 7 days | ~3 |
| `__cycle_number` | Global cycle counter | No expiry | ~10 |
| `scoring:thresholds:v4` | Calibration threshold | No expiry | ~4 |
| `ratelimit:{domain}` | Domain rate limit flag | 5 min | ~5 |
| **Total** | | | **~192** |

### KV Keys Removed in v5.3 (migrated to D1)

| Key (removed) | Writes/Day (saved) | Replaced By |
|---|---|---|
| ~~`feed:health:{urlHash}`~~ | ~3,840 | D1 `feed_health` table |
| ~~`thresh:window`~~ | ~96 | D1 `threshold_state` table |
| ~~`thresh:effective`~~ | ~48 | D1 `threshold_state` table |
| ~~`metrics:score_histogram`~~ | ~96 | D1 `score_histogram` table |
| **Total saved** | **~4,080** | |

---

## 8.5 daily_metrics — The Telemetry Table

```sql
CREATE TABLE daily_metrics (
  date TEXT PRIMARY KEY,
  sources_scanned INTEGER DEFAULT 0,
  crawl_successes INTEGER DEFAULT 0,
  crawl_failures INTEGER DEFAULT 0,
  raw_jobs_found INTEGER DEFAULT 0,
  unique_jobs_stored INTEGER DEFAULT 0,
  duplicates_filtered INTEGER DEFAULT 0,
  alerts_sent INTEGER DEFAULT 0,
  alert_failures INTEGER DEFAULT 0,
  score_sum REAL DEFAULT 0,
  score_max REAL DEFAULT 0,
  new_sources_ats INTEGER DEFAULT 0,
  new_sources_career INTEGER DEFAULT 0,
  new_sources_search INTEGER DEFAULT 0,
  new_domains_queued INTEGER DEFAULT 0,
  remote_jobs INTEGER DEFAULT 0,
  hybrid_jobs INTEGER DEFAULT 0,
  onsite_jobs INTEGER DEFAULT 0,
  salary_sum REAL DEFAULT 0,
  salary_count INTEGER DEFAULT 0,
  worker_invocations INTEGER DEFAULT 0,
  d1_writes INTEGER DEFAULT 0,
  queue_messages INTEGER DEFAULT 0,
  ai_calls INTEGER DEFAULT 0,
  jobs_evaluated INTEGER DEFAULT 0,
  cycles_completed INTEGER DEFAULT 0,
  skill_counts TEXT DEFAULT '{}'
);
```

`incrementDailyMetrics()` uses a batched INSERT OR IGNORE + UPDATE pattern — 2 SQL statements in 1 D1 batch call.

---

## 8.6 source_registry — Adaptive Source Management

```sql
CREATE TABLE source_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,        -- rss | greenhouse | lever | ashby | workable
  name TEXT,
  enabled INTEGER DEFAULT 1,
  priority_score REAL DEFAULT 50,
  crawl_tier TEXT DEFAULT 'medium', -- high | medium | low | dormant
  failure_count INTEGER DEFAULT 0,
  consecutive_failures INTEGER DEFAULT 0,
  last_fetched_at TEXT,
  last_error TEXT,
  discovery_origin TEXT,     -- config | ats_detect | career_probe | search
  new_job_count INTEGER DEFAULT 0,
  dup_ratio REAL DEFAULT 0
);
```

`recalculatePriorities()` runs every 4 cycles and updates `priority_score` and `crawl_tier` based on yield history.

---

## 8.7 Storage Read/Write Summary Per Cycle

| Operation | Storage | Frequency |
|---|---|---|
| Cycle counter increment | KV | Every cron |
| Source list fetch | D1 | Every cron |
| Priority-ranked source selection | D1 | Every cron |
| Circuit breaker check | KV | Per source |
| ETag/LastModified cache | KV | Per source |
| Batch job insert | D1 | Per processFeeds batch |
| Source stats update | D1 | Per processFeeds batch |
| Feed health write | KV | Per source |
| Term frequencies | D1 | Per processFeeds batch |
| Source yields | D1 | Per processFeeds batch |
| Threshold read | KV | Per evaluateJobs batch |
| Profile embedding fetch | KV | Per evaluateJobs batch |
| Chunk embeddings | KV + D1 | Per evaluated job |
| Alert dedup check | D1 | Per qualifying job |
| Alert insert | D1 | Per alert sent |
| Score histogram | KV | Per evaluateJobs batch |
| Daily metrics update | D1 | After each stage |

---

## Flow Diagram

```
Jobs arrive from connectors
    │
    ├── D1: batchInsertJobs()           → jobs table
    │       INSERT OR IGNORE (UNIQUE dedup)
    │       returns inserted[] + dupes
    │
    ├── D1: batchUpdateSourceStats()    → source_registry
    │       update failure_count, new_job_count, dup_ratio
    │
    ├── KV: recordFeedResult()          → feed:circuit:{hash} (circuit breaker only)
    │       health records now in D1 feed_health table (v5.3)
    │
    ├── D1: feed_health                  → batched health upserts (v5.3)
    │
    ├── D1: threshold_state              → rolling window + effective threshold (v5.3)
    │
    ├── D1: score_histogram              → per-day score distribution (v5.3)
    │
    ├── D1: job_chunks                  → batched chunk embeddings (v4 RAG, in-memory only v5.3)
    │
    ├── D1: sent_alerts                 → alert dedup log
    │
    └── D1: daily_metrics               → aggregated counters, one row per day
```

**D1 limits:** 100,000 rows/table free, batch max 40 statements  
**KV limits:** 1,000 writes/day free, 100,000 reads/day free → **~192 writes/day (v5.3) ✅**  
**Retention:** Jobs 30d, chunks 7d (in-mem only), alerts 90d, health records indefinite (D1)
