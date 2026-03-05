# 09 — DevOps, Deployment & Operations

## Quick Reference

| Task | Command |
|------|---------|
| Run locally | `npm run dev` (uses `wrangler dev`) |
| Run tests | `npm test` |
| Deploy | `wrangler deploy` |
| Apply D1 migrations | `wrangler d1 migrations apply job-hunter-db` |
| Tail live logs | `wrangler tail` |
| Set a secret | `wrangler secret put SECRET_NAME` |
| Check cron schedule | `wrangler.jsonc → triggers.crons` |

---

## Wrangler.jsonc Verified Config

| Setting | Value | Notes |
|---------|-------|-------|
| Worker entry | `src/worker.js` | ✅ Correct |
| Cron | `0,15,30,45 * * * *` | Fires every 15 min |
| D1 binding | `DB` | Use `env.DB` in code |
| KV binding | `SEEN_JOBS` | Use `env.SEEN_JOBS` in code |
| Queue producers | `FEED_QUEUE`, `JOB_QUEUE`, `ALERT_QUEUE` | Queue names: `feed-queue`, `job-queue`, `alert-queue` |
| Queue consumer batch sizes | All `max_batch_size: 5` | ✅ Already correct after incident fix |
| Workers AI binding | `AI` | Use `env.AI` for embeddings |

---

## Secrets Management

All sensitive credentials must be stored via `wrangler secret`, **never** in code or `config.json`:

| Secret name | Purpose | Status |
|-------------|---------|--------|
| `DISCORD_WEBHOOK_URL` | Discord notifications | Should exist |
| `TELEGRAM_BOT_TOKEN` | Telegram notifications | Should exist |
| `TELEGRAM_CHAT_ID` | Telegram target chat | Should exist |
| `ASHBY_API_KEY` | Ashby ATS API | 🔴 Needs rotation — 162 prod 401s |
| `GREENHOUSE_API_KEY` | Greenhouse ATS | Check — 7 prod 404s |
| `ADMIN_TOKEN` | Control endpoint auth | ❌ May not exist yet — add for `/trigger` protection |

Check: do the connectors access these via `env.ASHBY_API_KEY` (correct) or inline string (wrong)?

---

## Observability

### Structured Logging
- All logs must go through `src/core/logger.js` — never `console.log` directly
- Log format should include: timestamp, level, message, context object (sourceId, jobCount, etc.)
- In `wrangler tail`, you'll see these structured logs in real-time

### Health & Metrics Endpoints

| Endpoint | Purpose | Check |
|----------|---------|-------|
| `GET /health` | System health + binding checks | Should verify `env.DB`, `env.SEEN_JOBS`, required secrets exist |
| `GET /metrics` | Operational metrics | Should return recent job counts, alert counts, queue sizes (if accessible), error rates |
| `GET /report` | Daily job report | Uses `intelligence/dailyReport.js` data |

If `/health` doesn't validate bindings, fix it — it should fail fast if a required binding is missing.

---

## Deployment Safety Checklist

Before any deploy:

- [ ] `npm test` passes (325+ tests)
- [ ] `wrangler d1 migrations apply job-hunter-db` run if new migrations added
- [ ] No secrets or API keys in committed code — run `grep -r "Bearer\|webhook\|token" src/ config.json`
- [ ] `wrangler deploy --dry-run` for syntax/binding verification
- [ ] Check that queue binding names in code match `wrangler.jsonc` (binding: `FEED_QUEUE`, queue: `feed-queue`)

---

## Common Operations

### Rotate a Secret
```bash
wrangler secret put ASHBY_API_KEY
# Then enter new key at prompt
```

### Check Production Errors
```bash
wrangler tail --format=json | grep '"level":"error"'
```

### Reset a Circuit Breaker (if source stuck OPEN)
```sql
-- Via D1 console or wrangler d1 execute:
UPDATE sources SET circuit_state='CLOSED', failure_count=0 WHERE url='https://api.ashbyhq.com/...';
```
