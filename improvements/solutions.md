# Optimization Solutions

This document provides technical solutions for the identified issues, including optimized implementations and trade-offs.

---

## 🔴 Solution 1: Batch Health Checks

**Current:** `getFeedHealthRecord` is called in a sequential loop (one source at a time).

**Optimized:**
1.  **Batch D1 Read:** Use a single D1 query with `WHERE url_hash IN (...)` to fetch all health records for the batch.
2.  **Parallel KV Reads:** If circuit breaker flags must stay in KV for TTL, fetch all flags for the batch using `Promise.all` instead of sequentially.

**Implementation (Pseudocode):**
```javascript
// New function in src/intelligence/feedHealth.js
export async function batchGetFeedHealthRecords(db, kv, urls) {
  const hashes = urls.map(urlKey);
  const placeholders = hashes.map(() => "?").join(",");
  const [rows, flags] = await Promise.all([
    db.prepare(`SELECT * FROM feed_health WHERE url_hash IN (${placeholders})`).bind(...hashes).all(),
    Promise.all(urls.map(url => kv.get(circuitKey(url))))
  ]);
  // Map rows and flags back to URLs...
}
```

**Why it's better:** Reduces subrequests by $2N \to 1+N$ (and even better if KV allowed batching, but at least D1 is batched). Significant latency reduction.

---

## 🔴 Solution 2: Multi-Job AI Batching

**Current:** Each job needing AI scoring performs an individual `aiBinding.run`.

**Optimized:** Collect ALL chunks from ALL jobs in the `evaluateJobs` batch (e.g., up to 100 chunks total) and call `generateEmbeddingBatch` (already exists in `ai.js`) once.

**Implementation (Strategy):**
1.  Loop through all jobs in the message batch.
2.  Identify jobs that need AI (low keyword score + no backlog).
3.  Collect their text chunks into a single array, keeping track of which chunk belongs to which job.
4.  Call AI ONCE with the full array of chunks.
5.  Distribute the results back to the respective jobs for scoring.

**Why it's better:** Reduces AI subrequests by $M \to \lceil M/20 \rceil$ (assuming 5 chunks/job and 100 max texts per AI call). Prevents hitting the 50-subrequest limit and ensures all jobs get high-quality scoring.

---

## 🔴 Solution 8: Efficient ATS Cursors (Pass 2)

**Current:** Sequential `loadAtsCursor` and `saveAtsCursor` (N+1 KV operations).

**Optimized:**
1.  **Parallel Load:** Fetch all cursors for the batch in parallel using `Promise.all` before processing.
2.  **Deferred Save:** Store updated cursors in a local object and perform a single `Promise.all` save at the end of the batch processing (using `ctx.waitUntil` if possible).

**Why it's better:** Reduces sequential wall-time significantly. Moving these cursors to D1 (Solution 5) is even better.

---

## 🔴 Solution 9: Valid Near-Duplicate Clustering (Pass 2)

**Current:** Groups by SimHash as an exact key (incorrect).

**Optimized:**
1.  Use `similarity_hash` (FNV-1a of company + title) for INITIAL grouping (guarantees exact duplicates cluster).
2.  Within each cluster, or across all jobs, use `cosineSimilarity` on embeddings (Solution 2) or `isNearDuplicateHash` (Solution 11) for fuzzy matches.
3.  For high-performance in-memory clustering:
    - Sort jobs by `similarity_hash`.
    - For each job, check against a sliding window of recent hashes for Hamming distance <= 5.

**Why it's better:** Corrects the architectural flaw where near-duplicates were missed.

---

## 🟡 Solution 10: Optimized Normalization (Pass 2)

**Current:** Double normalization in `normalizeJob` and `jobDedupeKey`.

**Optimized:** Refactor `normalizeJob` to normalize the title and company once and reuse the resulting variables for both the `RawJob` properties and the deduplication hashes.

**Why it's better:** Reduces regex overhead by 50% during the high-frequency ingestion path.

---

## 🔴 Solution 11: Batch Term Frequencies (Pass 3)

**Current:** 1 D1 write transaction per job (`recordTermFrequencies`).

**Optimized:**
1.  **Buffer in Memory:** Collect all unique terms from ALL jobs in the `evaluateJobs` batch into a single `Map<term, count>`.
2.  **Single Flush:** At the end of the batch, perform ONE `UPDATE scoring_meta` and ONE `db.batch()` for all accumulated term counts.

**Why it's better:** Reduces D1 write transactions from $N \to 2$ per worker run. Massive scalability improvement.

---

## 🟡 Solution 12: Deferred Alert Dedup (Pass 3)

**Current:** `getSentAlertsForJobs` called for every job evaluated.

