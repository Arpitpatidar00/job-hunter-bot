# Step 3 — Crawler Pipeline

## Overview

After the cron fires and sources are dispatched to `feed-queue`, the crawler pipeline begins. Each message in `feed-queue` is a single source definition. The worker processes it, fetches the jobs, parses them, and normalizes them into a standard schema.

```
FEED_QUEUE → processFeeds() → runAllConnectors() → Normalized Jobs → JOB_QUEUE
```

---

## 3.1 Queue Consumer: `processFeeds()`

**Triggered by:** Messages arriving on `feed-queue`  
**Queue config:** `max_batch_size: 5`, `max_batch_timeout: 2s`, `max_retries: 2`

Each message in `feed-queue` is a source object with these fields:
```json
{
  "url": "https://weworkremotely.com/remote-jobs.rss",
  "type": "rss",
  "name": "We Work Remotely",
  "etag": "...",
  "lastModified": "..."
}
```

---

## 3.2 Circuit Breaker Check (Before Fetching)

Before calling any connector, the health of each source is checked:

```js
for (const feed of batchConfig.feeds) {
  const record = await getFeedHealthRecord(env.SEEN_JOBS, feed.url);
  if (record.circuitOpen) {
    logger.warn(`[Circuit] Skipping ${feed.url} — circuit is OPEN`);
  } else {
    feed.etag = record.etag;
    feed.lastModified = record.lastModified;
    healthyFeeds.push(feed);
  }
}
```

Only sources with a **closed circuit** proceed to the connector. Sources that have failed 5+ consecutive times are skipped entirely during their cooldown period.

---

## 3.3 Connectors

**Module:** `src/connectors/`

The system has 6 specialized connectors, each adapted to a specific API or data format:

### Connector Types

| Connector | File | What It Handles |
|---|---|---|
| **RSS** | `rss.js` | Standard RSS/Atom feeds from job boards |
| **Greenhouse** | `greenhouse.js` | `boards-api.greenhouse.io` JSON API |
| **Lever** | `lever.js` | `api.lever.co` JSON REST API |
| **Ashby** | `ashby.js` | `api.ashbyhq.com` posting API |
| **Workable** | `workable.js` | `apply.workable.com` JSON API |
| **Career Page** | `careerPage.js` | Direct company career pages (raw HTML parsing) |

### Connector Index

All connectors are orchestrated by `src/connectors/index.js`:
```js
export async function runAllConnectors(config, kv) {
  // Run RSS feeds + ATS sources in parallel (up to maxConcurrentFeeds=7)
  const results = await Promise.allSettled([...]);
  return { jobs, feedStats, totalItems, totalErrors };
}
```

---

## 3.4 RSS Connector Deep Dive

**File:** `src/connectors/rss.js`

The RSS connector handles 29 feeds including:
- WeWorkRemotely (6 category feeds)
- RemoteOK
- Himalayas
- Jobscollider
- SmartRemoteJobs
- Cryptocurrency job boards
- AI job boards
- Startup-focused boards

### Key Features:
1. **ETag/Last-Modified caching** — Sends conditional HTTP headers to avoid re-downloading identical feeds
2. **pubDate cursor** — Tracks the timestamp of the latest seen item per feed in KV; skips items older than the cursor
3. **Time window filtering** — Only includes jobs posted within `config.timeWindowHours` (24 hours by default)

```js
// RSS connector KV key pattern for pubDate cursor:
`feed:cursor:${urlHash}` → "2026-03-14T10:00:00.000Z"
```

---

## 3.5 ATS Connector Deep Dive

### Greenhouse (`greenhouse.js`)
```
GET https://boards-api.greenhouse.io/v1/boards/{company}/jobs
Response: { jobs: [{ id, title, location, content, ... }] }
```
Extracts department, location, and absolute_url as the job link.

### Lever (`lever.js`)
```
GET https://api.lever.co/v0/postings/{company}?mode=json
Response: [{ id, text, categories, description, hostedUrl, ... }]
```
Maps `hostedUrl` → `link`, categories → `categories`.

### Ashby (`ashby.js`)
```
POST https://api.ashbyhq.com/posting-api/job-board/{company}
Response: { jobPostings: [{ id, title, departmentName, employmentType, ... }] }
```

