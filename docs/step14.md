# Step 14 — Expert-Level Architecture Summary

## System Overview

Job Hunter Bot v5.3 is a **fully event-driven, serverless job intelligence pipeline** built on Cloudflare's edge computing platform. It automatically discovers, fetches, scores, deduplicates, and alerts on software engineering job postings from 47+ sources — all with zero servers, zero ops, and near-zero cost.

```
ZERO-COST ARCHITECTURE:
  No servers, no VMs, no containers
  Runs on Cloudflare's global edge (200+ PoPs)
  Cost: $0 (Workers free tier) — all resources within free limits (v5.3)
```

---

## Full System Architecture Diagram (Text Form)

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                      JOB HUNTER BOT v5.2 — ARCHITECTURE                    ║
╚══════════════════════════════════════════════════════════════════════════════╝

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  LAYER 0 — TRIGGER LAYER                                                 │
  │                                                                          │
  │  Cloudflare Cron (:00/:15/:30/:45 every hour)                            │
  │      → scheduled() → _scheduledImpl()                                    │
  │      → reads cycle# from KV → builds source list (config + D1 registry) │
  │      → priority-ranks sources (top 40 by priority_score)                 │
  │      → FEED_QUEUE.sendBatch(40 sources)                                  │
  │      → [every 4 cycles] recalculatePriorities()                          │
  │      → [every 4 cycles] probeDomainsForCareers()                         │
  │      → [every 8 cycles] runSearchExpansion() (Bing→Brave→static)         │
  │      → [every 24 cycles] retrainThresholds()                             │
  │      → [midnight UTC] sendDailyReport()                                  │
  └──────────────────────────────────┬───────────────────────────────────────┘
                                     │ 40 source messages
  ┌──────────────────────────────────▼───────────────────────────────────────┐
  │  LAYER 1 — FEED QUEUE (feed-queue, batch:5, retries:2)                   │
  │                                                                          │
  │  processFeeds(messages, env, ctx)                                        │
  │  ├── Circuit breaker check (KV) → skip if OPEN                          │
  │  ├── Attach ETag/LastModified headers from KV                            │
  │  ├── runAllConnectors (RSS/GH/Lever/Ashby/Workable/CareerPage)           │
  │  │     Parallel HTTP fetches (up to 7 concurrent)                        │
  │  │     → XML/JSON parsing → normalizeJob() → identity/content hashes     │
  │  ├── In-memory dedup: identity_hash Set + content_hash Set               │
  │  ├── batchInsertJobs(D1) — INSERT OR IGNORE (UNIQUE dedup)               │
  │  ├── JOB_QUEUE.sendBatch(newJobs, chunks of 10)                          │
  │  ├── recordFeedResult(KV) — health + ETag update                         │
  │  ├── batchUpdateSourceStats(D1) — failure counts, yield                  │
  │  ├── detectAtsSourcesWithDomains() — passive ATS discovery               │
  │  ├── batchRegisterDomains(D1) — queue domains for career probing         │
  │  ├── recordTermFrequencies(D1) — IDF signal update                       │
  │  ├── recordSourceYieldsBatch(D1) — priority recalculation input          │
  │  └── incrementDailyMetrics(D1)                                           │
  └──────────────────────────────────┬───────────────────────────────────────┘
                                     │ new jobs (slim, 10/message)
  ┌──────────────────────────────────▼───────────────────────────────────────┐
  │  LAYER 2 — JOB QUEUE (job-queue, batch:5, retries:3)                     │
  │                                                                          │
  │  evaluateJobs(messages, env, ctx)                                        │
  │  ├── getActiveProfiles(D1)                                               │
  │  ├── getPreferenceWeights(KV) — feedback weights                         │
  │  ├── getEffectiveThreshold(KV) — dynamic threshold (30–70)               │
  │  ├── getProfileEmbedding(AI, KV) — cached 24h profile vector             │
  │  ├── getGlobalTermFrequencies(D1) — TF-IDF IDF data                      │
  │  │                                                                        │
  │  │  Per job (wall-time guarded: 22s max):                                 │
  │  ├── isNewJob() — time window check                                       │
  │  ├── hasBasicKeywordMatch() — fast O(1) pre-filter                        │
  │  ├── computeQuickKeywordScore() — AI skip decision                        │
  │  ├── [if score < 75] embedChunks(AI, KV) — semantic vectors               │
  │  ├── TopKChunks min-heap → ragMatches                                     │
  │  ├── scoreJob() — 13-layer 0–100 scoring:                                 │
  │  │     [Exclusion → Title → Skills → Tech → Location → Salary →          │
  │  │      TF-IDF → Experience → Combos → Seniority → Penalties →           │
  │  │      Gate → RAG Semantic]                                              │
  │  ├── applyFeedbackBoost(KV prefWeights)                                   │
  │  ├── score ≥ effectiveThreshold → ALERT_QUEUE.send()                      │
  │  │     (withRetry × 3, fallback to sendAlert() inline)                    │
  │  ├── batchMarkAlertSent(D1)                                               │
  │  ├── [waitUntil] recordJobScoresBatch(KV) — histogram                    │
  │  ├── [waitUntil] cleanupStaleChunks(D1)                                  │
  │  └── incrementDailyMetrics(D1)                                           │
  └──────────────────────────────────┬───────────────────────────────────────┘
                                     │ qualified matches
  ┌──────────────────────────────────▼───────────────────────────────────────┐
  │  LAYER 3 — ALERT QUEUE (alert-queue, batch:5, retries:5)                 │
  │                                                                          │
  │  sendAlerts(messages, env, ctx)                                          │
  │  ├── sendAlert(job, scoreResult, { env })                                │
  │  │     ├── Discord: rich embed → fetchWithRetry(webhook)                 │
  │  │     │     Retry-After handling for 429 responses                       │
  │  │     └── Telegram: MarkdownV2 message → Telegram Bot API               │
  │  ├── stats.sent > 0 → msg.ack()                                          │
  │  └── stats.sent = 0 → msg.retry({ delaySeconds: 900 })                  │
  └──────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  STORAGE LAYER                                                           │
  │                                                                          │
  │  D1 SQLite Database (job-hunter-db)                                      │
  │  ├── jobs              — all crawled jobs (30d retention)                 │
  │  ├── profiles          — user notification profiles                      │
  │  ├── sent_alerts       — alert dedup log (90d retention)                 │
  │  ├── source_registry   — all source URLs with priority/health            │
  │  ├── job_chunks        — AI embedding chunks (7d retention)              │
  │  ├── daily_metrics     — one row/day, all counters                       │
  │  ├── term_frequencies  — global IDF data for TF-IDF scoring              │
  │  ├── career_probe_queue — domains pending career page check              │
  │  ├── skill_market_trends — trending skills over time                    │
  │  └── company_hiring_trends — company hiring velocity                    │
  │                                                                          │
  │  KV Namespace (SEEN_JOBS)                                                │
  │  ├── feed:health:{hash}     — per-feed reliability record               │
  │  ├── feed:circuit:{hash}    — circuit breaker open flag (TTL-based)     │
  │  ├── feed:cursor:{hash}     — RSS pubDate cursor for dedup               │
  │  ├── thresh:window          — rolling 200-score window                  │
  │  ├── thresh:effective       — current dynamic threshold                 │
  │  ├── profile:embedding      — cached 24h profile vector                 │
  │  ├── metrics:score_histogram — score distribution buckets               │
  │  ├── discovery:last_run_stats — search expansion telemetry              │
  │  └── __cycle_number         — global cycle counter                      │
  └──────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  INTELLIGENCE LAYER (cross-cutting, updated v5.3)                        │
  │                                                                          │
  │  feedHealth.js     — D1 health records + KV circuit breaker (v5.3)       │
  │  threshold.js      — D1 dynamic threshold + score histogram (v5.3)      │
  │  sourceIntelligence.js — priority scoring, crawl tier assignment         │
  │  growthEngine.js   — market skill spikes + company hiring surge signals  │
  │  dailyReport.js    — D1 aggregation + metrics buffering (v5.3)          │
  │  calibration.js    — threshold re-training (every 24 cycles)            │
  │  enrichment.js     — job metadata enrichment                            │
  │  feedback.js       — user preference weights → score boosts             │
  └──────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Job Lifecycle

