# 08 — Scalability & Reliability Guidelines

## Current Reliability Status (Production-Verified)

| Component | Health | Issue |
|-----------|--------|-------|
| Cron trigger | ✅ Firing (409+ cycles) | None |
| Feed fetch (L1 RSS) | ✅ Active (1573 jobs/cycle) | Sequential parse — use pLimit |
| Feed fetch (L2 ATS) | ⚠️ 29% fail rate | Ashby 401, Greenhouse 404, circuits OPEN |
| D1 inserts | ❌ Rate-limited | Per-job query loop |
| Scoring | ❌ 0% pass rate | Threshold mismatch, missing MERN synonyms |
| Alerts | ❌ 0 sent | Upstream scoring broken |
| Circuit breakers | ⚠️ OPEN for Ashby | 60-min cooldown auto-recovery |

---

## Idempotency (Check These)

Cloudflare Queues **will retry** failed messages. Every queue handler must be idempotent:

| Queue | Idempotency mechanism | Current state |
|-------|----------------------|---------------|
| `feed-queue` consumer | KV run-lock via `runLock.js` | ✅ Exists — verify it's checked before processing |
| `job-queue` consumer | `INSERT ... ON CONFLICT DO NOTHING` in D1 | ❌ Currently separate SELECT + INSERT = not idempotent on retry |
| `alert-queue` consumer | `seen_alerts` table dedup | ✅ Should exist — verify in `notifications/` |

**Rule**: If a queue handler fails midway, re-running it must not create duplicate jobs or send duplicate alerts.

---

## Circuit Breaker (feedHealth.js)

The system has circuit breakers in `src/intelligence/feedHealth.js`. What to verify:

- Sources fail → failure counter increments
- After 5 failures → circuit OPEN (source skipped for `cooldown` period, currently 60 min)
- After cooldown → circuit transitions to HALF_OPEN → test one request → if OK, CLOSED

**Known issues**:
- `catch {}` swallows circuit transition errors — fix by adding `logger.error()`
- Failed sources may never recover if `HALF_OPEN → CLOSED` logic is broken — read and verify
- No back-off or jitter on retries before circuit trips (causes API rate limit 429s → triggers circuit prematurely)

---

## Scalability Rules

1. **All queue handlers must cap at ≤5 jobs per invocation** (already enforced by `max_batch_size: 5` in `wrangler.jsonc` — do not override)
2. **No global in-memory state that persists across Worker invocations** — Workers are stateless; D1/KV hold all state
3. **Discovery layers (L3/L5) must be activated with rate limits** — `searchExpander.js` needs `pLimit` + DDG rate guard before enabling
4. **Database growth**: Add cleanup jobs to purge jobs older than 30 days from `jobs` table (currently no cleanup)
5. **Source list growth**: Cap at reasonable limit (e.g., 500 sources max) — unbounded source growth will exceed queue/D1 limits

---

## Reliability Fixes (Priority Ordered)

1. **Fix `INSERT ON CONFLICT DO NOTHING`** in `src/db/jobs.js` — eliminates duplicate risk on retry
2. **Add `logger.error()` in all `catch {}` in `feedHealth.js` and `storage/`** — stop swallowing errors
3. **Verify `HALF_OPEN → CLOSED` transition** in `feedHealth.js` — sources must be able to recover
4. **Add exponential backoff + jitter** in `src/connectors/base.js` `retryFetch()` — respects 429 responses
5. **Add `seen_alerts` dedup check** in `src/notifications/notificationQueue.js` — prevent duplicate alerts on retry
