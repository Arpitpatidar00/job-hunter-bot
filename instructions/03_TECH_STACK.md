# 03 — Tech Stack (Confirmed)

## Runtime & Platform

| Item | Confirmed Value |
|------|----------------|
| Runtime | Cloudflare Workers (ESM, no Node.js polyfills) |
| Entry file | `src/worker.js` |
| Language | JavaScript ESM (`"type": "module"`) + `src/env.ts` (TypeScript) |
| Compatibility date | `2025-02-27` |
| CPU limit | ~10ms burst / 30s total per invocation (free tier) |
| D1 query soft limit | ~50 queries per Worker invocation |
| KV op limit | 1000 reads/day free tier; watch unbounded key growth |
| Queue batch size | `max_batch_size: 5` for all 3 queues (already set correctly) |

---

## Bindings (from `wrangler.jsonc`)

| Binding name | Type | Purpose |
|--------------|------|---------|
| `DB` | D1 | Main database (`job-hunter-db`) |
| `SEEN_JOBS` | KV | Seen-job dedup + run locks |
| `FEED_QUEUE` | Queue producer | Sends feed-fetch messages |
| `JOB_QUEUE` | Queue producer | Sends job-evaluation messages |
| `ALERT_QUEUE` | Queue producer | Sends alert messages |
| `AI` | Workers AI | Semantic embeddings for scoring |

---

## Dependencies (`package.json`)

- **Runtime deps**: None beyond Cloudflare Worker APIs (no heavy npm packages in Worker bundle)
- **Dev deps**: `jest` (testing), `wrangler` (deploy + dev), `zod` (validation — check if actually used in `env.ts`)
- **Risk**: Verify `zod` is used in `env.ts` — if not, validation is implicit

---

## Config System

All tuning lives in `config.json` (🔑 read this before touching scoring or filtering logic):

| Config key | Value | Purpose |
|-----------|-------|---------|
| `notificationThreshold` | `50` | Alert if score ≥ 50 (⚠️ code may use 80 — BUG) |
| `fuzzyThreshold` | `0.82` | Fuzz match sensitivity |
| `maxConcurrentFeeds` | `7` | Parallelism cap (connector-level) |
| `maxRetries` | `3` | Retry attempts per connector |
| `timeWindowHours` | `24` | Ignore jobs older than 24h |
| `weights` | `{titleMatch:30, skillsMatch:30, techStackMatch:20, locationMatch:10, salaryMatch:10}` | Scoring layer weights |
| `scoringBonuses` | `{fullMernStack:+10, nextjsAndTypescript:+8, nodeAndMongodb:+6, awsPresent:+4, remoteIndia:+5}` | Stack bonuses |
| `scoringPenalties` | `{nonJsStack:-15, differentPrimaryLanguage:-10, frontendOnlyNoBackend:-5}` | Penalties |
| `feeds` | 25 RSS URLs | L1 sources |
| `searchRules.mustMatch` | `[js, ts, react, next.js, node.js]` | Hard require |
| `searchRules.exclude` | `[wordpress, php, .net, java, swift...]` | Hard exclude |

---

## Testing

- **Framework**: Jest (`jest.config.js`)
- **Test directory**: `tests/` (325 tests passing as of last run)
- **Coverage gap**: No end-to-end tests for D1 or queue flows (only unit tests)
- **Run tests**: `npm test`

---

## Migrations

Located in `migrations/`:

| File | Content |
|------|---------|
| `0001_initial.sql` | Base `jobs`, `sources`, `profiles` tables |
| `0002_intelligence.sql` | Source intelligence fields |
| `0003_embeddings.sql` | Embedding storage columns |
| `0004_safety.sql` | Safety/dedup guards |
| `0005_source_registry.sql` | Source registry |
| `0006_source_intelligence.sql` | Circuit breaker + yield tracking columns |
| `0007_daily_metrics.sql` | `daily_metrics` table |
| `0008_expansion_tuning.sql` | Expansion/growth tuning fields |

Run with: `wrangler d1 migrations apply job-hunter-db`
