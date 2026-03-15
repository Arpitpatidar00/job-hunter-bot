# Job Bot Infrastructure — Architecture Issues & Corrective Actions

## Purpose

This document identifies architectural weaknesses and operational bottlenecks in the job discovery and scoring pipeline.

The goal is to:

- Diagnose the root causes of failures
- Categorize system risks
- Provide architecture-level solutions
- Maintain the existing design philosophy (distributed workers + queues + scoring engine)

The fixes proposed here **preserve the core architecture while eliminating operational inefficiencies**.

---

# 1. Storage Architecture Issues

## Problem 1 — Excessive KV Writes

### Description

The system relies heavily on **Cloudflare KV** for mutable operational state.

Current estimated write load:

```
≈ 4,876 KV writes / day
```

Cloudflare KV free tier limit:

```
1,000 writes / day
```

Because KV writes exceed the limit, the system experiences:

- task failures
- state inconsistencies
- cron pipeline interruptions

### Root Cause

KV is being used for **high-frequency mutable state**.

Examples:

```
feed:health:{hash}
feed:circuit:{hash}
metrics:score_histogram
thresh:window
```

These values are written **inside loops during feed processing**, causing exponential write amplification.

Example write pattern:

```
40 sources × 96 cron cycles
= 3,840 writes/day
```

### Impact

- KV quota exhaustion
- pipeline failures
- unreliable system state
- delayed job processing

### Architectural Fix

Move **high-frequency mutable state** to **Cloudflare D1**.

#### New Storage Mapping

| Data Type             | Storage |
| --------------------- | ------- |
| Source health metrics | D1      |
| Telemetry metrics     | D1      |
| Threshold windows     | D1      |
| Feed cursors          | KV      |
| Circuit breaker flags | KV      |
| AI embedding cache    | KV      |
| Configuration flags   | KV      |

### Result

Estimated KV usage after migration:

```
~120–180 writes/day
```

This safely fits within free tier limits.

---

# 2. Cron Scheduling Architecture

## Problem 2 — Batch Staggering Not Working

### Description

The system intends to stagger feed processing into multiple batches to reduce load spikes.

However the current cron configuration is:

```
0,15,30,45 * * * *
```

Which results in:

```
batchId = 0 for every run
```

The batching logic never activates.

### Impact

- simultaneous source crawling
- network spikes
- increased CPU usage
- inefficient worker utilization

### Architectural Fix

Implement true cron staggering:

```
Batch A
0,15,30,45 * * * *

Batch B
5,20,35,50 * * * *

Batch C
10,25,40,55 * * * *
```

### Result

Benefits:

- distributed crawl workload
- smoother CPU utilization
- reduced queue bursts
- improved reliability

---

# 3. Unnecessary Persistent Storage

## Problem 3 — Job Chunk Storage

### Description

The scoring system writes job chunks into persistent storage:

```
job_chunks:{jobId}:{chunk}
```

However these chunks are only used **within the same evaluation cycle**.

### Impact

Unnecessary database load:

```
100 jobs/day × 5 chunks
= 500 extra writes/day
```

### Architectural Fix

Remove persistent chunk storage completely.

Use **in-memory processing**:

```
embedChunks()
TopKChunks()
evaluateJob()
```

Chunks should only exist during runtime.

### Result

- Reduced database load
- Faster scoring pipeline
- Simpler architecture

---

# 4. Queue Processing Inefficiency

## Problem 4 — Small Queue Batch Size

### Description

Feed queue currently processes batches of:

```
5 sources per worker
```

With 40 sources total:

```
40 / 5 = 8 worker invocations
```

This causes unnecessary overhead.

### Architectural Fix

Increase batch size:

```
batchSize = 10
```

New workload:

```
40 / 10 = 4 workers
```

### Result

- lower worker overhead
- faster queue processing
- improved throughput

---

# 5. Search Discovery API Overuse

## Problem 5 — Repeated Search Expansion Queries

### Description

Discovery engine repeatedly runs identical search queries.

Example:

```
site:greenhouse.io "software engineer"
site:lever.co "software engineer"
```

Without caching, these queries execute repeatedly.

### Impact

- unnecessary API calls
- slower discovery
- possible API rate limits

### Architectural Fix

Add query caching in **Cloudflare KV**.

Example key:

```
search:cache:{queryHash}
```

TTL:

```
24 hours
```

### Result

- reduced API usage
- faster discovery
- improved stability

---

# 6. Metrics System Write Amplification

## Problem 6 — High Frequency Metrics Writes

Metrics currently update KV multiple times per cron cycle.

Example:

```
incrementDailyMetrics()
```

Write volume:

```
96 cron cycles × 3 writes
= 288 writes/day
```

### Architectural Fix

Buffer metrics in memory during execution.

```
metricsBuffer = {}
```

Flush metrics **once per cycle**.

### Result

```
96 writes/day
```

Reduced by ~66%.

---

# 7. Queue Backlog Monitoring Missing

## Problem 7 — No Queue Depth Protection

Currently the system has no mechanism to detect:

```
job ingestion rate > scoring rate
```

If scoring slows down, queues may accumulate large backlogs.

### Impact

- delayed job alerts
- stale recommendations
- worker overload

### Architectural Fix

Implement queue depth monitoring.

Example rule:

```
if queueDepth > 200
   disable AI scoring
   fallback to keyword scoring
```

### Result

- system remains responsive
- prevents backlog accumulation
- maintains job processing speed

---

# 8. Discovery Engine Structural Limitation

## Problem 8 — Source Prioritization Limits Scaling

The `source_registry` does not dynamically prioritize sources based on performance.

Without prioritization:

- low-value sources consume crawl cycles
- high-value sources receive equal scheduling

### Architectural Fix

Introduce a **source priority score**.

Example signals:

```
job yield
success rate
latency
recent discoveries
```

Sources with higher scores should receive **more frequent crawling**.

### Result

- improved job discovery rate
- reduced wasted crawls
- better resource utilization

---

# 9. Long-Term Scaling Consideration

The system's primary scaling bottleneck is **AI embedding latency**.

If sources grow significantly:

```
500 sources
```

Potential job ingestion:

```
2000 jobs/day
```

Embedding load could exceed worker capacity.

### Architectural Strategy

Introduce a **multi-stage scoring pipeline**.

Stage 1:

```
keyword filtering
```

Stage 2:

```
AI embedding scoring
```

Only top candidates proceed to AI scoring.

### Result

- controlled compute usage
- scalable scoring pipeline

---

# Final Architecture Summary

| Category             | Status             |
| -------------------- | ------------------ |
| Core architecture    | Strong             |
| Queue design         | Good               |
| Worker orchestration | Good               |
| Storage design       | Needs correction   |
| Discovery engine     | Needs optimization |
| Scaling readiness    | Moderate           |

Overall system maturity:

```
Production-capable after the fixes described in this document.
```

The core design remains valid.
The required changes primarily involve **correct storage usage and operational efficiency improvements**.
