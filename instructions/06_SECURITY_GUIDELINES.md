# 06 — Security Audit Guidelines

## Context: What Needs Protecting

This bot runs on Cloudflare's free tier. Attack surface is small but real:
- **Control endpoints** in `worker.js`: `/trigger`, `/report`, `/metrics`, `/health`
- **External ATS API keys** (Ashby, Greenhouse, Lever): currently failing with 401s — likely misconfigured
- **Webhook URLs** (Discord/Telegram): if leaked, attackers can spam notifications

---

## Known Security Issues (From Production Analysis)

| Issue | Severity | Location | Status |
|-------|----------|----------|--------|
| Control endpoints may lack auth | 🔴 High | `src/worker.js` route handlers | Check — `/trigger` running full crawl without auth is critical |
| Ashby API key invalid/leaked | 🔴 High | `src/connectors/ashby.js` + wrangler secrets | 162 production 401s — key needs rotation |
| KV errors silently swallowed | 🟠 Medium | `src/intelligence/feedHealth.js`, `src/storage/` | Empty `catch {}` blocks hide auth/permission errors |
| URL patterns in discovery unvalidated | 🟡 Medium | `src/discovery/sourceDiscovery.js` | Risk of SSRF if attacker influences source registry |

---

## What to Check

### Endpoint Auth
For each HTTP route in `worker.js`:
```
GET /health    — OK to be public
GET /metrics   — should require auth token
GET /report    — should require auth token
POST /trigger  — MUST require auth (runs full crawl = high cost)
```

What to look for:
- Is there a `CF-Worker-Token` or `X-Auth-Token` check?
- Is the token compared using constant-time comparison or simple `===`?
- If unauthenticated, add: `if (req.headers.get('X-Auth') !== env.ADMIN_TOKEN) return new Response('Forbidden', {status:403})`

### Secret Management
- Secrets must be in `wrangler.jsonc` bindings or `wrangler secret put` — not in `.env` committed to git
- Check `.env` vs `.env.example` — `.env` should never be committed  
- Check `config.json` — must contain no real API keys or tokens

### Input Validation
- All query params in handlers: Validate type and length before use
- External data from RSS/ATS: Sanitize before storing to D1 (check `core/schema.js`)
- Source URLs in `discovery/`: Always wrap in `try { new URL(url) } catch` before use

### Logging Safety
- `logger.js` must never log: Discord webhook URLs, Telegram bot tokens, API keys, full job descriptions
- Correlation IDs (sourceId, jobId) are fine to log

---

## Mitigations to Apply

| What | How |
|------|-----|
| Protect `/trigger` | Add `env.ADMIN_TOKEN` secret via `wrangler secret put ADMIN_TOKEN` + check in handler |
| Rotate Ashby key | `wrangler secret put ASHBY_API_KEY` with fresh key from ATS dashboard |
| Fix silent catch | `catch(err) { logger.error('KV operation failed', { err: err.message, context }) }` |
| Validate source URLs | `try { new URL(src) } catch { logger.warn('Invalid URL skipped', {src}); continue }` |
