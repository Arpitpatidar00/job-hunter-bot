You are a **Principal Distributed Systems Architect, Web Intelligence Engineer, and Large-Scale Crawler Designer**.

Your task is to **upgrade the job discovery engine so it reaches a perfect 10/10 score in discovery coverage, scalability, and reliability.**

The system is a **global hiring intelligence crawler** designed to discover companies that are hiring anywhere on the internet.

Target scale:

• 20k–80k jobs per day
• 50–150 new sources per day
• 3000–10000 job sources

You must analyze the repository and produce a **complete architecture upgrade plan AND concrete implementation changes.**

---

# STEP 1 — Perform Full Discovery Engine Audit

Analyze the codebase:

```
src/discovery/
src/worker.js
src/intelligence/
src/connectors/
src/db/
migrations/
src/config.js
wrangler.jsonc
```

Identify:

• discovery vectors implemented
• missing vectors
• scheduler logic
• source registry design
• domain registry design
• queue topology
• throughput limits
• scalability risks

Produce an **evidence-based audit** referencing the code.

---

# STEP 2 — Score Current Discovery System

Score each subsystem:

Discovery vector coverage
Scheduler architecture
Source intelligence
Registry design
Scalability

Final score out of 10.

---

# STEP 3 — Build Target 10/10 Discovery Architecture

Design a discovery system capable of **continuous internet-wide hiring detection**.

The system must contain **all discovery vectors below**.

---

# REQUIRED DISCOVERY VECTORS

## 1. ATS Enumeration

Detect companies using ATS platforms.

Must support:

Greenhouse
Lever
Ashby
Workable
SmartRecruiters
Teamtailor
Recruitee
Workday
Breezy
Rippling
Pinpoint
Dover
Freshteam
Jobvite

For each ATS:

1. Describe URL patterns
2. Show enumeration strategy
3. Provide discovery pseudocode

---

## 2. Search Engine Discovery

Automatically find hiring companies.

Queries like:

site:boards.greenhouse.io "engineer"
site:jobs.lever.co "developer"

Must support:

Bing API
Brave API
Google Custom Search API

Return discovered domains and register sources.

---

## 3. Career Page Discovery

Detect career pages automatically.

Paths to probe:

```
/careers
/jobs
/work-with-us
/hiring
/join-us
```

Detect:

• ATS redirects
• JSON-LD JobPosting
• job APIs

---

## 4. Job Board Mining

Extract company sources from job boards:

LinkedIn
Indeed
Wellfound
AngelList

Process:

job listing → apply link → company career page → source registry.

---

## 5. Startup Dataset Discovery

Parse company datasets:

YC startups
Product Hunt startups
SaaS directories
Tech company registries

Register domains and probe for career pages.

---

## 6. Infrastructure Discovery (CRITICAL)

Discover companies via internet infrastructure signals.

Must implement:

Certificate Transparency monitoring
Newly Registered Domains
Reverse DNS scans
Cloud metadata discovery

Example tools:

certstream
crt.sh
Rapid7 scans

Extract company domains and probe for careers.

---

## 7. Big Data Web Mining

Use large datasets:

Common Crawl
SEO datasets

Extract:

```
schema.org/JobPosting
```

Register sources.

---

## 8. Ecosystem Discovery

Find companies through developer ecosystems.

Sources:

GitHub organizations
npm publishers
PyPI maintainers
DockerHub organizations
App Store publishers
Google Play developers

Extract domains and probe for careers.

---

## 9. Financial Signals Discovery

Detect companies likely to start hiring.

Sources:

funding announcements
VC portfolio companies
government procurement contracts

Register domains and scan careers.

---

## 10. API Discovery

Detect hidden job APIs automatically.

Scan for:

```
/_next/data
/graphql
/api/jobs
```

If API returns job JSON → register source.

---

# STEP 4 — Discovery Engine Architecture

Design a **separate discovery pipeline**.

Required queue topology:

```
discovery_queue
feed_queue
job_queue
alert_queue
```

Discovery workers must not block crawling.

---

# STEP 5 — Domain Registry

Design domain registry.

Table:

```
domain_registry
```

Fields:

domain
first_seen
last_checked
ats_detected
status
vector

Domains should be scanned repeatedly until career pages are found.

---

# STEP 6 — Source Registry

Upgrade source registry.

States must include:

active
cooldown
low_yield
blocked
dead

Add fields:

ats_platform
state_reason
last_success
last_failure

---

# STEP 7 — Discovery Scheduler

Discovery vectors must run at different cadences.

Example:

Career probe → every 4 cycles
ATS enumeration → every 6 cycles
Search expansion → every 4 cycles
Infrastructure discovery → continuous
Dataset ingestion → daily

Scheduler must prevent duplicate scanning.

---

# STEP 8 — Implementation Plan

Produce a **complete engineering roadmap**.

Phase 1
Critical missing vectors

Phase 2
Scalability upgrades

Phase 3
Intelligence improvements

---

# STEP 9 — Code-Level Changes

Show concrete modifications:

New discovery modules

```
src/discovery/infrastructureMonitor.js
src/discovery/ecosystemDiscovery.js
src/discovery/jobBoardMining.js
src/discovery/apiDiscovery.js
src/discovery/datasetIngestor.js
```

Worker scheduler updates

```
processDiscovery()
enqueueDiscoveryTasks()
```

Schema migrations.

Connector updates.

---

# STEP 10 — Expected Throughput

Estimate:

domains scanned/day
sources discovered/day
jobs discovered/day

Target:

50–150 sources/day
20k–80k jobs/day

---

# STEP 11 — Final Score

Recalculate discovery score after improvements.

Target score:

10 / 10
