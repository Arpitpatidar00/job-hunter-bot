# 10 — Reporting Format

## When to Write a Report

Write a report when completing a full audit of the codebase or a specific feature area. Always reference **actual files and line numbers** — never generic advice.

---

## Report Structure

### 🔴 Critical Issues

For each:
- **Title**: Short, action-oriented (e.g., "Per-Job D1 Query Loop Causes Rate-Limit Failures")
- **File + line(s)**: e.g., `src/db/jobs.js:40–65`
- **Observed impact**: "114 `exceededCpu` invocations; 50+ D1 errors per cycle in production"
- **Root cause**: What specific code path causes it
- **Fix**: Concrete code change with snippet — use `db.batch()`, `ON CONFLICT`, etc.

### 🟠 High Issues

Same structure. These are serious but not immediately causing data loss or downtime.  
Examples: missing auth on `/trigger`, Ashby 401s breaking L2 source coverage.

### 🟡 Medium Issues

- Code smells, partial validation gaps, stale code paths
- Gaps that reduce yield (e.g., missing MERN synonyms in scoring)
- Not immediately dangerous but blocking feature effectiveness

### 🟢 Low / Improvements

- Naming consistency
- Dead code removal
- Minor logging improvements
- Refactoring opportunities without behaviour change

---

## Current Baseline (as of 2026-03-05 Audit)

Use this as your starting point — don't re-report known issues unless you're adding a fix:

| # | Severity | Issue | Fixed? |
|---|---------|-------|--------|
| 1 | 🔴 Critical | Per-job D1 query loop causing rate limits | ❌ No |
| 2 | 🔴 Critical | CPU exceeded (114 invocations) | ❌ No |
| 3 | 🔴 Critical | Score threshold mismatch — 0 alerts sent | ❌ No |
| 4 | 🟠 High | Ashby 401 / circuit OPEN — L2 sources down | ❌ No |
| 5 | 🟠 High | Silent `catch {}` masking KV/circuit errors | ❌ No |
| 6 | 🟠 High | `pLimit` unused — unbounded concurrent fetches | ❌ No |
| 7 | 🟡 Medium | Missing MERN/fullstack synonyms in scoring | ❌ No |
| 8 | 🟡 Medium | `daily_metrics` incremented per job not per batch | ❌ No |
| 9 | 🟡 Medium | L3/L5 discovery idle with unvalidated URL patterns | ❌ No |
| 10 | 🟢 Low | Log noise — same D1 errors repeated per job | ❌ No |

---

## Production Readiness Score

Current score: **4/10** (live but architecturally unstable under load)

Reason:
- Core pipeline runs (cron → feed → job → scoring) but scoring produces 0 alerts
- D1 rate limits hit every cycle causing data loss
- No auth on control endpoints
- Sources partially offline (Ashby, Greenhouse)

To reach **7/10**, complete:
1. Fix `db.batch()` in `src/db/jobs.js`
2. Fix scoring threshold in `src/scoring/relevance.js`
3. Add MERN synonyms to scoring
4. Fix silent `catch {}` blocks
5. Auth-protect `/trigger` endpoint

---

## Scalability Plan Summary

| Horizon | Action |
|---------|--------|
| Now (critical) | `db.batch()`, fix scoring threshold, fix `pLimit` |
| Short-term | Activate L3 with URL validation, rotate Ashby key |
| Medium-term | Activate L5 with DDG rate limits, add cleanup job for old jobs |
| Long-term | Move `daily_metrics` to separate queue to decouple from job processing |
