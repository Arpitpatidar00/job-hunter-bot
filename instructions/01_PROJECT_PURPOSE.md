# 01 — Project Purpose & Current Status

## What This Project Does

`job-hunter-bot` is an **automated job discovery and scoring engine** that:
1. Crawls 25+ RSS feeds + ATS boards (Greenhouse, Lever, Ashby, Workable, career pages) every 15 minutes
2. Normalizes raw job data into a unified schema
3. Deduplicates via URL + content hash
4. Scores jobs 0–100 using a 7-layer relevance engine targeting MERN/Next.js stack + remote/India roles
5. Sends high-scoring job alerts to Discord/Telegram (threshold: score ≥ 50)
6. Self-expands its source list via discovery layers (currently mostly idle)

Everything runs on **Cloudflare Workers free tier** — no servers, no containers.

---

## Current Pipeline Reality (Production Data)

| Stage | What Should Happen | What Actually Happens |
|-------|-------------------|-----------------------|
| Cron fires (every 15 min) | Dispatches sources to `FEED_QUEUE` | ✅ Working — 409+ cron cycles observed |
| Feed fetching | Connectors fetch and normalize jobs | ⚠️ 71% success — Ashby/Greenhouse circuits open |
| Job insertion | Batch insert to D1 | ❌ 50+ D1 rate-limit hits per cycle due to per-job queries |
| Scoring | 7-layer score assigned | ❌ 0% relevance pass rate — threshold mismatch + missing MERN synonyms |
| Alerts | Discord/Telegram messages sent | ❌ 0 alerts sent despite 60k raw jobs ingested |
| Discovery | New ATS/career pages auto-discovered | ❌ L3 (Auto ATS), L5 (Search Expansion) idle |

**Bottom line**: The ingestion and alert pipeline is architecturally correct but has 3 critical bugs blocking end-to-end job alerts.

---

## 5-Layer Source Growth Model

| Layer | Source type | Status |
|-------|------------|--------|
| L1 | RSS feeds (25 defined in `config.json`) | ✅ Active — 1573 jobs/cycle |
| L2 | Manual ATS boards (Ashby, Greenhouse, Lever, Workable) | ⚠️ Partially failing (401s, 404s) |
| L3 | Auto ATS discovery (`sourceDiscovery.js`) | ❌ Idle / unvalidated |
| L4 | Career page probing (`careerPage.js`) | ⚠️ 71% success |
| L5 | Search expansion (`searchExpander.js`) | ❌ Never activated |

---

## Your Primary Goals (in priority order)

1. **Fix the 3 critical production bugs** (D1 batching, scoring threshold, missing MERN synonyms)
2. **Harden connectors** against auth failures and timeouts
3. **Improve observability** (structured logging, D1 query counter, circuit breaker visibility)
4. **Activate L3/L5 discovery safely** (validate URLs, add rate limits)
5. **Keep everything within Cloudflare free‑tier constraints** at every step
