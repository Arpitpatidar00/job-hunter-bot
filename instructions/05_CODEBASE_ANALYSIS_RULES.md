# 05 — How to Analyse This Codebase Efficiently

## The Right Mental Model

This is a live system with **known bugs already identified** from production logs. Before writing a single line of code, orient yourself using the known incident data in `00_AGENT_IDENTITY.md`. Do **not** re-investigate already-confirmed problems.

---

## Fast Orientation Checklist (Do This First in Any Session)

1. **Read `src/worker.js`** — understand current HTTP routes and queue consumer structure
2. **Read `config.json`** — all scoring, feed, and filter config lives here
3. **Read `wrangler.jsonc`** — confirms bindings, queue names, cron schedule
4. **Read `src/db/jobs.js`** — this is the #1 bug source (per-job D1 query loop)
5. **Read `src/scoring/relevance.js`** — confirm whether threshold uses `config.notificationThreshold` or hardcoded value
6. **Read `src/intelligence/feedHealth.js`** — confirm whether `catch {}` is fixed

If you're only changing one module, read that module and its direct callers from `worker.js`.

---

## What to Check (Priority Order)

### 🔴 Critical First

Before doing anything else, check whether these production bugs are already fixed:

| Bug | Where to check | Is it fixed? |
|-----|---------------|-------------|
| Per-job D1 loop (rate limits) | `src/db/jobs.js` — look for `for` loop with `db.prepare().run()` per job | Likely NO |
| Score threshold mismatch | `src/scoring/relevance.js` — search for hardcoded `80` or `60` instead of reading config | Likely NO |
| Missing MERN synonyms | `src/scoring/relevance.js` — search for 'mern' and 'fullstack' handling | Likely NO |
| Silent `catch {}` | `src/intelligence/feedHealth.js` — search for empty catch blocks | Likely NO |
| `pLimit` unused | `src/connectors/base.js` — verify pLimit is actually applied to concurrent fetches | Likely NO |

### 🟠 High Priority Second

- Ashby 401s: Check `src/connectors/ashby.js` for truncation or missing Bearer token validation
- Metrics per-job: Check `src/db/jobs.js` for `daily_metrics` increment inside job loop

### 🟡 Medium Priority Third

- L3/L5 discovery: Check `src/discovery/sourceDiscovery.js` and `searchExpander.js` for activation status
- URL validation: Check `src/connectors/base.js` and `discovery/` for `new URL(url)` guards

---

## Analysis Patterns

### Dead Code Detection

```
grep -r "function X" src/ | then check: grep -r "X(" src/ worker.js
```

If a function is exported but never imported, it's dead.

### Circular Import Detection

Trace: Does module A import from B which imports from A? Check `import` statements at top of each file.

### Query Count Estimation

In `src/db/jobs.js`, count number of `db.prepare()` calls inside a `for` loop or `.map()`. Each one is a D1 query per job. If batch size is 5 jobs and there are 3 queries per job = 15 queries. If processing multiple batches: approaches rate limit rapidly.

### Scoring Path Check

```
relevance.js:
  1. Read config thresholds — does it use config.notificationThreshold?
  2. mustMatch check — does it handle 'mern' / 'fullstack' / 'mern stack'?
  3. Does fuzzy matching use synonyms from config.json synonyms map?
```

---

## Rules When Making Changes

- **Never delete code without confirming it's unreachable** — search for all import references
- **Always use `logger.js` for new log statements** — never `console.log` in production code paths
- **When adding D1 queries** — add to `src/db/` module, use `db.batch()` for multi-row operations
- **When changing config-driven values** — change `config.json` not source code constants
- **When fixing error handling** — use structured logging: `logger.error(err.message, { source, context })`
