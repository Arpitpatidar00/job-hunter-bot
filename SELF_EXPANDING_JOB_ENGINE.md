# 🌍 Self-Expanding Job Discovery Engine

## 🎯 Core Vision

This project is not a traditional job bot.

It is a **self-expanding job discovery engine** designed to gradually increase internet coverage in a controlled, optimized, and scalable way.

Instead of attempting to scrape the entire internet every 15 minutes, the system follows a strategic growth model:

1. Start small.
2. Discover new sources automatically.
3. Score each source based on value.
4. Crawl only high-value sources frequently.
5. Drop or pause low-value sources.
6. Repeat continuously.

Over time, the system becomes smarter, wider, and more efficient.

---

# 🧠 5-Layer Growth Model

## 1️⃣ RSS Bootstrap (~5% Coverage)

The system begins with curated job RSS feeds.

### Purpose
- Immediate job data
- Baseline coverage
- Low implementation complexity

### Limitation
RSS feeds alone provide very limited internet coverage.

This layer is only the starting point.

---

## 2️⃣ Manual ATS Boards (~10% Coverage)

Many companies use Applicant Tracking Systems (ATS) such as:

- Greenhouse
- Lever
- Workable

These platforms expose structured job APIs.

### Strategy
- Manually add known ATS boards.
- Store platform + board identifier.
- Fetch structured job data directly from the ATS API.

### Benefit
- Instant coverage increase.
- Stable and predictable structure.
- Minimal parsing complexity.

---

## 3️⃣ Auto ATS Discovery (~40% Coverage)

The system becomes intelligent at this stage.

### Trigger Points
When crawling:
- Job links
- Company links
- Career pages

The system checks for recognizable ATS URL patterns.

### If an ATS pattern is detected:
- Extract board identifier.
- Store it as a new source.
- Schedule it for future crawling.

### Result
The system grows automatically without manual updates.

---

## 4️⃣ Career Page Detection (~60% Coverage)

Not all companies use ATS platforms.

Many companies host job listings on:

- `/careers`
- `/jobs`
- `/work-with-us`

### Detection Process
When a new company domain is discovered:
1. Test common career paths.
2. Check for:
   - Structured job schema (JSON-LD JobPosting)
   - Embedded job listings
   - Valid job data

If valid:
- Add domain as a new source.
- Assign appropriate crawl priority.

### Result
The system begins indexing companies directly.

---

## 5️⃣ Search-Based Expansion (~70% Niche Coverage)

This is the outer growth layer.

Periodically, the system performs niche-specific search queries such as:

- "remote next.js jobs"
- "node.js backend engineer remote"
- "typescript developer worldwide"

### From Search Results:
1. Extract company domains.
2. Check for ATS patterns.
3. Test career pages.
4. Validate job listings.
5. Add valid sources to the registry.

### Result
The system dynamically discovers new employers and expands continuously.

---

# 🧮 Intelligence Layer (Priority-Based Crawling)

Not all sources are equal.

Each source is scored based on:

- Posting frequency
- Recent job count
- Crawl success rate
- Update consistency
- Failure frequency

### Behavior

- High-value sources → crawled frequently.
- Medium-value sources → crawled periodically.
- Low-value sources → crawled rarely.
- Repeated failures → paused or disabled.

### Goal

- Optimize Cloudflare resource usage.
- Stay within free-tier limits.
- Maximize relevant job coverage.
- Avoid unnecessary network requests.

---

# 🔁 Growth Over Time

The system expands gradually:

### Month 1
50–100 sources.

### Month 2
200–300 sources.

### Month 3+
500+ sources.

Important:

The system does **not** crawl all sources every 15 minutes.

It only crawls the highest-priority sources frequently.

Lower-priority sources are scheduled adaptively.

---

# ☁ Why This Works on Cloudflare Free Tier

The architecture is designed to remain efficient and optimized:

- No brute-force crawling.
- No full internet scraping.
- No repeated fetching of unchanged data.
- Dead sources are disabled.
- Discovery is rate-limited.
- Crawling is priority-based.

The system is adaptive, not aggressive.

---

# 🏁 Final Summary

This project builds:

> A self-growing, priority-based job intelligence engine  
> That expands internet coverage automatically  
> While remaining optimized for free-tier infrastructure  

It is not "whole internet scraping."

But within a defined niche, it can achieve high coverage and continuously improve over time.

---

## 📌 Long-Term Vision

Over time, this engine evolves into:

- A niche job intelligence system.
- A continuously expanding employer index.
- A scalable data pipeline optimized for performance and cost efficiency.

The system becomes smarter with every cycle.