**Optimized:** Only query `sent_alerts` for jobs that have ALREADY passed the `notificationThreshold` in the scoring pipeline.

**Why it's better:** Reduces the number of D1 read queries by 80-90% (since most jobs don't match).

---

## 🟡 Solution 13: Unified FastMatcher (Pass 3)

**Current:** `FastMatcher` for scoring, redundant regex for `enrichment.js`.

**Optimized:** Add the keywords for tech stack, industry, and urgency signals to the `FastMatcher` trie. The `scan()` result will then contain all necessary metadata, eliminating the need for `enrichment.js` to perform its own regex scans.

**Why it's better:** Reduces redundant text traversals from $O(M \cdot N) \to O(N)$ (where $M$ is the number of metadata categories).

---

## 🟡 Solution 14: Parallel Career Probes (Pass 4)

**Current:** Sequential `for...of` loop in `fetchCareerPageJobs`.

**Optimized:** Use `pLimit` with a concurrency of 3-5 to parallelize career page probes.

**Why it's better:** Reduces wall-time for career page fetching by up to 80%.

---

## 🟡 Solution 15: Non-Blocking Writes (Pass 4)

**Current:** `await` on every D1 write.

**Optimized:** Use `ctx.waitUntil(promise)` for non-critical writes (metrics, source stats, term frequencies).

**Why it's better:** Allows the worker to acknowledge queue messages and finish its primary task immediately, reducing execution time and preventing message visibility timeouts.

---

## 🔴 Solution 16: Batched IDF Fetch (Pass 4)

**Current:** `SELECT ... WHERE term IN (...)` for every single job.

**Optimized:**
1.  **Extract All Terms:** Before evaluating ANY jobs in a batch, extract unique terms from ALL jobs in that batch.
2.  **Single Bulk Read:** Perform one large D1 `SELECT` for all those terms.
3.  **Local Map:** Store results in a local `Map<term, count>` for use across all scoring evaluations in that run.

**Why it's better:** Reduces IDF-related D1 read queries from $N \to 1$ per batch.

---

## 🔴 Solution 17: Early Dedup Exit (Pass 5)

**Current:** Evaluate job -> Check if sent -> Discard if sent.

**Optimized:**
1.  **Parallel Dedup Check:** At the start of `evaluateJobs`, perform a single `getSentAlertsForJobs` (Solution 12) for ALL jobs in the batch.
2.  **Early Exit:** Skip scoring/AI/enrichment entirely for any `jobId:profileId` pair already in the `sent_alerts` set.

**Why it's better:** Eliminates 100% of expensive CPU/API work for jobs that have already alerted.

---

## 🟡 Solution 18: Streamlined Inserts (Pass 5)

**Current:** `SELECT 1` + `INSERT`.

**Optimized:** Remove the `SELECT 1` and rely entirely on `INSERT OR IGNORE` or `ON CONFLICT DO NOTHING`.

**Why it's better:** Reduces D1 write-path queries by 50%.

---

## 🟡 Solution 19: Dynamic Timeouts (Pass 5)

**Current:** 10s timeout for all.

**Optimized:** Pass a `timeoutMs` parameter to connectors and allow them to override it based on source type (e.g., 5s for APIs, 20s for HTML pages).

**Why it's better:** Reduces false-positive timeouts for slow HTML pages and identifies dead APIs faster.

---

## 🟡 Solution 20: Combined Sanitization (Pass 6)

**Current:** 8 sequential `.replace()` calls.

**Optimized:**
1.  **Split logic:** Move HTML entity decoding to a dedicated function called only for RSS.
2.  **Combine Regex:** Use a single regex pass for whitespace and simple HTML tag removal where possible.

**Why it's better:** Reduces the number of full-string scans during normalization.

---

## 🟡 Solution 21: Fast Bigram Similarity (Pass 6)

**Current:** `Map`-based bigram comparison.

**Optimized:** Use an object with a null prototype (`Object.create(null)`) or a pre-allocated typed array if possible for bigram counts. For short strings, the overhead of creating a `Map` is significant.

**Why it's better:** Improves fuzzy matching speed during high-frequency scoring runs.

---

## 🟡 Solution 22: Single-Pass Signal Extraction (Pass 6)

**Current:** Multiple regex tests for remote, seniority, and tech stack.

**Optimized:** Integrate all static signals (remote, seniority, stack) into the `FastMatcher` trie. A single character-by-character scan will then populate all metadata flags simultaneously.

**Why it's better:** Eliminates $O(K \cdot N)$ regex scans where $K$ is the number of metadata patterns.

---

## 🔴 Solution 23: Deprecate v3 Engine (Pass 7)