### Workable (`workable.js`)
```
GET https://apply.workable.com/api/v3/accounts/{company}/jobs
Response: { results: [{ shortcode, title, department, location, ... }] }
```

---

## 3.6 Job Normalization

**Module:** `src/core/schema.js`

Every connector produces a raw job object. The schema module normalizes it into a standard `RawJob`:

```typescript
interface RawJob {
  id: string;           // Unique ID: simhash(url+title)
  title: string;        // Job title
  company: string;      // Company name (normalized)
  url: string;          // Canonical job URL
  link: string;         // Original apply link
  contentSnippet: string; // Description text (truncated)
  categories: string[]; // Tech tags/categories
  matchedTerms: string[]; // Pre-matched keywords
  sourceUrl: string;    // Source feed URL
  publishedAt: string;  // ISO date string
  identity_hash: string; // FNV-1a(company+title+location)
  content_hash: string;  // FNV-1a(company+title+content[:500])
  similarity_hash: string; // FNV-1a(company+normalized_title)
}
```

### Normalization Steps:
1. `normalizeTitle()` — strip " (Remote)" suffix, capitalize properly
2. `normalizeCompany()` — strip "Inc.", "LLC", "Ltd" etc.
3. Hash generation — `identity_hash`, `content_hash`, `similarity_hash`
4. Date parsing — unify pubDate, isoDate, created_at to ISO format
5. Keyword pre-matching — scan title + description against `config.searchRules`

---

## 3.7 `buildSourceList()` — Combining Config + Registry Sources

**Module:** `src/connectors/base.js`

```js
export function buildSourceList(config) {
  const rssSources  = config.feeds.map(url => ({ url, type: "rss" }));
  const atsSources  = config.sources || [];
  return [...rssSources, ...atsSources];
}
```

The `_scheduledImpl()` then merges these with D1 `source_registry` sources:
- Config sources = baseline (always included)
- Registry sources = dynamically discovered (can be added/disabled)

---

## 3.8 Feed Stats Collection

After all connectors run, `feedStats` is an array with one entry per source:

```js
{
  url: "https://weworkremotely.com/remote-jobs.rss",
  name: "We Work Remotely",
  type: "rss",
  count: 42,          // Total items fetched
  cursorSkipped: 31,  // Items older than cursor (skipped)
  error: null,        // Error message if fetch failed
  durationMs: 842     // HTTP fetch time
}
```

These stats feed into:
- `recordFeedResult()` → KV circuit breaker
- `batchUpdateSourceStats()` → D1 `source_registry`
- `recordSourceYieldsBatch()` → D1 source intelligence

---

## 3.9 Result Flow After Fetching

```
runAllConnectors() returns:
  jobs: RawJob[]       → goes to in-memory dedup → D1 batch insert → JOB_QUEUE
  feedStats: Stat[]    → circuit breaker KV writes + D1 source stats
  totalItems: number   → logged
  totalErrors: number  → logged
```

---

## 3.10 Fetch Configuration

| Config Key | Default | Purpose |
|---|---|---|
| `maxConcurrentFeeds` | 7 | Max parallel HTTP fetches |
| `maxRetries` | 3 | Retry failed fetches |
| `timeWindowHours` | 24 | Only include jobs from last N hours |
| `pollIntervalMs` | 900000 | 15 minutes between polls |

---

## Flow Diagram

```
FEED_QUEUE message arrives (source object)
    │
    ├── Circuit breaker check (KV)
    │       If OPEN → skip, ack message
    │       If closed → attach ETag/lastModified headers
    │
    ├── Route to connector (type: rss/greenhouse/lever/ashby/workable)
    │       → HTTP fetch with timeout
    │       → Parse response (XML/JSON)
    │       → Normalize to RawJob schema
    │       → Apply pubDate cursor (skip old items)
    │
    ├── Record feed result (success/failure, latency)
    │       → Update KV circuit breaker health record
    │       → Batch update D1 source_registry stats
    │
    └── Return normalized jobs list
```

**Inputs:** `feed-queue` messages (source definitions)  
**Outputs:** Normalized `RawJob[]`, dispatched to `job-queue`  
**Workers:** `processFeeds()` in `worker.js`  
**Queues:** Consumes `FEED_QUEUE`, produces `JOB_QUEUE`  
**Storage:** KV (circuit breaker records), D1 (source_registry stats)
