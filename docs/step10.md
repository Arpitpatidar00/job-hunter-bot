# Step 10 — Monitoring & Telemetry

## Overview

The system has a **self-contained observability stack** built on D1, KV, and Cloudflare's native log streaming. There is no external monitoring service — all metrics are collected inbound and surfaced via a daily intelligence report sent over Discord/Telegram.

```
Every Stage → incrementDailyMetrics() → D1 daily_metrics table
Every Job   → recordJobScoresBatch()  → KV (score histogram)
Every Feed  → recordFeedResult()      → KV (circuit breaker health)
Midnight UTC → sendDailyReport()       → Discord / Telegram
```

---

## 10.1 Daily Metrics — Real-Time Accumulation

`incrementDailyMetrics()` is called after every significant stage:

| Stage | Metrics Written |
|---|---|
| `processFeeds()` | `sources_scanned`, `crawl_successes`, `crawl_failures`, `raw_jobs_found`, `unique_jobs_stored`, `duplicates_filtered`, `remote_jobs`, `hybrid_jobs`, `salary_*`, `d1_writes`, `skill_counts` |
| `evaluateJobs()` | `ai_calls`, `jobs_evaluated`, `score_sum`, `score_max`, `queue_messages` |
| `sendAlerts()` | `alerts_sent`, `alert_failures` |
| `_scheduledImpl()` | `cycles_completed`, `worker_invocations`, `new_sources_*`, `new_domains_queued` |

Implementation uses a 2-statement D1 batch (INSERT OR IGNORE + UPDATE):
```js
await db.batch([
  db.prepare(`INSERT OR IGNORE INTO daily_metrics (date) VALUES (?)`).bind(date),
  db.prepare(`UPDATE daily_metrics SET sources_scanned = sources_scanned + ? WHERE date = ?`).bind(5, date),
]);
```

---

## 10.2 Score Distribution Histogram (KV)

After each evaluation batch, a score histogram is written to KV:

```js
// key: "metrics:score_histogram"
// value: { "0": 12, "10": 8, "20": 15, "30": 22, "40": 18, "50": 7, "60": 3, "70": 1 }
```

Buckets: 0–9, 10–19, 20–29, ..., 90–99

This shows **why jobs aren't alerting** — if most scores cluster in 30–40, the threshold (55) is filtering too aggressively.

---

## 10.3 Feed Health Records (KV)

Per-feed reliability tracked in KV:

```json
{
  "url": "https://weworkremotely.com/remote-jobs.rss",
  "successCount": 142,
  "failureCount": 3,
  "consecutiveFailures": 0,
  "totalLatencyMs": 89432,
  "sampleCount": 145,
  "lastSeen": "2026-03-14T15:00:00Z",
  "lastError": "",
  "etag": "abc123",
  "circuitOpen": false
}
```

Metrics derived:
- `successRate = successCount / (successCount + failureCount)`
- `avgLatencyMs = totalLatencyMs / sampleCount`

---

## 10.4 Source Intelligence Metrics (D1)

**Table:** `source_registry`

Key tracking columns:
| Column | Purpose |
|---|---|
| `priority_score` | Computed score (0–100) driving crawl frequency |
| `crawl_tier` | high/medium/low/dormant |
| `new_job_count` | Unique jobs yielded in last cycle |
| `dup_ratio` | Fraction of crawled jobs that were duplicates |
| `failure_count` | Total failures ever |
| `consecutive_failures` | Current failure streak |
| `last_fetched_at` | Timestamp of last successful crawl |

`recalculatePriorities()` runs every 4 cycles:
```sql
UPDATE source_registry
SET crawl_tier = CASE
  WHEN priority_score >= 70 THEN 'high'
  WHEN priority_score >= 40 THEN 'medium'
  WHEN priority_score >= 10 THEN 'low'
  ELSE 'dormant'
END
WHERE enabled = 1;
```

---

## 10.5 Daily Intelligence Report

**Module:** `src/intelligence/dailyReport.js`

Triggered at **midnight UTC** (hour=0, minute<15). Sent to Discord and Telegram with the previous day's complete data.

### Report Sections:

