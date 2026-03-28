# Skipped Changes

The following issues from `issues.md` and `solutions.md` were NOT applied.

---

## Issue #2: N+1 AI Embeddings in `evaluateJobs`

**Solution proposed:** Collect all chunks from all jobs in the batch into a single array, call `generateEmbeddingBatch` once, then distribute results.

**Reason skipped:** The proposed `ChunkAggregator` pattern requires significant restructuring of the `evaluateJobs` inner loop — chunk collection, slot tracking, and result distribution across multiple messages. The existing code already has an `aiCallsCount` guard and a `queueBacklogDetected` fallback to keyword-only scoring which mitigates the severity. Risk of async bugs (wrong chunk→job mapping) exceeds the benefit without an integration test that validates AI scores per-job.

**Status:** `uncertain` — requires dedicated implementation and testing.

---

## Issue #5: RSS KV Cursors → D1

**Solution proposed:** Move `rss_cursor` tracking from KV to a `last_cursor_val` column in `source_registry`, eliminating 2N KV ops per cycle.

**Reason skipped:** Requires a schema migration adding a new column, changes to `rss.js` (cursor read from source object instead of KV), changes to `batchUpdateSourceStats` (cursor write alongside source stats), and a zero-downtime cursor handoff strategy. The migration risk (loss of cursor state for all RSS feeds on deploy, causing 1 cycle of duplicate jobs) is too high without a coordinated deploy plan.

**Status:** `risky` — valid improvement, needs coordinated schema migration.

---

## Issue #29: Telegram Escaping Optimization

**Solution proposed:** Replace 17 sequential `.replace()` calls with a single regex replacer.

**Reason skipped:** **Already implemented.** `escTg` in `notifications.js:37` already uses a single regex: `str.replace(/[_*[\]()~\`>#+\=|{}.!\-]/g, '\\$&')`. No action required.

**Status:** `already_done`

---

## Architecture Upgrade #34: Atomic D1 Lock

**Solution proposed:** Replace KV read-then-write lock with a D1 `run_locks` table using UNIQUE constraint for atomicity.

**Reason skipped:** Requires DDL (`CREATE TABLE run_locks`), new migration, and a full lock/unlock abstraction. No current critical race condition evidence in production logs. High implementation complexity for uncertain gain.

**Status:** `low_priority` — valid for future hardening, not a performance issue.

---

## Solution #8: ATS Cursor Batching

**Solution proposed:** Parallelize `loadAtsCursor`/`saveAtsCursor` across connector's sources.

**Reason skipped:** ATS connectors already fetch multiple sources in chunks. KV cursor loading is per-connector and happens inside each connector module. Implementing parallel load/save requires changes to every ATS connector's interface. Current bottleneck is fetching, not cursor I/O.

**Status:** `low_impact` — deferred.
