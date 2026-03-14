# Step 2 — Discovery Engine

## Overview

The Discovery Engine is the **self-expanding growth layer** of the system. Its job is to continuously find new job sources so the bot can crawl companies it didn't start with.

```
Cron Trigger → _scheduledImpl()
    ├── Every 8 cycles  → runSearchExpansion()  (web search for new ATS boards)
    ├── Every 4 cycles  → probeDomainsForCareers() (check company careers pages)
    └── Passive         → detectAtsSourcesWithDomains() (from crawled job links)
```

---

## 2.1 Why Discovery Exists

The bot starts with ~30 RSS feeds hardcoded in `config.json`. But many top companies (Vercel, Stripe, Discord, etc.) don't publish RSS — they post jobs to private ATS dashboards:
- **Greenhouse** (`boards-api.greenhouse.io`)
- **Lever** (`api.lever.co`)
- **Ashby** (`api.ashbyhq.com`)
- **Workable** (`apply.workable.com`)

The discovery engine finds these company-specific boards **automatically** without requiring manual configuration updates.

---

## 2.2 Layer 1 — Passive ATS Detection (Every Crawl)

**Module:** `src/discovery/sourceDiscovery.js`  
**Triggered by:** After each `processFeeds()` completes  

When a feed is fetched, every job link, `company_url`, `apply_url`, and `ats_source_url` is scanned for known ATS URL patterns:

```js
const urlsForAtsDetection = [];
for (const job of newJobs) {
  if (job.link)           urlsForAtsDetection.push(job.link);
  if (job.company_url)    urlsForAtsDetection.push(job.company_url);
  if (job.apply_url)      urlsForAtsDetection.push(job.apply_url);
  if (job.ats_source_url) urlsForAtsDetection.push(job.ats_source_url);
}
const knownUrls = new Set(allSources.map(s => s.url));
const { sources: newSources, domains } = detectAtsSourcesWithDomains(urlsForAtsDetection, knownUrls);
```

**Pattern matching:** The URL is matched against known ATS board patterns:
- `boards-api.greenhouse.io/v1/boards/{company}/jobs`
- `api.lever.co/v0/postings/{company}`
- `api.ashbyhq.com/posting-api/job-board/{company}`
- `apply.workable.com/api/v3/accounts/{company}/jobs`

Any new match is immediately registered in D1's `source_registry` table via `batchRegisterDiscoveredSources()`.

---

## 2.3 Layer 2 — Career Detector (Every 4 Cycles)

**Module:** `src/discovery/careerDetector.js`  
**Triggered by:** `cycleNumber % 4 === 0` in `_scheduledImpl()`  

Company domains discovered passively are queued in the D1 `career_probe_queue` table. The career detector fetches these domains and looks for:
- `/careers` or `/jobs` pages
- Meta tags or links pointing to known ATS boards
- Embedded Greenhouse/Lever/Ashby widgets

```js
const domains = await getPendingDomains(env.DB, 15);
const registered = await probeDomainsForCareers(env.DB, domains, 15);
```

**Flow:**
```
Job link (e.g. stripe.com/jobs/123)
    → Extract domain: stripe.com
    → Queue domain for career probing
    → Probe stripe.com/careers
    → Detect: boards.greenhouse.io/stripe
    → Register as new source in D1
```

---

## 2.4 Layer 3 — Search Expansion (Every 8 Cycles)

**Module:** `src/discovery/searchExpander.js`  
**Triggered by:** `cycleNumber % 8 === 0` or if no new sources in 72 hours  

This is the most powerful layer. It runs active web searches to find new companies hiring in the target tech stack:

### Search Backends (tried in order):
1. **Bing HTML scraping** — more lenient, primary backend
2. **Brave search scraping** — secondary fallback
3. **Static fallback list** — always runs regardless of search backend health

### 72-Hour Force-Run Guard:
```js
const msSinceSuccess = Date.now() - new Date(lastSuccessRaw).getTime();
if (msSinceSuccess > 72 * 60 * 60 * 1000) {
  forceDiscovery = true; // Run even if not on cycle
}
```

### Dynamic Query Building:
Queries are seeded from:
1. Static `config.searchExpansion.queries` list
2. **Live market spikes** from `runGrowthEngineCycle()` — top trending skills
3. **Hiring surges** — companies with rapidly growing job counts

```js
for (const spike of skillSpikes.slice(0, 2)) {
  dynamicQueries.push(`${spike.skill} remote developer "careers"`);
}
for (const surge of hiringSurges.slice(0, 2)) {
  dynamicQueries.push(`"${surge.company}" careers "open positions"`);
}
```

### CAPTCHA / Rate-Limit Detection:
```js
if (html.length < 500 ||
    html.toLowerCase().includes("captcha") ||
    html.toLowerCase().includes("unusual traffic") ||
    html.toLowerCase().includes("rate limit")) {
  // Skip this backend, try next
}
```

---

## 2.5 Static Fallback Sources

Even if all search backends fail, the system immediately registers a **hardcoded list** of known high-value companies:

| Company | ATS Type |
|---|---|
| Vercel, Stripe, Discord, Figma, HashiCorp, Netlify | Greenhouse |
| Linear, Notion, Airtable, Remote, Descript | Lever |
| Retool, Supabase, Cal.com, Clerk, Dub.co | Ashby |
| Browserbase | Workable |

---

## 2.6 Domain Filtering

When extracting domains from search results, the following are **skipped** (too generic to be company job boards):

```
linkedin.com, indeed.com, glassdoor.com, monster.com
github.com, stackoverflow.com, reddit.com
boards.greenhouse.io (already handled by ATS detection)
```

---

## 2.7 Discovery Stats — KV Tracking

After each search expansion run, stats are written to KV:
- `discovery:last_run_stats` — JSON with attempted/discovered/failed counts
- `discovery:last_success_timestamp` — ISO timestamp of last successful discovery

These are read by the **Daily Intelligence Report** to show discovery health.

---

## 2.8 Priority System

Every source discovered is given an initial `priority_score`. This score determines how often the source gets crawled:

| Tier | Priority Score | Crawl Frequency |
|---|---|---|
| High | 70–100 | Every cycle |
| Medium | 40–70 | Every 2–4 cycles |
| Low | 10–40 | Every 8–12 cycles |
| Dormant | 0–10 | Very infrequently |

Config sources get a **+10 priority bonus** when merged with registry sources.

---

## Flow Diagram

```
New job crawled (RSS / ATS)
    │
    ├── Passive ATS Detection
    │       → Scan job.link, job.company_url
    │       → Match against ATS URL patterns
    │       → Register new source in source_registry (D1)
    │
    ├── Domain Extraction
    │       → Extract domain (e.g. stripe.com)
    │       → Add to career_probe_queue (D1)
    │
Every 4 cycles:
    ├── Career Probe
    │       → Fetch company.com/careers
    │       → Detect Greenhouse/Lever/Ashby embeds
    │       → Register career page as new source
    │
Every 8 cycles (or 72h dry spell):
    └── Search Expansion
            → Build dynamic search queries
            → Scrape Bing → Brave
            → ATS pattern detection on results
            → Register new sources
            → Queue new domains for career probing
```

**Inputs:** Job links from crawled sources  
**Outputs:** New entries in `source_registry` D1 table  
**Storage written:** D1 (`source_registry`, `career_probe_queue`), KV (discovery stats)