```
📊 JOB HUNTER BOT — DAILY INTELLIGENCE
🗓 14 Mar 2026

🚀 GROWTH & EXPANSION
• New Sources: +3  (+50%)  ↳ ATS: +1 | Career: +2 | Search: +0
• Active Sources: 47

📡 CRAWL PERFORMANCE
• Sources Scanned: 40    • Success Rate: 95%
• Raw Jobs: 1,247         • Unique Stored: 184  (+12%)
• Duplicates Filtered: 1,063   • High-Value Yield: 14.8%
• Relevance Pass Rate: 4.3%

📊 SCORE DISTRIBUTION (threshold: 45)
  0-9    ██████  44 (32%)  ← below threshold
  10-19  ████    31 (22%)  ← below threshold
  20-29  ███     24 (17%)  ← below threshold
  30-39  ██      18 (13%)  ← below threshold
  40-49  █       9 (6%)   ← below threshold
  50-59  █       7 (5%)
  60-69  ▌       4 (3%)
  70+    ▌       2 (1%)
  → Max: 84 | Threshold: 55 | Jobs that alerted: 8

🔔 ALERT QUALITY
• Alerts Sent: 8  • Avg Score: 62.1  • Quality Index: 🟡 Strong

🧠 SOURCE INTELLIGENCE
• High: 8 | Med: 22 | Low: 12 | Dormant: 5

🔴 FAILING SOURCES
  ❌ cryptojobslist.com           | 5 consec fails | HTTP 503

🔍 DISCOVERY ENGINE
  Last run: 2026-03-14T12:00:00Z
  Attempted: 8 | Found: 3 | Failed: 1

📊 MARKET SIGNALS
• Top Skill: react     • Dominant Stack: MERN
• Remote Roles: 78%    • Avg Salary: $52,000

☁ RESOURCE SAFETY
• Worker Invocations: 96   • D1 Writes: 12,834
• AI Calls: 142             • Free Tier Usage: 0%  🟢 Safe
```

---

## 10.6 HTTP Metrics Endpoint

```
GET /metrics
```

Returns JSON with source health report from D1:
```json
{
  "status": "ok",
  "version": "5.1.0",
  "timestamp": "2026-03-14T15:00:00Z",
  "sources": {
    "total": 47,
    "active": 42,
    "disabled": 5
  },
  "topFailing": [...]
}
```

Cached for 1 hour: `Cache-Control: public, max-age=3600`.

---

## 10.7 Cloudflare Native Log Streaming

**`wrangler.jsonc`:**
```json
"observability": {
  "logs": {
    "enabled": true,
    "invocation_logs": true
  }
}
```

All `logger.info()`, `logger.warn()`, `logger.error()` calls stream to Cloudflare's log ingestion system and can be viewed with:

```bash
wrangler tail --format=pretty
```

Saved locally to `tail.log` during development.

---

## 10.8 Config Validation Warnings

The daily report includes automatic config diagnostics:

| Warning Condition | Message |
|---|---|
| `score_max = 0` AND `unique_jobs_stored > 10` | 🔴 Scoring pipeline broken |
| `score_max > 0` AND `score_max < 45` | 🟡 mustMatch terms too strict |
| `active sources < 10` | 🟡 Discovery not expanding |
| No `discovery:last_run_stats` in KV | ⚠️ SearchExpander not writing to KV |
| `crawl_failures > 20` | 🟡 Circuit breakers triggered |
| `alerts_sent = 0` AND `unique_jobs_stored > 100` | 🟡 Threshold too strict |

---

## Flow Diagram

```
processFeeds() completes
    └─→ incrementDailyMetrics(DB, { sources_scanned, raw_jobs, unique_stored, ... })

evaluateJobs() completes
    ├─→ recordJobScoresBatch(KV, scores)   → score histogram
    └─→ incrementDailyMetrics(DB, { ai_calls, jobs_evaluated, score_sum })

sendAlerts() completes
    └─→ incrementDailyMetrics(DB, { alerts_sent, alert_failures })

Every cron (04:00 UTC):
    └─→ recordFeedResult(KV, url, { success, latency })

Midnight UTC:
    └─→ getDailyReportData(DB) → formatDailyReport() → sendDailyReport(Discord + Telegram)
```

**Observability stack:** D1 (daily_metrics, source_registry), KV (score_histogram, feed health)  
**Alerting:** Discord/Telegram with rich report  
**Logs:** Cloudflare `wrangler tail` + local `tail.log`  
**External monitoring:** None required — fully self-contained
