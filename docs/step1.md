# Step 1 — System Entry Point

## Overview

The Job Hunter Bot is a **Cloudflare Worker** that runs entirely serverlessly. There is no always-on server. The system wakes up from a cron trigger, does its work, and sleeps until the next fire.

```
Cloudflare Cron  →  Worker scheduled()  →  _scheduledImpl()  →  FEED_QUEUE
```

---

## 1.1 What Is It?

| Component | Technology |
|---|---|
| Runtime | Cloudflare Workers (V8 isolate) |
| Entry Point | `src/worker.js` |
| Configuration | `wrangler.jsonc` + `config.json` |
| Storage | D1 SQLite (jobs, metrics, sources) + KV (health, dedup, thresholds) |
| Queues | `feed-queue`, `job-queue`, `alert-queue` |
| AI | Workers AI binding (`AI`) |
| Cron Trigger | `0,15,30,45 * * * *` (every 15 minutes) |

---

## 1.2 Cron Trigger

**Defined in `wrangler.jsonc`:**
```json
"triggers": {
  "crons": ["0,15,30,45 * * * *"]
}
```

This fires **four times per hour**, every 15 minutes:
- `:00` — Cron fires → Batch 0 of feeds
- `:15` — Cron fires → Batch 1 of feeds
- `:30` — Cron fires → Batch 2 of feeds
- `:45` — Cron fires → Batch 0 again (new rotation)

> **Why every 15 min?** Job boards publish continuously. 15-minute polling means jobs are discovered within 15 minutes of being posted, giving users a significant competitive advantage.

---

## 1.3 Batch Assignment (Staggered Execution)

**`src/core/batcher.js`** splits the full feed list into 3 balanced batches. The correct batch is selected based on the cron's scheduled minute:

| Minute | Batch ID |
|---|---|
| `:00`, `:15`, `:30`, `:45` | Batch 0 |
| `:05`, `:20`, `:35`, `:50` | Batch 1 |
| `:10`, `:25`, `:40`, `:55` | Batch 2 |

**Formula:**
```js
const minute = new Date(scheduledTime).getUTCMinutes();
const offsetInInterval = (minute % 15) / 5;
const batchId = Math.floor(offsetInInterval); // 0, 1, or 2
```

> **Why?** Running all 30+ feeds in a single invocation risks hitting Cloudflare's CPU time limits. Batch splitting distributes the CPU load across multiple Worker invocations.

---

## 1.4 Worker Entry Function: `scheduled()`

```js
export default {
  async scheduled(event, env, ctx) {
    try {
      await _scheduledImpl(event, env, ctx);
    } catch (err) {
      logger.error(`[Scheduled] Unhandled error: ${err.message}`, { stack: err.stack });
    }
  }
}
```

The outer `scheduled()` is a thin try-catch wrapper. All real business logic lives in `_scheduledImpl()`.

---

## 1.5 `_scheduledImpl()` — What Happens on Cron Fire

```
_scheduledImpl(event, env, ctx)
  │
  ├── 1. getAndIncrementCycle()      → increment KV cycle counter
  ├── 2. buildSourceList(config)     → config.json feeds + ATS sources
  ├── 3. getEnabledSources(env.DB)   → D1 source_registry (discovered sources)
  ├── 4. getSourcesForCycle(env.DB)  → priority-ranked source selection (top 40)
  ├── 5. FEED_QUEUE.sendBatch()      → dispatch all sources to feed-queue
  ├── 6. recalculatePriorities()     → every 4 cycles
  ├── 7. retrainThresholds()         → every 24 cycles
  ├── 8. probeDomainsForCareers()    → every 4 cycles (career page detector)
  ├── 9. runSearchExpansion()        → every 8 cycles (new source discovery)
  ├── 10. cleanupStaleJobs()         → 30-day retention
  ├── 11. incrementDailyMetrics()    → record cycle count
  └── 12. sendDailyReport()          → midnight UTC only
```

---

## 1.6 Config Loading

```js
let _cachedConfig = null;
function getConfig() {
  if (!_cachedConfig) _cachedConfig = loadConfig();
  return _cachedConfig;
}
```

`config.json` is parsed **once** per Worker warm session and cached in a module-level variable. This prevents re-parsing JSON on every invocation, saving ~10–20ms per call.

---

## 1.7 Module-Level Optimizations

| Optimization | Purpose |
|---|---|
| `_cachedConfig` | Parse `config.json` once per warm worker |
| `_regexCache` | Reuse compiled regexes across invocations |
| `_scoringRegexCache` | Same for scoring-side keyword matching |
| Module-level imports | All connectors/scores are pre-imported |

---

## 1.8 Environment Variables

Validated by `src/env.ts` at startup:

| Binding | Type | Purpose |
|---|---|---|
| `DB` | D1 Database | All persistent storage |
| `SEEN_JOBS` | KV Namespace | Dedup, health, thresholds, embedding cache |
| `FEED_QUEUE` | Queue | Dispatch source fetch jobs |
| `JOB_QUEUE` | Queue | Dispatch raw jobs for scoring |
| `ALERT_QUEUE` | Queue | Dispatch qualified jobs for notification |
| `AI` | Workers AI | Semantic embedding generation |
| `DISCORD_WEBHOOK_URL` | Secret | Discord channel notifications |
| `TELEGRAM_BOT_TOKEN` | Secret | Telegram bot credentials |
| `TELEGRAM_CHAT_ID` | Secret | Target Telegram chat |

---

## 1.9 HTTP Endpoints (Manual Triggers)

| Path | Method | Description |
|---|---|---|
| `/health` | GET | System status + env check |
| `/metrics` | GET | Source health metrics from D1 |
| `/report` | GET/POST | View or send daily intelligence report |
| `/trigger` | POST | Manually trigger a full crawl cycle |
| `/test-cron` | GET | Local dev: simulate cron fire |
| `/stress-test` | GET | Load test (local only) |

---

## Summary

```
Cron (:00/:15/:30/:45)
    │
    └─→ Worker wakes up
         └─→ _scheduledImpl()
              ├─→ Cycle counter incremented (KV)
              ├─→ Sources loaded (config + D1 registry)
              ├─→ Priority-ranked top 40 selected
              └─→ Sources sent to FEED_QUEUE (batches of 10)
```

**Inputs:** Cloudflare cron signal  
**Outputs:** Messages in `feed-queue` (one per source)  
**Workers involved:** `worker.js → scheduled()`  
**Queues used:** `FEED_QUEUE`  
**Storage written:** KV (cycle counter), D1 (daily_metrics)