**Current:** Both v3 and v4 logic may be present.

**Optimized:** Fully remove `relevance.js` and consolidate all scoring logic into `relevance-v4.js`. Ensure that the `worker.js` only imports and calls the v4 engine.

**Why it's better:** Reduces maintenance overhead and prevents double-scoring performance penalties.

---

## 🟡 Solution 24: Pre-compiled Regex Cache (Pass 7)

**Current:** `new RegExp()` called in loops.

**Optimized:** Move all regex creation to a module-level `Map` or use `FastMatcher`. If using `RegExp`, compile the patterns once when the config is loaded or at the start of the worker invocation.

**Why it's better:** Reduces regex compilation overhead from thousands of calls to just a few dozen per run.

---

## 🟡 Solution 25: Single Sanitization Pass (Pass 7)

**Current:** Multiple calls to `sanitizeText` across different layers.

**Optimized:** Sanitize ONCE in `normalizeJob` (schema.js) and trust that the `RawJob` objects passed to the scoring engine are already clean.

**Why it's better:** Eliminates redundant string processing during the high-frequency scoring path.

---

## 🔴 Solution 26: Batch Seen Checks (Pass 8)

**Current:** $2N$ sequential `kv.get` calls per batch.

**Optimized:** Use a single `Promise.all` for all `kv.get` checks at the beginning of the ingestion phase. Or better: use a Bloom filter stored in KV (and cached in memory) to filter out 99% of already-seen jobs with 1 KV read.

**Why it's better:** Reduces sequential wall-time for "seen" checks by $O(N) \to O(1)$ (effective).

---

## 🟡 Solution 27: Synchronous Hashing (Pass 8)

**Current:** `async sha256Short`.

**Optimized:** Replace `crypto.subtle.digest` with the synchronous `FNV-1a` hash (already implemented in `schema.js`). Use this for ALL internal deduplication and similarity keys.

**Why it's better:** Reduces event loop overhead and eliminates the need for `await` on every job fingerprinting step.

---

## 🟡 Solution 28: Parallel Alerts (Pass 9)

**Current:** Sequential `await discord()` -> `await telegram()`.

**Optimized:** Use `Promise.allSettled()` to send notifications to all channels in parallel.

**Why it's better:** Reduces wall-time for alert delivery by up to 50% for multi-channel users.

---

## 🟡 Solution 29: Single-Pass Telegram Escaping (Pass 9)

**Current:** 17 sequential `.replace()` calls in `escTg`.

**Optimized:** Use a single regex with a replacer function: `str.replace(/[...]/g, m => '\\' + m)`.

**Why it's better:** Reduces 17 full-string scans to just 1.

---

## 🟡 Solution 30: Discovery Indexes (Pass 11)

**Current:** Missing or non-optimized indexes for discovery.

**Optimized:** Add the following indexes to D1:
1.  `CREATE INDEX idx_source_registry_tier ON source_registry(enabled, crawl_tier, next_crawl_at);`
2.  `CREATE INDEX idx_source_registry_discovered ON source_registry(enabled, discovered_at);`
3.  `CREATE INDEX idx_jobs_company ON jobs(company) WHERE company != '';`

**Why it's better:** Enables SQLite to use efficient index scans for cycle selection and hiring surge detection, scaling from $O(N) \to O(\log N)$.

---

## 🟡 Solution 31: Robust Cycle Counter (Pass 11)

**Current:** In-memory counter prone to cold starts.

**Optimized:**
1.  **Shared State:** Store the cycle number in KV but use a "write-through" cache.
2.  **Modulo persistence:** Instead of `_inMemoryCycle % 10`, use a timestamp-based or explicit `put()` after critical runs.
3.  **D1 Alternative:** Move the cycle counter to a single-row `system_state` table in D1.

**Why it's better:** Guarantees cycle number persistence and avoids redundant KV reads/writes.

---

## 🟡 Solution 32: Connector API Batching (Pass 12)

**Current:** One API call per company board.

**Optimized:**
1.  For **Ashby**: Group sources and send a single GraphQL query with multiple operation aliases or a batched `query`.
2.  For **Greenhouse**: Explore if their `/boards` API supports multi-slug filters (unlikely for public API, but worth confirming).
3.  **Implementation:** Refactor `fetchAshbyJobs` to collect all slugs first, then dispatch a single batched request.

**Why it's better:** Reduces subrequests and latency, especially when a single cycle contains many sources from the same ATS.

---

## 🟡 Solution 33: Parallel Feedback Updates (Pass 13)

**Current:** Sequential KV read/write for history and weights.

