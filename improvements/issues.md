# Optimization Audit: Identified Issues

This document lists the performance bottlenecks and architectural inefficiencies found during the deep audit of the Job Hunter Bot codebase.

---

## 🔴 CRITICAL ISSUES (High Latency / High Cost / Scalability Risk)

### 1. N+1 Health Checks in `processFeeds`

- **File:** `src/worker.js` -> `processFeeds()`
- **Function Reference:** `getFeedHealthRecord()` calls in a sequential loop.
- **Root Cause:** For every source in a batch (e.g., 40 sources), the worker performs a sequential `await getFeedHealthRecord()`. Each call executes one D1 query (`SELECT * FROM feed_health`) and one KV read (`kv.get(circuitKey)`).
- **Execution Path Affected:** Job Ingestion (Feed Queue). This adds significant latency (40 sources \* ~50ms = 2s) and consumes subrequest quotas rapidly.

### 2. N+1 AI Embeddings in `evaluateJobs`

- **File:** `src/worker.js` -> `evaluateJobs()`
- **Function Reference:** `embedChunks()` called inside a loop over jobs.
- **Root Cause:** Each job requiring AI scoring triggers an individual AI subrequest (`aiBinding.run`). Cloudflare Workers have a 50-subrequest limit per invocation. This limit is often hit, causing later jobs in the batch to skip AI scoring and rely on lower-quality keyword matching.
- **Execution Path Affected:** Job Evaluation (Job Queue). Affects match quality and hits platform resource limits.

---

## 🟡 MODERATE ISSUES (Noticeable Inefficiency)

### 3. Inefficient Ground-truth Queries in `dailyReport.js`

- **File:** `src/intelligence/dailyReport.js`
- **Function Reference:** `getDailyReportData()`
- **Root Cause:** Queries use `WHERE date(fetched_at) = ?`. In SQLite/D1, wrapping a column in a function prevents the use of a standard index on that column. As the `jobs` table grows (thousands of rows), this results in a full table scan once per day.
- **Execution Path Affected:** Daily Report Generation.

### 4. Sequential Connector Chunks with Delays

- **File:** `src/connectors/index.js`
- **Function Reference:** `runAllConnectors()`
- **Root Cause:** Sources are processed in chunks of 10 with a hardcoded `1000ms` delay between chunks. While intended to prevent 429s, it is applied sequentially within a single worker, even if sources are from different platforms (e.g., Greenhouse vs. Lever), adding unnecessary wall-time latency.
- **Execution Path Affected:** Job Ingestion (Feed Queue).

### 5. Individual KV Cursors for RSS Feeds

- **File:** `src/connectors/rss.js`
- **Function Reference:** `fetchSingleFeed()`
- **Root Cause:** Every RSS feed fetch performs an individual `kv.get` and `kv.put` for its `rss_cursor`. This is 2 KV operations per RSS source per cycle, consuming the limited KV free tier quota.
- **Execution Path Affected:** RSS Job Ingestion.

### 6. Source Registration Cap Bypass

- **File:** `src/db/sources.js`
- **Function Reference:** `batchRegisterDiscoveredSources()`
- **Root Cause:** The 10,000 source registry limit is only checked in `registerDiscoveredSource()`, but the batch version (`batchRegisterDiscoveredSources`) maps sources directly to SQL statements and executes them, bypassing the limit check and eviction logic.
- **Execution Path Affected:** Source Discovery.

---

## 🟢 MINOR ISSUES (Micro-optimizations)

### 7. Redundant `getActiveProfiles` Query

- **File:** `src/worker.js` -> `evaluateJobs()`
- **Root Cause:** Fetches all profiles from D1 on every invocation of `evaluateJobs`. Since profiles change rarely, this is a redundant query that could be cached in memory for the duration of the worker's warm state.

### 8. Inefficient `threshold_state` Serialization

- **File:** `src/intelligence/threshold.js`
- **Function Reference:** `saveWindow()`
- **Root Cause:** The entire rolling window of 200 scores is stringified and written to a single D1 row on every batch of scores. While small, it's an unnecessary I/O overhead compared to incremental updates or purely in-memory handling with periodic persistence.

### 9. KV Read for Circuit Breaker Status

- **File:** `src/intelligence/feedHealth.js` -> `isFeedCircuitOpen()`
- **Root Cause:** Every source check hits KV for the circuit flag. While this allows for TTL-based auto-recovery, it's another KV read per source per cycle.
