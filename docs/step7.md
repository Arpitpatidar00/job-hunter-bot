# Step 7 — Scoring & Filtering

## Overview

Every job that passes through the evaluator is assigned a **0–100 relevance score** using a 13-layer signal stack. The scoring engine is the core intelligence of the system — it determines which jobs match the user's profile and whether they're worth alerting on.

```
Job (from job-queue)
    │
    ├── Pre-filter: hasBasicKeywordMatch()     (keyword gate)
    ├── Pre-score:  computeQuickKeywordScore() (AI skip decision)
    │
    └── scoreJob() — 13-layer algorithm
          1. Exclusion guard
          2. Title match (30 pts)
          3. Skills match (30 pts)
          4. Tech stack / nice-to-have (20 pts)
          5. Location / remote match (10 pts)
          6. Salary signal (10 pts)
          7. TF-IDF enhancement (+15% blend)
          8. Experience years (±4–6 pts)
          9. Combo bonuses (MERN, Next.js+TS, AWS, Remote India)
         10. Seniority alignment (±5–8 pts)
         11. Penalty layer (non-JS stack, frontend-only)
         12. Hard mustMatch gate
         13. AI/RAG semantic bonus (≤25 pts)
```

---

## 7.1 Pre-Filter: `hasBasicKeywordMatch()`

Before any expensive scoring, jobs pass a fast keyword gate:

```js
function hasBasicKeywordMatch(job, config) {
  // Allow if: 1 title keyword match OR 2+ mustMatch hits OR 3+ total hits
  if (titleMatchCount >= 1) return true;
  if (mustMatchHits >= 2)   return true;
  if (mustMatchHits + niceToHaveHits >= 3) return true;
  return false;
}
```

**Why:** Avoids burning CPU/AI budget on clearly irrelevant jobs (e.g., WordPress PHP jobs appearing in an RSS feed).

---

## 7.2 Pre-Score: AI Skip Decision

```js
const quickKeywordScore = computeQuickKeywordScore(job, config);
const SKIP_AI_THRESHOLD = 75;

if (quickKeywordScore < SKIP_AI_THRESHOLD) {
  // Run full AI embedding pipeline
  chunks   = chunkTexts(jobText, 200, 40).slice(0, 5);
  chunkVecs = await embedChunks(env.AI, kv, job.id, chunks);
}
```

A job scoring >75 on keywords is **already a strong match** — AI would add minimal extra signal. This optimization saves ~60-70% of AI API calls.

---

## 7.3 FastMatcher — O(N) Scan

**Module:** `src/scoring/fastMatcher.js`

Instead of running N regex tests × K keywords per job, the FastMatcher builds an **Aho-Corasick Trie** at initialization time:

```js
const matcher = getGlobalMatcher(config); // Built once, cached globally
const textScanResult  = matcher.scan(text);     // O(N) — single pass
const titleScanResult = matcher.scan(titleText); // O(N) — single pass
```

The trie contains all keywords from:
- `mustMatch` (5 terms)
- `shouldMatch` (10 terms)
- `niceToHave` (10 terms)
- `exclude` (12 terms)
- `targetRoles` (26 roles)
- `locationKeywords` (6 terms)
- `nonJsStack`, `frontend`, `backend` categories

**Result:** Each job text requires exactly **1 O(N) scan** rather than O(N×K) independent regex tests.

---

## 7.4 Scoring Weights (from `config.json`)

| Signal | Weight |
|---|---|
| Title match | 30 pts |
| Skills match (must + should) | 30 pts |
| Tech stack (nice-to-have) | 20 pts |
| Location / remote | 10 pts |
| Salary signal | 10 pts |
| **Total base** | **100 pts** |

---

## 7.5 Layer-by-Layer Breakdown

### Layer 1: Exclusion Guard
If any `exclude` keyword is found in title or body → immediately return `excluded=true`, score=0.

Exclude terms: `wordpress`, `php`, `laravel`, `flutter`, `kotlin developer`, `spring boot`, `ruby on rails`, etc.

