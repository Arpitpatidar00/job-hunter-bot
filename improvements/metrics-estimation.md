# Metrics Estimation

Estimated impact of proposed optimizations on system performance and platform usage.

---

## 📉 Subrequest Reduction: ~75%

**Justification:**
- **Feed Health:** $2N \to 1+N$. (Parallelizing health checks reduces latency, batching D1 reads reduces query count).
- **AI Scoring:** $M \to \lceil M/20 \rceil$. (Batching multiple job chunks into single AI calls).
- **RSS Cursors:** $2N \to 0$ (moved to D1).
- **Total:** Estimated reduction from ~100-120 per full cycle to ~20-30.

---

## 📉 KV Operation Reduction: ~90%

**Justification:**
- **RSS Cursors:** $100\%$ reduction (moved to D1).
- **Health Records:** $100\%$ reduction (already moved to D1, but `circuitOpen` remains).
- **Total:** From ~200 writes/day to <20 (only for actual circuit state changes).

---

## 📉 Database Query Cost: ~40% Reduction

**Justification:**
- **Indexing:** $O(N) \to O(\log N)$ on `jobs` table (via `fetched_at` range queries).
- **Batching:** Further reduction in per-job queries (already mostly batched, but `evaluateJobs` has room for improvement).
- **Caching:** Eliminates redundant profile and threshold queries.

---

## ⚡ Latency Improvement: ~30-50%

**Justification:**
- **Ingestion Time:** ~5-10s saved per cycle by parallelizing health checks and platform connectors.
- **Evaluation Time:** ~2-5s saved by batching AI calls (less subrequest overhead and platform-level batching).