```
T+0s    Cron fires (:00/:15/:30/:45)
T+1s    _scheduledImpl() runs — increments cycle, selects top 40 sources
T+2s    40 source messages sent to FEED_QUEUE (10 batches, 100ms pacing)
T+3s    Cloudflare begins delivering feed-queue messages in batches of 5

T+5s    processFeeds() invocation 1 starts (5 sources)
T+5s    → Circuit breaker check (KV). All 5 clear.
T+5s    → RSS/Greenhouse/Lever fetch — parallel HTTP (up to 7 concurrent)
T+7s    → HTTP responses arrive. Parse XML/JSON.
T+7s    → 203 raw jobs normalized to RawJob schema
T+7s    → In-memory dedup: 144 jobs filtered (identity_hash + content_hash)
T+8s    → ctx.waitUntil() dispatched:
T+8s      → batchInsertJobs(D1): 59 jobs inserted, 0 D1 dupes
T+8s      → JOB_QUEUE.sendBatch(59 slim jobs in 6 messages)
T+8s      → recordFeedResult(KV) × 5 sources
T+8s      → detectAtsSourcesWithDomains() → 2 new ATS sources registered
T+9s    → processFeeds() invocation 1 completes. Messages ack'd.

T+10s   evaluateJobs() invocation 1 starts (10 jobs, from 1 queue message)
T+10s   → Profile embedding loaded from KV (cached)
T+10s   → IDF data loaded from D1 (all mustMatch terms)
T+10s   → Job 1: hasBasicKeywordMatch() → PASS
T+10s   → quickKeywordScore = 82 → AI SKIP (already strong keyword match)
T+10s   → scoreJob(): Title=18 + Skills=25 + Tech=8 + Location=10 + Salary=10
           + TF-IDF=6 + Experience=+4 + Next.js+TS = +8 + Remote+India = +5
           Seniority mismatch = -8 → FINAL SCORE = 86
T+11s   → 86 ≥ effectiveThreshold (62) ✓
T+11s   → ALERT_QUEUE.send({ profileId, job, scoreResult })
T+12s   → batchMarkAlertSent(D1) — 1 row inserted into sent_alerts
T+12s   → evaluateJobs() completes. Messages ack'd.

T+15s   sendAlerts() invocation 1 starts
T+15s   → buildDiscordEmbed(job, scoreResult)
T+15s   → POST to Discord webhook → HTTP 200
T+15s   → buildTelegramMessage(job, scoreResult)
T+15s   → POST to Telegram Bot API → HTTP 200
T+16s   → msg.ack(). Alert delivered. Daily metrics updated.

T+0:00  Midnight UTC: sendDailyReport() fires
         → getDailyReportData(D1) + score histogram (KV)
         → formatDailyReport()
         → POST Daily Intelligence Report to Discord + Telegram
```

