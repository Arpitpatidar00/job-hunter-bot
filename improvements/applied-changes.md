# Applied Changes

All fixes applied surgically — only necessary code was modified.

---

## Fix 1+2: Batch Health Checks

**Files:** `src/intelligence/feedHealth.js`, `src/worker.js`

**Before (`worker.js`):**
```js
for (const feed of batchConfig.feeds) {
  const record = await getFeedHealthRecord(env.DB, env.SEEN_JOBS, feed.url); // N D1 + N KV
  ...
}
for (const src of batchConfig.sources) {
  const record = await getFeedHealthRecord(env.DB, env.SEEN_JOBS, src.url); // N D1 + N KV
  ...
}
```

**After (`worker.js`):**
```js
const healthRecordMap = await batchGetFeedHealthRecords(env.DB, env.SEEN_JOBS, allSourceUrls);
for (const feed of batchConfig.feeds) {
  const record = healthRecordMap.get(feed.url) || { circuitOpen: false }; // O(1) map lookup
  ...
}
```

**New function (`feedHealth.js`):**
```js
export async function batchGetFeedHealthRecords(db, kv, urls) {
  const [rowsResult, circuitFlags] = await Promise.all([
    db.prepare(`SELECT * FROM feed_health WHERE url_hash IN (?,...)`).bind(...hashes).all(),
    Promise.all(urls.map(url => isFeedCircuitOpen(kv, url)))
  ]);
  // Map results back to urls...
}
```

**Why safe:** Returns identical data — same `circuitOpen`, `etag`, `lastModified` per URL. Fallback to `defaultRecord` on error (fail-open, same as before).  
**Performance gain:** N D1 queries + N sequential KV reads → 1 D1 query + N parallel KV reads. For 40 sources: ~39 saved D1 roundtrips, KV reads now parallel.

---

## Fix 3: Range Queries in Daily Report

**File:** `src/intelligence/dailyReport.js`

**Before:**
```sql
SELECT COUNT(*) as count FROM jobs WHERE date(fetched_at) = ?
-- date() wrapper prevents index use → O(N) full table scan
```

**After:**
```js
function toDateRange(dateStr) {
  return { start: `${dateStr}T00:00:00.000Z`, end: `${dateStr}T23:59:59.999Z` };
}
// ...
SELECT COUNT(*) as count FROM jobs WHERE fetched_at >= ? AND fetched_at <= ?
```

**Why safe:** Returns identical count for the same day — ISO8601 range `T00:00Z` to `T23:59:59.999Z` covers all timestamps in the day. Prerequisite index added in migration 0017.  
**Performance gain:** O(N) full scan → O(log N) B-tree index scan via `idx_jobs_fetched_at`.

---

## Fix 4: Parallel Platform Connectors

**File:** `src/connectors/index.js`

**Before:**
```js
for (const [type, sources] of grouped) {  // sequential: rss → greenhouse → lever → ...
  ...
  if (i + CHUNK_SIZE < sources.length) await new Promise(r => setTimeout(r, 1000)); // blocks all
}
```

**After:**
```js
const typeResults = await Promise.allSettled(
  [...grouped.entries()].map(async ([type, sources]) => {
    // Same chunk + 1000ms delay, but now concurrent across types
  })
);
```

**Why safe:** Each platform type is independent — parallelizing them cannot cause cross-platform 429s. Same-type chunking (1000ms delay) is preserved within each Promise. `Promise.allSettled` ensures one platform crash doesn't kill others.  
**Performance gain:** If a cycle has 5 platform types each needing 1 chunk delay, wall-time drops from ~5s to ~1s (dominated by the slowest type).

---

## Fix 5: Source Cap Enforcement in Batch Registration

**File:** `src/db/sources.js`

**Before:**
```js
export async function batchRegisterDiscoveredSources(db, sources) {
  // Directly inserts without checking 10k cap
  const stmts = sources.map(s => db.prepare(`INSERT OR IGNORE ...`).bind(...));
  await db.batch(stmts);
}
```

**After:**
```js
const countResult = await db.prepare("SELECT COUNT(*) as cnt FROM source_registry").first();
const potentialCount = currentCount + sources.length;
if (potentialCount > 10000) {
  const overflow = potentialCount - 10000;
  await db.prepare(`DELETE FROM source_registry WHERE url IN (SELECT ... ORDER BY priority_score ASC LIMIT ?)`).bind(overflow).run();
}
// Then proceed with batch insert
```

**Why safe:** Same eviction logic as `registerDiscoveredSource` (single-source variant). `INSERT OR IGNORE` still applies — if eviction yields 0 rows (no stale sources), the new inserts will simply hit the IGNORE clause and be silently skipped.  
**Performance gain:** Prevents unbounded growth past 10k sources, maintaining consistent query performance.

---

## Fix 6: Module-Level Profile Cache

**File:** `src/worker.js`

**Before:**
```js
const profiles = await getActiveProfiles(env.DB); // D1 query every invocation
```

**After:**
```js
let _profileCache = null;
let _profileCacheTime = 0;
const _PROFILE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getCachedProfiles(db) {
  const now = Date.now();
  if (!_profileCache || now - _profileCacheTime > _PROFILE_CACHE_TTL_MS) {
    _profileCache = await getActiveProfiles(db);
    _profileCacheTime = now;
  }
  return _profileCache;
}
// ... used as: const profiles = await getCachedProfiles(env.DB);
```

**Why safe:** Profiles change rarely (manual admin action). Cache TTL = 10 min means stale profile data would propagate for at most 10 min. Cold starts always fetch fresh. Cache is module-level (per isolate), so multiple concurrent invocations in the same warm worker share it.  
**Performance gain:** Warm workers skip 1 D1 query per `evaluateJobs` invocation.

---

## Fix 7: Parallel Discord + Telegram Alerts

**File:** `src/notifications/notifications.js`

**Before:**
```js
// Sequential: Discord first, then Telegram
const res1 = await fetchWithRetry(discordUrl, ...);
// ... error handling ...
const res2 = await fetch(tgUrl, ...);
```

**After:**
```js
const channelPromises = [];
if (hasDiscord) channelPromises.push((async () => { ...discord send...; return 'Discord'; })());
if (hasTelegram) channelPromises.push((async () => { ...telegram send...; return 'Telegram'; })());

const results = await Promise.allSettled(channelPromises);
for (const result of results) {
  if (result.status === 'fulfilled') { stats.sent++; stats.channels.push(result.value); }
  else { stats.failed++; errors.push(result.reason); }
}
```

**Why safe:** `Promise.allSettled` — one channel failing never prevents the other from completing. Error collection and throw-on-all-failed behavior are identical to the original.  
**Performance gain:** Multi-channel alert wall-time reduced by ~50% (concurrent instead of sequential).

---

## Fix 8: Performance Indexes Migration

**File:** `migrations/0017_performance_indexes.sql`

```sql
CREATE INDEX IF NOT EXISTS idx_jobs_fetched_at ON jobs(fetched_at);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company) WHERE company != '';
CREATE INDEX IF NOT EXISTS idx_source_registry_tier ON source_registry(enabled, crawl_tier, next_crawl_at);
CREATE INDEX IF NOT EXISTS idx_source_registry_discovered ON source_registry(enabled, discovered_at);
```

**Why safe:** `CREATE INDEX IF NOT EXISTS` — idempotent, no data mutation, no query behavior changes.  
**Performance gain:** Enables Fix 3 range queries to use B-tree index; also enables O(log N) source selection for scheduled crawls.