### Layer 2: Title Match (max 30 pts)
Graduated scoring — more keyword hits = higher title score:
- 1 hit = 60% of weight (18 pts)
- 2 hits = 80% of weight (24 pts)
- 3+ hits = 100% of weight (30 pts)

Target roles include: "Full Stack Developer", "MERN Stack Engineer", "React Developer", "Node.js Engineer", etc.

### Layer 3: Skills Match (max 30 pts)
Uses weighted ratio:
```js
const mustRatio  = mustHits / mustTotal;
const shouldRatio = shouldHits / shouldTotal;
const skillRatio = mustRatio * 0.7 + shouldRatio * 0.3;
const skillsScore = Math.round(skillRatio * w.skillsMatch); // max 30
```

`mustMatch` terms: JavaScript, TypeScript, React, Next.js, Node.js  
`shouldMatch` terms: MongoDB, PostgreSQL, GraphQL, Express, AWS, Docker, Tailwind, etc.

### Layer 4: Tech Stack (max 20 pts)
`niceToHave` terms: Redis, CI/CD, Microservices, Kubernetes, GitHub Actions, Jest, Cypress, etc.

### Layer 5: Location Match (max 10 pts)
Word-boundary regex matching for: `remote`, `wfh`, `distributed`, `anywhere`, `india`, `europe`, `worldwide`.

### Layer 6: Salary Signal (max 10 pts)
Valid if `extractSalaryUSD()` returns a salary ≥ $10,000 USD annual. Filters out bounties, equity-only roles, hourly micro-amounts.

### Layer 7: TF-IDF Enhancement (+15% blend)
Increases score for jobs that have a **high density** of rare mustMatch keywords:

```js
const tfidf = computeTfIdfScore(mustMatchList, tokens, synonyms, idfData);
const tfidfBoost = Math.round(tfidf * 0.15 * 100);
```

IDF uses BM25-style smoothing: `log((N+1)/(df+1)) + 1`

### Layer 8: Experience Years (±4–6 pts)
- Job requires ≤ user's max years → **+4 bonus**
- Job requires more than user's max + 1 year → **-6 penalty**

### Layer 9: Combo Bonuses
| Combo | Bonus |
|---|---|
| Next.js + TypeScript | +8 pts |
| Node.js + MongoDB | +6 pts |
| Full MERN (Mongo+Express+React+Node) | +10 pts |
| Partial MERN (3/4) | +5 pts |
| AWS present | +4 pts |
| Remote + target region (India) | +5 pts |

### Layer 10: Seniority Alignment
Detects seniority from full text (junior/mid/senior/lead):
- Seniority matches user preference → **+5 bonus**
- Seniority mismatches (e.g., Lead role for junior user) → **-8 penalty**

### Layer 11: Penalty Layer
- Non-JS primary language in **title** → -15 pts penalty
- Non-JS primary language in **body** (with 0 mustHits) → -15 pts
- Frontend-only title + no backend signals + 0 mustHits → -5 pts

### Layer 12: Hard mustMatch Gate
- Zero total hits (no mustMatch + should + nice) AND zero title hits → **cap score at 10%**
- Zero mustHits (but has some matches) → cap final score at 55
- Fewer than `filters.minPrimaryMatches` (=1) primary hits → soft reduce by ratio

### Layer 13: AI/RAG Semantic Bonus (max 25 pts)
Uses cosine similarity between job chunk embeddings and cached profile embedding:
```js
// Top-K chunks via Min-Heap (O(N log K))
const topKChunks = new TopKChunks(5);
for each chunk:
  sim = cosineSimilarity(profileVector, chunkVec)
  topKChunks.add({ text, sim })

const ragMatches = topKChunks.getTop();
const semanticBase = mean(ragMatches.map(m => m.sim));
const semanticBoost = Math.round(semanticBase * 0.7 * 25); // max ~17 pts
```

---

## 7.6 Minimum Alert Score

```js
export const MINIMUM_ALERT_SCORE = 55;
const effectiveThreshold = Math.max(profile.notification_threshold || globalThreshold, MINIMUM_ALERT_SCORE);
```

