# 11 — Agent Behavior Rules

## Memory Problem & How to Solve It

AI agents lose context between sessions. These instructions exist so you can orient yourself in **under 2 minutes** without reading the entire codebase. **Follow this ritual at the start of every session:**

### Session Start Ritual (Do in This Order)

1. **Read `00_AGENT_IDENTITY.md`** — system snapshot, binding names, known production bugs
2. **Read this file (`11_BEHAVIOR_RULES.md`)** — behavioral rules and session ritual
3. **Read the file(s) you'll actually touch** — not the whole codebase
4. **Check whether the bug you're about to fix is already documented in `10_REPORTING_FORMAT.md`**

This is enough. Do **not** read all 12 instruction files before acting — that wastes context window.

---

## Core Behavior Rules

### Rule 1: Read Before Writing
Never modify a file without reading its current content first. Assumption-based edits on this codebase have introduced bugs in the past (truncated files, mismatched thresholds).

### Rule 2: Ground Everything in Specific Files
- ❌ "The scoring module needs optimization"
- ✅ "In `src/scoring/relevance.js` line 47, the threshold is hardcoded as `80` — change to `config.notificationThreshold` (currently `50` per `config.json`)"

### Rule 3: One Problem at a Time
Fix bugs in isolation. Don't refactor module A while fixing a bug in module B in the same change.

### Rule 4: Use Existing Utilities
- Logging: always use `src/core/logger.js` — never `console.log`
- Batching: use `src/core/batcher.js` helpers
- Retries: use `src/core/utils.js` retry helpers
- DB: use `src/db/` modules — never inline `env.DB.prepare()` outside of them

### Rule 5: Config Drives Runtime Behaviour
If you're changing a threshold, weight, or filtering rule:
- Change `config.json`, not source code constants
- Verify the source code actually **reads** `config.json` for that value (some currently don't — that's a known bug)

### Rule 6: Production-Safe Changes Only
- Prefer `ON CONFLICT DO NOTHING` over `DELETE + INSERT`
- Prefer additive schema changes in new migration files — never edit existing migration SQL
- Test with `npm test` before reporting a change as complete

---

## Priority Order (When Trade-offs Arise)

1. **Correctness & data integrity** — job dedup, scoring accuracy, idempotency
2. **Reliability** — circuit breakers, error handling, retry logic
3. **Security** — endpoint auth, secret management
4. **Performance & cost** — D1 batching, pLimit, CPU budget
5. **Maintainability** — naming, dead code cleanup, refactoring

---

## What This System Is NOT

- Not a general-purpose job board — it's personal, targeting one developer's MERN/Next.js job search
- Not a high-traffic SaaS — it's a free-tier Cloudflare Workers bot, cost discipline matters
- Not a research prototype — it's live in production; breaking changes cascade through queues

---

## Communication Style

- **Propose small, safe patches** — with before/after code snippets
- **State what you read** before making a recommendation
- **Acknowledge uncertainty** — if a file is truncated or unclear, say so and ask before assuming
- **Point to the config** — when you reference a threshold or weight, quote its current value from `config.json`
