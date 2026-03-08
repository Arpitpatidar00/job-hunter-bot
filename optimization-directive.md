Here is the complete, comprehensive Markdown file designed specifically to be fed into an AI coding agent (like Cursor, GitHub Copilot, or an autonomous coding tool).

It is structured with **Agent Directives**, strict constraints, and the exact algorithms needed to upgrade your Cloudflare Worker codebase.

---

````markdown
# ⚡ Job Hunter Bot v5.2.0 - DSA & Architecture Optimization Directive

## Context for AI Agent

You are tasked with refactoring the `Job Hunter Bot` codebase (currently at v5.1.0). The system is an event-driven job intelligence engine running on **Cloudflare Workers (Free Tier)**, utilizing D1, KV, Queues, and Workers AI.

The current logic is functionally perfect, but the algorithmic complexity (Big O) is too high, risking CPU time limits (50ms) and memory limits (128MB).

**Your goal is strictly structural optimization.** ## 🚨 STRICT RULES FOR AGENT 🚨

1. **NO BEHAVIORAL CHANGES:** Do not alter the final scoring outputs, alert formats, or external API payloads.
2. **NO NEW DEPENDENCIES:** Implement these algorithms natively in vanilla JavaScript/ESM. Do not install heavy npm packages.
3. **CLOUDFLARE NATIVE:** Respect the Worker environment. Use `ctx.waitUntil()` for background I/O. Do not use Node.js built-ins (like `fs` or `crypto` unless via Web Crypto API).

---

## Phase 1: The O(N) Scoring Engine Redesign (Aho-Corasick Trie)

**Target Files:** `src/scoring/relevance-v4.js`, `src/scoring/skills.js`

**Current Issue:** The bot uses dozens of `RegExp.test()` and `.includes()` inside loops. Complexity is `O(N * M)`.
**Directive:** Replace sequential regex scanning with a single-pass Trie (Aho-Corasick pattern).

1. Create `src/scoring/fastMatcher.js`.
2. Implement a `FastMatcher` class that builds a Trie from `skills.js` arrays on Worker initialization (global scope).
3. The `scan(text)` method must traverse the job description exactly **once**, character by character, matching skills, titles, and locations in `O(N)` time.

### Implementation Reference

```javascript
// src/scoring/fastMatcher.js
export class FastMatcher {
  constructor(keywords) {
    this.root = {};
    this.buildTrie(keywords);
  }

  buildTrie(keywords) {
    for (const { word, category, weight } of keywords) {
      let node = this.root;
      const normalized = word.toLowerCase();
      for (const char of normalized) {
        if (!node[char]) node[char] = {};
        node = node[char];
      }
      node.isEnd = true;
      node.payload = { word, category, weight };
    }
  }

  scan(text) {
    // Implement single-pass text scan here.
    // Return accumulated score, matched skills, and matched titles.
  }
}
```
````

---

## Phase 2: O(1) Near-Duplicate Detection (SimHash)

**Target File:** `src/core/dedup.js`

**Current Issue:** Similarity clustering performs heavy text chunking or nested array comparisons `O(J^2)`.
**Directive:** Implement integer-based SimHash clustering.

1. Create a `generateSimHash(text)` function.
2. Extract the first 20 significant words from a job description.
3. Generate a 32-bit unsigned integer using bitwise operations (like FNV-1a offset).
4. Refactor dedup logic to compare these integers (an `O(1)` operation) instead of raw strings.

### Implementation Reference

```javascript
export function generateSimHash(text) {
  let hash = 0x811c9dc5;
  const words = text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3)
    .slice(0, 20);

  for (let i = 0; i < words.length; i++) {
    for (let j = 0; j < words[i].length; j++) {
      hash ^= words[i].charCodeAt(j);
      hash +=
        (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
  }
  return hash >>> 0;
}
```

---

## Phase 3: Cloudflare Edge-Native I/O Offloading

**Target File:** `src/worker.js` (Main Entry Point)

**Current Issue:** The Worker waits for DB writes and Queue dispatches to finish before returning the response, burning precious CPU time quota.
**Directive:** Decouple blocking logic.

1. In the `scheduled` and `fetch` handlers, isolate data fetching and purely CPU-bound tasks (like `FastMatcher.scan`).
2. Wrap all `env.DB.batch()`, `env.KV.put()`, and `env.JOB_QUEUE.sendBatch()` calls inside `ctx.waitUntil()`.

### Implementation Reference

```javascript
export default {
  async scheduled(event, env, ctx) {
    // 1. BLOCKING: Fetch feeds and score in memory
    const newJobs = await processFeeds(env);
    const scoredJobs = scoreJobsInMemory(newJobs);

    // 2. NON-BLOCKING: Offload I/O to avoid CPU limits
    ctx.waitUntil(
      (async () => {
        await Promise.all([
          env.JOB_QUEUE.sendBatch(scoredJobs.map((body) => ({ body }))),
          batchInsertToD1(env.DB, scoredJobs),
        ]);
      })(),
    );

    return; // End execution immediately
  },
};
```

---

## Phase 4: O(N log K) RAG Sorting (Min-Heap)

**Target File:** `src/worker.js` (Inside evaluateJobs / AI Pipeline)

**Current Issue:** Cosine similarity results are likely stored in an array and fully sorted `O(N log N)` just to extract the top 5 chunks.
**Directive:** Replace array sorting with a Min-Heap.

1. Implement a lightweight Min-Heap class (Priority Queue).
2. As cosine similarities are calculated, push them into the heap.
3. If the heap size exceeds `K` (e.g., top 5), pop the smallest element.
4. This reduces the time complexity of finding the best AI chunks to `O(N log K)`.

---

## Execution Order for Agent

Agent, please execute the refactoring in the following strict order to ensure tests do not break:

1. Implement `FastMatcher` and map `skills.js` to it. Run tests.
2. Implement `SimHash` in `dedup.js`. Run tests.
3. Refactor `worker.js` to utilize `ctx.waitUntil` for all `D1`, `KV`, and `Queue` writes.
4. Implement the Min-Heap for the AI embedding pipeline.

```

***


This markdown file is formatted specifically to give an AI agent maximum context with minimum ambiguity. You can copy the code block above, save it as `optimization-directive.md` in your project root, and instruct your AI tool to "Read `optimization-directive.md` and begin implementing Phase 1."

Would you like me to map out your existing `skills.js` arrays into the new `FastMatcher` dictionary format so you can hand that to the agent as well?

```