No job can trigger an alert if it scores below **55**, regardless of profile settings. This prevents noisy alerts for marginally relevant jobs.

---

## 7.7 Dynamic Threshold Engine

**Module:** `src/intelligence/threshold.js`

The threshold auto-adjusts based on alert volume:

```js
const TARGET_MIN_MATCHES = 1;  // At least 1 alert per run
const TARGET_MAX_MATCHES = 8;  // At most 8 alerts per run

if (matchedLastRun > TARGET_MAX_MATCHES) {
  next = Math.min(MAX_THRESHOLD, effective + ADJUST_STEP); // Raise bar
}
if (matchedLastRun < TARGET_MIN_MATCHES) {
  next = Math.max(MIN_THRESHOLD, effective - ADJUST_STEP); // Lower bar
}
```

- Stored in KV: `thresh:effective` (ranges from 30 to 70)
- Rolling window of last 200 scores: `thresh:window`

---

## 7.8 Feedback Boost System

**Module:** `src/scoring/feedback.js`

User actions (e.g., applying to a job, dismissing a job) feed back into the scoring system via preference weights stored in KV:

```js
const { adjustedScore, feedbackDelta } = applyFeedbackBoost(scoreResult, prefWeights);
```

Feedback tracks preferred: companies, tech stacks, seniority levels, remote types. Jobs matching user preferences get a small score boost.

---

## 7.9 Synonym Expansion

The config defines synonyms for all major terms:

```json
"synonyms": {
  "react":    ["reactjs", "react.js"],
  "next.js":  ["nextjs", "next js"],
  "node.js":  ["nodejs", "node js"],
  "typescript": ["ts", "typescript"],
  "javascript": ["js", "ecmascript", "es6"]
}
```

When checking keywords, ALL synonym variants are tested — ensuring "NodeJS" and "node.js" both match "node.js".

---

## Score Example

```
Job: "Senior React + Next.js Developer (Remote, India) at FinTech Startup"
Salary: $60,000 USD | Experience: 2-4 years

Layer 1 (Exclusion):    No exclusions found               → 0 pts lost
Layer 2 (Title):        "React Developer" found (1 hit)   → +18 pts
Layer 3 (Skills):       React, Next.js, TypeScript found  → +25 pts
Layer 4 (Tech):         MongoDB, Docker found             → +8 pts
Layer 5 (Location):     "Remote" + "India" found          → +10 pts
Layer 6 (Salary):       $60k USD → valid                  → +10 pts
Layer 7 (TF-IDF):       High keyword density              → +8 pts
Layer 8 (Experience):   2-4 yrs, user wants ≤3           → +4 pts
Layer 9 (Bonuses):      Next.js+TS=+8, Remote+India=+5   → +13 pts
Layer 10 (Seniority):   "Senior" → mismatch (user=mid)   → -8 pts
Layer 11 (Penalties):   None                              → 0 pts
Layer 12 (Gate):        mustHits=3 ✓                      → pass
Layer 13 (AI/RAG):      Embedding sim=0.76 → +14 pts     → +14 pts

FINAL SCORE: 102 → capped at 100 → 🟢 EXCELLENT
```

---

## Flow Diagram

```
Job from job-queue
    │
    ├── hasBasicKeywordMatch() → too weak? → skip
    ├── computeQuickKeywordScore() > 75? → skip AI
    │
    ├── embedChunks() → AI vectors for job chunks
    ├── cosineSimilarity(profileVector, chunkVecs) → RAG matches
    │
    └── scoreJob(job, config, idfData, ragMatches)
            → 13-layer signal computation
            → returns { score: 87, label: "Excellent", excluded: false }
            │
            ├── score < effectiveThreshold (55–70)? → skip
            └── score ≥ threshold → ALERT_QUEUE.send()
```

**Inputs:** Slim job from `job-queue`, global IDF data, profile embedding  
**Outputs:** Score (0–100), alert decision  
**Storage read:** KV (profile embedding cache, threshold), D1 (term frequencies)  
**AI calls:** 0 (keyword skip) or 1 (embedding) per job
