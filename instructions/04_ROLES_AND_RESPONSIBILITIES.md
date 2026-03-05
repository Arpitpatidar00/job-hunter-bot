# 04 — Module Responsibilities & Boundaries

## Module Map (Who Owns What)

| Module | Files | Responsibility | Must NOT do |
|--------|-------|---------------|------------|
| `src/worker.js` | single file | HTTP routes, Cron trigger, Queue consumers — orchestration only | Contain SQL, business rules, or scoring logic directly |
| `src/core/` | `logger.js`, `utils.js`, `schema.js`, `batcher.js` | Logging, helpers, job normalization, chunking | Import from connectors, intelligence, db, notifications |
| `src/connectors/` | `rss.js`, `greenhouse.js`, `lever.js`, `ashby.js`, `workable.js`, `careerPage.js`, `index.js`, `base.js` | Fetch raw feed/API data, normalize to job schema | Write to DB, call scoring, trigger notifications |
| `src/discovery/` | `sourceDiscovery.js`, `careerDetector.js`, `searchExpander.js` | Find new job sources | Embed scoring or notification logic |
| `src/intelligence/` | `sourceIntelligence.js`, `feedHealth.js`, `threshold.js`, `dailyReport.js` | Prioritise sources, manage circuit breakers, tune thresholds | Do HTTP fetching itself, write jobs to DB directly |
| `src/scoring/` | `relevance.js`, `feedback.js` | Score 0–100, apply bonuses/penalties, calibrate | Query DB directly or send notifications |
| `src/db/` | `jobs.js`, `sources.js`, `profiles.js`, `terms.js`, `index.js` | ALL D1 queries live here — ONLY here | Import from notifications, scoring, or connectors |
| `src/notifications/` | `notifications.js`, `notificationQueue.js`, `ai.js` | Format and send alerts; Workers AI embeddings | Import db/ directly (use data passed from orchestrator) |
| `src/storage/` | `storage.js`, `runLock.js`, `feeds.js` | KV abstraction for locks, dedup, feed state | Contain business rules; should be thin wrappers |

---

## Boundary Rules (Hard Rules — Flag Violations)

1. **Only `db/` may run D1 queries.** If you see `env.DB.prepare()` outside of `src/db/`, that's a violation.
2. **Only `connectors/` and `discovery/` may make external HTTP calls.** If `scoring/` or `intelligence/` makes a `fetch()`, that's a violation.
3. **`notifications/` must not import `db/`.** Data is passed to it from `worker.js` or the queue processor.
4. **No circular imports.** `intelligence/` → `scoring/` → `intelligence/` is forbidden.
5. **`worker.js` delegates to modules.** Any SQL or scoring logic inline in route handlers is a violation.

---

## Current Known Boundary Violations

| Violation | File | Status |
|-----------|------|--------|
| Per-job D1 queries inside queue consumer loop | `src/db/jobs.js` (called from `worker.js` queue consumer) | ❌ Active — causes D1 rate limits |
| Silent `catch {}` swallowing KV errors | `src/intelligence/feedHealth.js`, `src/storage/` | ❌ Active — masks real errors |
| `pLimit` imported in `base.js` but never applied | `src/connectors/base.js` | ❌ Active — all fetches run unbounded concurrently |

---

## When You Add or Modify Code

- **New DB access** → add to `src/db/` module, not inline in `worker.js` or any consumer
- **New external fetch** → add to appropriate connector or discovery module
- **New scoring logic** → add to `src/scoring/relevance.js` or `feedback.js` only
- **New notifications** → extend `src/notifications/`
- **New config tuning** → update `config.json`, not hardcoded values in source files
