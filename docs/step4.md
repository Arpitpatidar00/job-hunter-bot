# Step 4 — Deduplication System

## Overview

Deduplication removes the same job appearing multiple times — from different sources, different crawl cycles, or slightly different URLs. The system uses **four layers** of dedup, each progressively more expensive but more accurate.

```
Raw Jobs (from connectors)
    │
    ├── Layer 1: In-memory identity_hash dedup   (O(1), same batch)
    ├── Layer 2: In-memory content_hash dedup    (O(1), same batch)
    ├── Layer 3: D1 UNIQUE constraint catch-all  (cross-cycle)
    └── Layer 4: Embedding cosine similarity     (alert-queue only)
```

---

## 4.1 Why Four Layers?

| Layer | When Applied | Cost | Purpose |
|---|---|---|---|
| identity_hash | processFeeds() | O(1) in-memory | Same company+title+location duplicates |
| content_hash | processFeeds() | O(1) in-memory | Same company+title+content body |
| D1 UNIQUE | batchInsertJobs() | 1 DB call | Cross-cycle cross-source duplicates |
| Embedding similarity | evaluateJobs() | AI API call | Semantically identical jobs with different titles |

---

## 4.2 Hash Generation

**Module:** `src/core/schema.js`

All three hashes use **FNV-1a** — a fast, non-cryptographic hash:

```js
function fnvHash(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
```

### Hash Definitions:

| Hash | Formula | Purpose |
|---|---|---|
| `identity_hash` | `FNV(company + title + location)` | Same job, same place |
| `content_hash` | `FNV(company + title + content[:500])` | Same job, same description |
| `similarity_hash` | `FNV(normalized_company + normalized_title)` | Near-duplicate (e.g. title casing varies) |

---

## 4.3 Layer 1 + 2: In-Memory Dedup (processFeeds)

```js
const localSeenIdentity = new Set();
const localSeenContent  = new Set();

for (const job of jobs) {
  if (job.identity_hash && localSeenIdentity.has(job.identity_hash)) {
    identityDupes++; continue;
  }
  if (job.content_hash && localSeenContent.has(job.content_hash)) {
    contentDupes++; continue;
  }
  localSeenIdentity.add(job.identity_hash);
  localSeenContent.add(job.content_hash);
  dedupedJobs.push(job);
}
```

This runs entirely in memory — zero I/O. For a batch of 200 jobs, the entire dedup loop takes under 1ms.

**What it catches:** Multiple RSS feeds linking to the same job (e.g., WeWorkRemotely main feed AND their programming sub-feed).

---

## 4.4 Layer 3: D1 UNIQUE Constraint (Cross-Cycle)

**Module:** `src/db/jobs.js`

