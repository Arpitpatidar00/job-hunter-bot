# Quick Wins

Low-effort, high-impact improvements that can be implemented immediately.

---

## 1. Parallelize Health Checks (processFeeds)
- **Difficulty:** Low (1-2 lines)
- **Impact:** High (🔴 Critical)
- **Action:** Replace `for...of` sequential health checks with `Promise.all` in `src/worker.js`.
```javascript
const records = await Promise.all(allSources.map(s => getFeedHealthRecord(env.DB, env.SEEN_JOBS, s.url)));
```

---

## 2. Range Query for Daily Report (dailyReport.js)
- **Difficulty:** Low (3-5 lines)
- **Impact:** Medium (🟡 Moderate)
- **Action:** Replace `date(fetched_at) = ?` with `fetched_at >= ? AND fetched_at < ?` and add a D1 index on `fetched_at`.

---

## 3. Module-Level Cache for Profiles (evaluateJobs)
- **Difficulty:** Low (5 lines)
- **Impact:** Low (🟢 Minor)
- **Action:** Introduce a module-level `_profileCache` in `src/worker.js` to save 1 D1 query per `evaluateJobs` run.

---

## 4. Increase AI Call Limit (ai.js / ai-v4.js)
- **Difficulty:** Trivial (1 line)
- **Impact:** High (🔴 Critical)
- **Action:** Temporarily increase `MAX_AI_CALLS_PER_INVOCATION` to 45 if the actual usage is consistently hitting the limit.

---

## 5. Parallel Platform Connectors (index.js)
- **Difficulty:** Low (5-10 lines)
- **Impact:** Medium (🟡 Moderate)
- **Action:** Modify `runAllConnectors` to run different platform groups in parallel using `Promise.all`, while maintaining same-platform chunking.
