# 🧪 Testing Strategy — Self-Expanding Job Discovery Engine

## 🎯 Purpose

This document defines the complete testing strategy for the self-expanding job discovery engine.

It covers:

- End-to-end user flow validation
- Source ingestion validation
- Discovery engine testing
- Scoring engine validation
- Scheduler behavior
- Deduplication logic
- Google-based discovery validation
- Edge cases
- Cloudflare Free Tier safety validation

This ensures the system works reliably, scales safely, and avoids silent failures.

---

# 🧱 1️⃣ Core System Testing

## 1.1 RSS Ingestion Tests

### ✅ Expected Behavior
- RSS feed loads successfully.
- Items are parsed correctly.
- Duplicate jobs are ignored.
- Only jobs within 24-hour window are processed.

### 🔍 Edge Cases
- Empty RSS feed.
- Invalid XML format.
- RSS returns HTTP 301/302 redirect.
- RSS returns 403 or 429.
- RSS returns extremely large payload.
- RSS returns outdated jobs only.
- RSS missing title or link field.
- RSS with duplicate items inside same feed.

---

## 1.2 Manual ATS Board Tests

### ✅ Expected Behavior
- ATS API returns structured JSON.
- Jobs are normalized correctly.
- Platform-specific parsing works.

### 🔍 Edge Cases

#### Greenhouse
- Board ID invalid.
- Board exists but has zero jobs.
- Board temporarily unavailable.
- Rate limit triggered.

#### Lever
- Jobs include archived postings.
- Location field missing.
- Remote incorrectly tagged.

#### Workable
- Salary field null.
- Job description contains HTML-only content.

---

# 🔍 2️⃣ Auto ATS Discovery Testing

## 2.1 Pattern Detection Tests

