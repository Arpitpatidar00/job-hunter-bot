Below is a **clean, optimized `.md` prompt** you can use to instruct an AI (or another developer) to **analyze, optimize, fix issues, and test the entire system** while **preserving existing functionality**.
It is structured so the AI **does not rewrite everything**, but instead **improves the current architecture safely**.

You can save this as something like:

```
cloudflare-worker-optimization-prompt.md
```

---

# Cloudflare Worker Optimization & Stability Prompt

You are a **senior Cloudflare Workers, distributed systems, and backend performance engineer**.

Your task is to **analyze, optimize, debug, and validate the existing Job Hunter Bot architecture (v5.1.0)** while **preserving all current functionality**.

The system already works but has **performance issues, Cloudflare free-tier limit risks, and architectural inefficiencies**.
Your job is to **optimize the implementation, fix issues, and validate the final solution through logical testing**.

---

# Primary Objectives

You must:

1. **Preserve all existing features and logic**
2. **Fix Cloudflare free-tier limit violations**
3. **Optimize performance and CPU usage**
4. **Reduce subrequests**
5. **Reduce database round trips**
6. **Avoid API rate limits**
7. **Minimize Workers AI usage**
8. **Prevent KV write quota exhaustion**
9. **Ensure the code stays compatible with Cloudflare Workers**
10. **Ensure the system runs reliably under free-tier limits**

---

# Cloudflare Free Tier Limits (Must Respect)

Your optimizations must respect these limits:

### Workers

- **50 subrequests per invocation**
- **10ms CPU time**
- **128MB memory**

### Workers KV

- **100,000 reads/day**
- **1,000 writes/day**

### Workers AI

- **10,000 neurons/day**

### Queues

- **1M operations/month**

### D1 Database

- **100k reads/day**
- **100k writes/day**

---

# Required Optimization Strategy

When optimizing the code:

### 1. Minimize Subrequests

Convert repeated queries into:

- **batched queries**
- **`IN (...)` queries**
- **`db.batch()` calls**

Avoid loops that trigger database queries.

---

### 2. Reduce Queue Operations

Replace multiple queue sends:

```
env.JOB_QUEUE.send()
```

With:

```
env.JOB_QUEUE.sendBatch()
```

Batch up to **100 messages per request**.

---

### 3. Reduce API Fetch Bursts

Prevent parallel fetch storms.

Implement:

- **chunking**
- **controlled concurrency**
- **source batching**

Never allow more than **10 external fetches per invocation**.

---

### 4. Prevent KV Write Exhaustion

Current system writes embeddings into KV.

KV writes exceed free-tier limits.

Solution:

Move embedding storage to:

```
D1 database
```

Only cache frequently reused embeddings.

---

### 5. Reduce CPU Usage

Avoid heavy synchronous operations like:

```
JSON.parse large vectors
cosineSimilarity loops
large array operations
```

Solutions:

- limit chunk counts
- pre-filter jobs
- avoid unnecessary embedding comparisons
- use lightweight filtering before AI

---

### 6. AI Usage Optimization

Do **NOT generate embeddings for every job**.

Instead:

1. Apply **keyword filtering first**
2. Only run embeddings for jobs that pass filtering

This reduces Workers AI neuron usage by **80-90%**.

---

### 7. Add Edge Caching

Endpoints like:

```
/metrics
/report
```

should include:

```
Cache-Control: public, max-age=3600
```

This prevents unnecessary Worker invocations.

---

### 8. Optimize Discovery Loops

Sequential database inserts like:

```
await registerDomain()
await registerDiscoveredSource()
```

must be converted into:

```
env.DB.batch()
```

to eliminate multiple round trips.

---

# Required Analysis

You must review the following files:

```
src/worker.js
src/db/profiles.js
src/connectors/ashby.js
src/connectors/greenhouse.js
src/connectors/index.js
src/notifications/ai-v4.js
```

For each file you must:

1. Identify performance bottlenecks
2. Identify Cloudflare limit violations
3. Identify redundant operations
4. Suggest minimal safe fixes
5. Provide optimized code snippets

---

# Required Output Format

Your output must follow this structure:

```
## Issue Summary
Describe the issue clearly.

## Why It Breaks Cloudflare Limits
Explain the technical reason.

## Optimized Fix
Explain the new approach.

## Updated Code Example
Provide optimized code snippet.

## Performance Impact
Explain improvements.
```

---

# Testing Requirements

After implementing fixes, you must **validate the architecture logically**.

Simulate scenarios such as:

### Scenario 1

20 jobs
5 profiles

Ensure:

- subrequests < 50

---

### Scenario 2

200 discovered jobs

Ensure:

- queue batching works
- worker does not crash

---

### Scenario 3

AI embedding generation

Ensure:

- embeddings only generated for filtered jobs

---

### Scenario 4

Dashboard requests

Ensure:

- `/metrics` endpoint uses caching

---

# Validation Checklist

Confirm the final architecture satisfies:

✔ Subrequests < 50
✔ CPU time < 10ms
✔ KV writes < 1000/day
✔ AI neuron usage < 10k/day
✔ Queue usage optimized
✔ D1 queries batched
✔ API rate limits avoided

---

# Important Rules

You must **NOT**:

- remove working features
- rewrite the system from scratch
- introduce breaking changes
- increase system complexity unnecessarily

You must **focus on minimal, safe, production-grade optimizations**.

---

# Expected Final Result

The system should become:

- **stable**
- **Cloudflare free-tier compliant**
- **low CPU usage**
- **low subrequests**
- **API rate-limit safe**
- **AI usage optimized**
- **scalable**

while maintaining **all current functionality**.