---

## Key Technology Decisions

| Decision | Rationale |
|---|---|
| Cloudflare Workers | Zero-ops, global edge, sub-30ms cold start, built-in queues/D1/KV/AI |
| Three-queue topology | Decouples crawl/score/alert stages; independent retry; prevents cascading failures |
| SimHash over MD5/UUID | Locality-sensitive: similar jobs have close hashes; no crypto overhead |
| FNV-1a over SHA/MD5 | 10× faster, sufficient collision resistance for dedup at this scale |
| FastMatcher Trie over regex | O(N) single-pass scan vs O(N×K); critical for high-volume job text scanning |
| D1 over R2/Firestore | SQL queries, UNIQUE constraints for free dedup; familiar tooling; low cost |
| Workers AI over OpenAI | No external API keys; zero latency (same edge PoP); cost-included in plan |
| KV over R2 for hot data | KV reads are O(1) globally replicated; sub-1ms reads for threshold/health state |

---

## System Health Scorecard

| Dimension | Current Status | Score |
|---|---|---|
| **Reliability** | Circuit breakers + 3-tier fallback + 5× alert retry | ✅ Excellent |
| **Observability** | Daily reports, score histogram, feed health, config warnings | ✅ Good |
| **Scalability** | Priority-ranked + AI skip + KV→D1 migration (v5.3)  | ✅ Excellent |  
| **Deduplication** | 4-layer (memory + D1 + SimHash + embedding) | ✅ Excellent |
| **Latency** | Jobs discovered within 15 minutes of posting | ✅ Excellent |
| **Cost** | All resources within free tier (v5.3: KV ~192/day) | ✅ Excellent |
| **Fault Tolerance** | Global try-catch, msg.retry() safety nets throughout | ✅ Excellent |
| **Intelligence** | Self-expanding sources, dynamic threshold, ML scoring | ✅ Advanced |

---

## Three Top Improvements (Priority Order)

> **All three completed in v5.3.** See [step15.md](./step15.md) for full details.

1. **✅ Added two staggered cron expressions** (`5,20,35,50` and `10,25,40,55`) → true batch distribution, per-invocation CPU reduced by 66%

2. **✅ Migrated health/threshold/histogram from KV → D1** → KV writes reduced from ~4,876 to ~192/day, fully within free tier

3. **✅ Added metrics write buffering** → `bufferMetrics()` accumulates in-memory, single `flushMetricsBuffer(D1)` per handler → ~66% fewer D1 writes
