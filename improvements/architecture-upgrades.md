# Architectural Upgrades

This document outlines high-leverage architectural improvements for long-term scalability and efficiency.

---

## 1. Unified Source Priority Engine (D1-native)

**Target:** Replace hybrid KV/D1 selection logic with a single, efficient D1 query.

**Implementation:**
- All source stats (latencies, yield, alert rate) are already in `source_registry`.
- Select the next crawl batch using a complex `ORDER BY` directly in D1:
```sql
SELECT * FROM source_registry
WHERE enabled = 1
ORDER BY
  priority_score DESC,
  last_fetched_at ASC
LIMIT 40
```
- **Benefit:** Eliminates the need for multiple selection passes in `scheduled()`.

---

## 2. In-Memory AI Chunk Aggregation

**Target:** Drastically reduce AI subrequests.

**Implementation:**
- Implement a `ChunkAggregator` class in `evaluateJobs`.
- Collect chunks from multiple jobs in a single buffer.
- When buffer reaches 100 chunks OR end of message batch, flush to `env.AI`.
- Store result vectors in a shared `Map<chunk_text, vector>`.
- **Benefit:** Reduces subrequests by ~90%, staying well within Cloudflare's free tier (50 subrequests/invocation).

---

## 3. Caching Strategy: Warm Worker State

**Target:** Reduce redundant DB reads for static/slow-moving config.

**Cache Keys & TTLs:**
- `activeProfiles`: 10-minute TTL (memory).
- `globalThreshold`: 5-minute TTL (memory).
- `globalIdfData`: 1-hour TTL (memory).
- `sourceRegistryCount`: 30-minute TTL (memory).

**Implementation:** Use module-level variables in `src/worker.js` or respective modules.

---

## 4. Discovery Engine isolation

**Target:** Prevent discovery spikes from affecting ingestion latency.

**Implementation:**
- Move all discovery-related D1 writes (`batchRegisterDiscoveredSources`, `batchRegisterDomains`) to the end of `processFeeds` via `ctx.waitUntil`.
- Ensure discovery results are also batched (already mostly done).
- Move discovery logic to a dedicated "Discovery Worker" (separate queue) to avoid CPU contention with ingestion. (Done in v5.2, verify implementation).