### ✅ Expected Behavior
- Detects:
  - boards.greenhouse.io/*
  - jobs.lever.co/*
  - workable.com/*
  - ashbyhq.com/*

- Extracts board identifier correctly.
- Stores new source in registry.
- Does not duplicate existing source.

### 🔍 Edge Cases
- False positive URL containing "greenhouse" but not ATS.
- Subdomain variations.
- URL parameters present.
- Mixed-case URLs.
- Trailing slash variations.
- Board previously marked as dead.

---

## 2.2 Invalid Source Handling

- Discovered board returns 404.
- Discovered board returns empty jobs.
- Discovered board requires authentication.
- Board blocks Cloudflare IP.

Expected:
- Mark as failed.
- Reduce priority score.
- Eventually pause source.

---

# 🌐 3️⃣ Career Page Detection Testing

## 3.1 Path Testing

Test detection on:
- /careers
- /jobs
- /work-with-us
- /about/careers

### ✅ Expected Behavior
- Detect JSON-LD jobPosting schema.
- Extract structured data correctly.
- Add valid source to registry.

### 🔍 Edge Cases
- Careers page exists but contains no jobs.
- Jobs loaded via heavy client-side JavaScript.
- CAPTCHA present.
- Infinite scroll job listing.
- Multi-page pagination.
- Salary embedded inside text.
- Jobs older than 30 days.

Expected:
- Skip non-structured pages.
- Avoid excessive crawling.
- Mark unsupported pages as low priority.

---

# 🔎 4️⃣ Google Search-Based Expansion Testing

## 4.1 Query Execution

### ✅ Expected Behavior
- Query rotates keywords.
- Extracts company domains.
- Filters out aggregator duplicates.
- Adds valid ATS/career pages only.

### 🔍 Edge Cases
- Search results dominated by job aggregators.
- Duplicate domains across queries.
- Rate limit triggered.
- Search results contain spam domains.
- Search results contain expired job posts.
- Domain already exists in source registry.

Expected:
- Deduplicate domains.
- Validate before storing.
- Limit new domains per cycle.

---

# 🧮 5️⃣ Scoring Engine Testing

## 5.1 Priority Score Validation

### Test Variables
- Recent job count
- Update frequency
- Crawl success rate
- Failure count
- No-new-job cycles

### ✅ Expected Behavior
- High activity → score increases.
- Repeated failure → score decreases.
- Dead source → eventually paused.

### 🔍 Edge Cases
- Source returns same jobs repeatedly.
- Source temporarily fails then recovers.
- High job volume but irrelevant to niche.
- Source posts 1 job per month consistently.

---

## 5.2 Threshold Testing

Test notification threshold:

- Job score = 49 → not sent
- Job score = 50 → sent
- High TF-IDF but missing mustMatch keyword
- Strong title match but low skills match

---

# 🧹 6️⃣ Deduplication Testing

## 6.1 Hash Logic

Test:
- Same job appears in RSS + ATS
- Same job reposted with minor description change
- Same job different URL
- Same job different salary format

Expected:
- Only one entry stored.
- No duplicate notifications.

---

# ⏱ 7️⃣ Scheduler & 15-Minute Cycle Testing

## 7.1 Priority-Based Crawl

### ✅ Expected Behavior
- Only top N priority sources crawled.
- Low priority sources skipped.
- Discovery runs every X cycles.

### 🔍 Edge Cases
- All high-priority sources fail.
- Discovery cycle adds too many new sources.
- Cron overlaps previous execution.
- Long-running fetch exceeds Worker limits.

Expected:
- Graceful degradation.
- No infinite loops.
- No resource exhaustion.

---

# ☁ 8️⃣ Cloudflare Free Tier Safety Testing

## 8.1 Resource Validation

Test:
- CPU time limits
- Memory limits
- Request concurrency
- Max retries behavior

### 🔍 Edge Cases
- Too many simultaneous fetches.
- Timeout during parsing.
- Excessive discovery expansion.
- D1 write failures.
- KV write quota exceeded.

Expected:
- System throttles automatically.
- Sources queued for next cycle.
- No crash of Worker.

---

# 🔄 9️⃣ Time Window Filtering (24h Logic)

Test:
- Job posted 23h ago → included.
- Job posted 25h ago → excluded.
- No timestamp available.
- Different timezone formats.
- Human-readable timestamps.

Expected:
- Correct UTC normalization.
- Accurate filtering.

---

# 🧠 10️⃣ Niche Filtering Validation

## MustMatch Testing
- Job contains all required keywords → pass.
- Job contains none → reject.
- Synonym only → pass.

## Exclude Testing
- Contains excluded keyword → reject.
- Mixed tech stack → apply penalty.

---

# 🚨 11️⃣ Failure Recovery Testing

Test:
- Source fails 3 times → score reduced.
- Source fails 10 times → paused.
- Paused source manually re-enabled.
- Source recovers after temporary outage.

Expected:
- System self-heals.
- No permanent lock unless manually disabled.

---

# 📊 12️⃣ Coverage Validation Testing

Measure:

- Number of active sources.
- Number of new sources discovered per week.
- Ratio of discovery vs manual sources.
- Unique companies indexed.
- Duplicate rate.
- % of jobs within niche vs total.

---

# 🏁 Final Validation Checklist

Before production confidence:

- No duplicate notifications.
- No runaway discovery loops.
- No infinite retry cycles.
- Crawl limits respected.
- Scores adjust dynamically.
- Dead sources disabled automatically.
- Discovery expansion controlled.
- 24-hour window accurate.
- Cloudflare limits never exceeded.

---

# 🎯 Success Criteria

The system is considered stable when:

- It grows sources gradually.
- It removes low-value sources automatically.
- It stays within resource limits.
- It maintains 60–70% niche coverage.
- It runs continuously without manual intervention.

---

# 📌 Conclusion

This testing framework ensures:

- Reliability
- Scalability
- Safety
- Intelligent growth
- Resource optimization

The system must be adaptive, self-correcting, and stable under all edge cases.

Only then does it qualify as a true self-expanding job intelligence engine.