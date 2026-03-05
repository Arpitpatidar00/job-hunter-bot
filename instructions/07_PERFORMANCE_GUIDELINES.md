# 07 — Performance & Cost Guidelines

## Cloudflare Free Tier Hard Limits (Know These Cold)

| Resource | Free Limit | Current Risk |
|----------|-----------|-------------|
| Worker CPU time | 10ms burst / 30s total per invocation | 🔴 EXCEEDED — 114 `exceededCpu` invocations in prod |
| D1 queries per invocation | ~50 soft limit | 🔴 EXCEEDED — per-job loop causes 50+ queries |
| KV reads | 100k/day | ⚠️ Monitor — run-lock + feed state reads per cycle |
| Workers AI calls | 40 calls observed in daily report | ✅ OK — already gated behind scoring threshold |
| Queue messages | 400k/month free | ✅ OK at current volume |

---

## Confirmed Performance Problems (Real Production Data)

### Problem 1: D1 Query Explosion
**Root cause**: In `src/db/jobs.js`, for each job in a queue batch:
- 1 dedup check query
- 1 insert query  
- 1 metrics update query  
= **3 queries × N jobs**. With batch size 5 = 15 queries just for jobs. Additional queries for source state = frequently over the ~50 limit.

**Fix**: Replace with a single `db.batch()` call:
```js
// Before (broken):
for (const job of jobs) {
  await db.prepare('SELECT id FROM jobs WHERE url=?').bind(job.url).first();
  await db.prepare('INSERT INTO jobs ...').bind(...).run();
  await db.prepare('UPDATE daily_metrics ...').run();
}

// After (correct):
const stmts = jobs.map(job => db.prepare('INSERT INTO jobs ... ON CONFLICT DO NOTHING').bind(...));
stmts.push(db.prepare('UPDATE daily_metrics SET jobs_inserted=jobs_inserted+? WHERE date=?').bind(jobs.length, today));
await db.batch(stmts);
```

### Problem 2: Unbounded Concurrent Connector Fetches
**Root cause**: `src/connectors/base.js` imports `pLimit` but never uses it. All feeds fetch in full parallelism.  
**Fix**: Apply `pLimit(config.maxConcurrentFeeds || 7)` in the connector dispatch loop in `base.js`.

### Problem 3: Sequential RSS Parsing
**Root cause**: `src/connectors/rss.js` parses feeds sequentially instead of in parallel bounded batches.  
**Fix**: Use `batcher.js` chunking + `Promise.allSettled()` with `pLimit`.

---

## Performance Rules

- **Never call `db.prepare().run()` inside a `for` loop** — always batch
- **Always use `INSERT ... ON CONFLICT DO NOTHING`** for job dedup — never a separate SELECT + INSERT
- **Aggregate metrics in memory first** — one `UPDATE daily_metrics SET X=X+N` per batch, not per job
- **Hard-cap jobs per invocation at 5** (already set in `wrangler.jsonc`) — do not increase without testing
- **Workers AI calls only after score pre-filter** — check title/skills match first, AI only for candidates scoring >40
- **KV writes must have TTL** — all `SEEN_JOBS.put()` calls must include `expirationTtl`

---

## Quick D1 Query Counter (Add If Not Present)

Add to `src/core/utils.js` or `src/db/index.js`:

```js
let _queryCount = 0;
export function trackQuery(label = '') {
  _queryCount++;
  if (_queryCount > 40) {
    logger.warn('Approaching D1 query limit', { count: _queryCount, label });
  }
}
export function resetQueryCount() { _queryCount = 0; }
```

Call `trackQuery('jobs.insert')` before each `db.prepare()` invocation.

---

## Cost Efficiency Checklist

- [ ] `db.batch()` used for all multi-row operations in `db/jobs.js`
- [ ] Metrics updated once per batch, not per job
- [ ] `pLimit` actually applied in `connectors/base.js`
- [ ] All KV writes have `expirationTtl`
- [ ] Workers AI only called after score ≥ 40 pre-filter
- [ ] Queue batch sizes stay at 5 (don't increase)