**Optimized:**
1.  **Parallel Read:** Fetch both `HISTORY_KEY` and `WEIGHTS_KEY` in parallel using `Promise.all`.
2.  **Parallel Write:** Save both keys in parallel using `Promise.all`.

**Why it's better:** Reduces sequential wall-time for a feedback recording by 50% (4 KV calls $\to$ 2 concurrent rounds).

---

## 🟡 Solution 34: Atomic D1 Lock (Pass 14)

**Current:** Non-atomic KV "read-then-write" lock.

**Optimized:**
1.  **Table Setup:** Create a `run_locks` table in D1 with a `UNIQUE` constraint on the lock name.
2.  **Acquire:** Attempt an `INSERT` into the table. If it fails with `UNIQUE constraint failed`, the lock is held. Check `created_at` for manual expiration.
3.  **Release:** `DELETE` the row.

**Why it's better:** Provides strong ACID atomicity for locks, preventing all race conditions during concurrent triggers.

---

## 🟡 Solution 35: Stateful D1 Batching (Pass 15)

**Current:** Time-staggered crons with fragile overlaps.

**Optimized:**
1.  **Selection:** Move to a single cron that triggers a "Batch Selector".
2.  **State:** The selector checks a `batch_state` table in D1 to see which batch is due next based on `last_run_at`.
3.  **Dispatch:** It dispatches the correct batch to the `FEED_QUEUE`.

**Why it's better:** Decouples task execution from the wall clock, preventing overlaps and ensuring every source is crawled exactly according to its interval.

---

## 🟡 Solution 3: Index-Friendly Ground-truth Queries

**Current:** `WHERE date(fetched_at) = ?` (full scan).

**Optimized:** Use a range query on the raw ISO string column.

**Implementation:**
```javascript
const todayStart = `${date}T00:00:00.000Z`;
const todayEnd = `${date}T23:59:59.999Z`;
db.prepare(`SELECT COUNT(*) as count FROM jobs WHERE fetched_at >= ? AND fetched_at <= ?`).bind(todayStart, todayEnd);
```
**Prerequisite:** Add an index specifically on `fetched_at` in the `jobs` table.

**Why it's better:** Allows SQLite to use a B-tree index on `fetched_at`, reducing scan time from $O(N) \to O(\log N)$.

---

## 🟡 Solution 4: Parallel Connector Processing

**Current:** 1s delay between chunks of 10 sources, processed sequentially.

**Optimized:**
1.  Group sources by platform (type).
2.  Process different platforms in parallel.
3.  For same-platform sources, keep the chunking/delay but use `Promise.all` across DIFFERENT platforms.

**Why it's better:** If a crawl batch contains 10 Greenhouse, 10 Lever, and 10 RSS sources, they can all run concurrently, saving ~2 seconds of artificial wall-time delay.

---

## 🟡 Solution 5: D1-backed RSS Cursors

**Current:** 2 KV operations (get/put) per RSS feed.

**Optimized:** Move `rss_cursor` tracking to the `source_registry` table in D1 as a `last_cursor_val` column.

**Implementation:**
1.  Add `last_cursor_val TEXT` to `source_registry`.
2.  Fetch this value in `getEnabledSources` (already happening in `scheduled`).
3.  Update it in `batchUpdateSourceStats`.

**Why it's better:** Eliminates $2N$ KV operations. Since D1 writes are already batched in `processFeeds`, this adds zero extra subrequests.

---

## 🟡 Solution 6: Batch Registration Enforcement

**Current:** `batchRegisterDiscoveredSources` bypasses the 10k limit.

**Optimized:** Implement a `count + truncate` logic within the batch function.

**Implementation:**
```javascript
// src/db/sources.js
export async function batchRegisterDiscoveredSources(db, sources) {
  // ... existing batch insert ...
  // AFTER insert, check total count
  const countRes = await db.prepare("SELECT COUNT(*) as cnt FROM source_registry").first();
  if (countRes.cnt > 10000) {
    const overflow = countRes.cnt - 10000;
    await db.prepare(`DELETE FROM source_registry WHERE url IN (SELECT url FROM source_registry ORDER BY last_fetched_at ASC LIMIT ?)`).bind(overflow).run();
  }
}
```

---

## 🟢 Solution 7: Module-Level Caching for Profiles

**Optimized:** Store `activeProfiles` in a module-level variable with a TTL.

**Implementation:**
```javascript
let _profileCache = null;
let _profileCacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export async function getCachedProfiles(db) {
  const now = Date.now();
  if (!_profileCache || now - _profileCacheTime > CACHE_TTL) {
    _profileCache = await getActiveProfiles(db);
    _profileCacheTime = now;
  }
  return _profileCache;
}
```