The `jobs` table has UNIQUE constraints on `identity_hash` AND `content_hash`:

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  identity_hash TEXT UNIQUE,
  content_hash TEXT,
  ...
);
```

`batchInsertJobs()` uses `INSERT OR IGNORE`:
```js
db.prepare(`INSERT OR IGNORE INTO jobs (id, ...) VALUES (?, ...)`)
```

If the job was seen in a previous cron cycle, the insert silently fails. The return value distinguishes inserted vs. skipped:

```js
const { inserted: newJobs, duplicates: d1Dupes } = await batchInsertJobs(env.DB, dedupedJobs);
```

**What it catches:** Jobs that appeared in yesterday's crawl and appear again today.

---

## 4.5 Layer 4: SimHash — O(1) Near-Duplicate Detection

**Module:** `src/core/dedup.js`

SimHash generates a **32-bit locality-sensitive hash** — similar text produces similar (close Hamming distance) hashes:

```js
export function generateSimHash(text) {
  let hash = 0x811c9dc5;
  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 2).slice(0, 50);

  for (let i = 0; i < words.length; i++) {
    const weight = i < 10 ? 3 : 1; // First 10 words weighted 3x (title/company)
    for (let w = 0; w < weight; w++) {
      for (let j = 0; j < words[i].length; j++) {
        hash ^= words[i].charCodeAt(j);
        hash = Math.imul(hash, 0x01000193);
      }
    }
  }
  return hash >>> 0;
}
```

**Hamming Distance Check:**
```js
export function isNearDuplicate(textA, textB, maxDistance = 5) {
  return hammingDistance(generateSimHash(textA), generateSimHash(textB)) <= maxDistance;
}
```

If Hamming distance ≤ 5 bits (out of 32), the jobs are considered near-duplicates.

---

## 4.6 Layer 5: Embedding Cosine Similarity (Alert Layer)

**Module:** `src/core/dedup.js`

Before sending an alert, the job's semantic embedding vector is compared against the profile vector using cosine similarity:

```js
export function cosineSimilarity(vecA, vecB) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot   += vecA[i] * vecB[i];
    normA += vecA[i] ** 2;
    normB += vecB[i] ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function isDuplicateByEmbedding(embA, embB, threshold = 0.88) {
  return cosineSimilarity(embA, embB) >= threshold;
}
```

**Threshold:** 0.88 cosine similarity = 88% semantic match → considered duplicate.

This catches: "Senior React Developer" vs "React Frontend Engineer" — same job, different title wording.

---

## 4.7 Cross-Source Cluster Dedup

**Module:** `src/core/dedup.js` — `clusterDuplicates()`

Before D1 insert, a **SimHash clustering pass** groups jobs that are likely the same:

```js
export function clusterDuplicates(jobs) {
  const clusters = new Map();
  for (const job of jobs) {
    const hash = generateSimHash(`${job.title} ${job.company} ${job.contentSnippet}`);
    if (!clusters.has(hash)) clusters.set(hash, []);
    clusters.get(hash).push(job);
  }

  for (const [, group] of clusters) {
    // Pick canonical: earliest pubDate
    const sorted = group.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));
    uniqueJobs.push(sorted[0]);
    duplicatesFound += group.length - 1;
  }
}
```

Within each SimHash cluster, the **earliest-published** job is kept as canonical. Others are dropped.

---

## 4.8 Dedup Metrics Logged Per Cycle

```
[Metrics] processFeeds: total=2134ms |
  rawJobs=187 deduped=43 |
  identityDupes=89 contentDupes=55 totalInMemory=144
```

- `rawJobs`: total from all feeds
- `deduped`: jobs that passed in-memory dedup
- `identityDupes`: filtered by identity_hash
- `contentDupes`: filtered by content_hash
- D1 dupes are logged separately from `batchInsertJobs()`

---

## 4.9 KV-Based Cycle Dedup (Removed)

An earlier version used KV to track seen job IDs per cycle:
```js
// REMOVED: cycle KV dedup (wrong key format caused bugs)
// D1 UNIQUE constraints are now the cross-cycle catch-all
```

The decision was made that D1's UNIQUE constraints are more reliable than KV-based tracking, which had key collision bugs.

---

## Flow Diagram

```
Raw Jobs[]
    │
    ├─ identity_hash Set check (in-memory)
    │       → identityDupes++ if seen
    │
    ├─ content_hash Set check (in-memory)
    │       → contentDupes++ if seen
    │
    ├─ batchInsertJobs(DB, dedupedJobs)
    │       → INSERT OR IGNORE
    │       → returns { inserted: newJobs[], duplicates: d1Dupes }
    │
    └─ evaluateJobs (AI embedding similarity)
            → isDuplicateByEmbedding() at 0.88 threshold
            → Prevents alerting on the same job twice
```

**Inputs:** Raw job array from connectors  
**Outputs:** `newJobs[]` (truly new, never-seen jobs)  
**Storage:** D1 `jobs` table (UNIQUE constraint), KV (embedding cache)  
**Dedup rate:** Typically 70–90% of raw jobs are duplicates
