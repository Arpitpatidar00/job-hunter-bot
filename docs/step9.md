# Step 9 — Alerting Pipeline

## Overview

When a job scores above the notification threshold, it enters the alerting pipeline. The system supports **Discord rich embeds**, **Telegram MarkdownV2 messages**, and dry-run mode. The alert-queue provides durability — notifications are retried up to 5 times over 75 minutes.

```
evaluateJobs()
    │
    ├── score ≥ effectiveThreshold (55–70)?
    │       YES → ALERT_QUEUE.send({ profileId, job, scoreResult })
    │
ALERT_QUEUE delivers:
    └── sendAlerts()
            ├── Discord embed → HTTP POST to webhook
            └── Telegram message → HTTP POST to bot API
```

---

## 9.1 Alert Trigger Conditions

A job triggers an alert only when ALL of the following are true:

1. `scoreResult.excluded === false` (not blacklisted)
2. `scoreResult.score >= effectiveThreshold` (dynamic threshold, 55–70)
3. `scoreResult.score >= MINIMUM_ALERT_SCORE` (absolute floor: 55)
4. `hasSentAlert(jobId, profileId)` returns false (not already sent)
5. `isNewJob(job, config.timeWindowHours)` returns true (within 24h)

```js
const effectiveThreshold = Math.max(threshold, MINIMUM_ALERT_SCORE);
if (scoreResult.score < effectiveThreshold) continue;
if (sentAlertsSet.has(`${job.id}:${profile.id}`)) continue;
```

---

## 9.2 Alert Deduplication

Two layers prevent duplicate alerts:

### Layer 1: In-Memory Set (Same Invocation)
```js
sentAlertsSet.add(`${job.id}:${profile.id}`); // in-memory tracking
```

If `evaluateJobs()` processes the same job twice in one invocation (e.g., same job in two queue messages), it won't alert twice.

### Layer 2: D1 `sent_alerts` Table (Persistent)
```js
const sentAlertsSet = await getSentAlertsForJobs(env.DB, jobIds);
// Pre-fetches all sent alerts in ONE D1 query for the batch
```

If the job was alerted in a previous cron cycle, it's already in `sent_alerts` — no second alert.

After alerting:
```js
newAlertsSent.push({ jobId: job.id, profileId: profile.id });
// Batch mark at end of message loop
await batchMarkAlertSent(env.DB, newAlertsSent);
```

---

## 9.3 `sendAlert()` — Notification Dispatch

**Module:** `src/notifications/notifications.js`

```js
export async function sendAlert(job, scoreResult, options = {}) {
  const { dryRun = false, env = {} } = options;
  const stats = { sent: 0, failed: 0, channels: [] };

  // ── Discord ──
  if (hasDiscord) {
    const embed = buildDiscordEmbed(job, scoreResult);
    const res = await fetchWithRetry(discordUrl, { method: 'POST', body: JSON.stringify({ embeds: [embed] }) });
    if (res.ok) stats.sent++;
  }

  // ── Telegram ──
  if (hasTelegram) {
    const text = buildTelegramMessage(job, scoreResult);
    const res = await fetch(telegramUrl, { method: 'POST', body: JSON.stringify({ chat_id, text, parse_mode: 'MarkdownV2' }) });
    if (res.ok) stats.sent++;
  }

  // If ALL channels failed → throw (triggers queue retry)
  if (errors.length > 0 && stats.sent === 0) throw errors[0];
  return stats;
}
```

---

## 9.4 Discord Rich Embed

The Discord alert is a **rich embed** with full job context:

```
🟢 EXCELLENT (87%) — Senior React Developer
────────────────────────────────────────────
🎯 Match: 87% — Excellent       🏢 Company: FinTech Corp
💰 Salary: $60,000–$80,000 USD  📍 Location: 🌍 Remote
📊 Level: 🟢 Junior             ⏳ Experience: 1–3 yrs
📅 Posted: 2 hours ago

🛠 Matched Skills
`react`  `typescript`  `next.js`  `node.js`  `mongodb`

💡 Why This Matches
✔ Title match (2): "React Developer", "Senior Engineer"
✔ Must-match (4/5): react, typescript, next.js, node.js
✔ Bonus: Next.js + TypeScript combo (+8)
✔ Bonus: Remote + target region (+5)

📐 Score Breakdown
Title: 24 · Skills: 25 · Tech: 12 · Location: 10 · Salary: 10
TF-IDF: +8 · Bonuses: +13

🏷 Tags  `react`  `typescript`  `remote`  `fintech`

[Job Hunter Bot v5.1 | Retry 1]
```

---

## 9.5 Telegram Message (MarkdownV2)

```
🟢 *EXCELLENT \(87%\)*

*Role:* Senior React Developer
*Company:* FinTech Corp
*Salary:* $60,000–$80,000 USD
*Location:* 🌍 Remote
*Level:* 🟢 Junior
*Experience:* 1–3 yrs
*Posted:* 2 hours ago

*Matched Skills:*
\- `react`
\- `typescript`
\- `next\.js`

*Why This Matches:*
✔ Title match \(2\): "React Developer", "Senior Engineer"
✔ Must\-match \(4/5\): react, typescript, next\.js, node\.js

*Apply Here:*
[View Job](https://lever.co/acme/jobs/123)
```

---

## 9.6 Discord 429 Rate-Limit Handling

```js
async function fetchWithRetry(url, options, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, options);
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '2', 10);
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
    }
    return res;
  }
}
```

Respects Discord's `Retry-After` header on rate-limit responses.

---

## 9.7 Alert Queue Retry Strategy

If `sendAlert()` throws (all channels failed):

```js
msg.retry({ delaySeconds: 60 * 15 }); // Retry after 15 minutes
```

With `max_retries: 5` and 15-minute delays:

| Attempt | Delay After | Total Time |
|---|---|---|
| 1 | +15 min | T+15m |
| 2 | +15 min | T+30m |
| 3 | +15 min | T+45m |
| 4 | +15 min | T+60m |
| 5 | +15 min | T+75m |
| Dead-lettered | — | T+75m |

The system can survive **75 minutes of Discord/Telegram outage** and still deliver alerts.

---

## 9.8 Multi-Profile Support

Each `profile` record in D1 has:
- `id` — unique profile identifier
- `notification_threshold` — per-profile score threshold override
- `enabled` — whether this profile receives alerts

```js
const profiles = await getActiveProfiles(env.DB);
for (const profile of activeProfiles) {
  const threshold = profile.notification_threshold || globalThreshold;
  const effectiveThreshold = Math.max(threshold, MINIMUM_ALERT_SCORE);
  if (scoreResult.score < effectiveThreshold) continue;
  // Alert this profile
}
```

---

## 9.9 Daily Intelligence Report Alerts

Every day at **midnight UTC**, a special alert is sent:

```js
if (hourUTC === 0 && minuteUTC < 15) {
  const result = await sendDailyReport(env.DB, env, {
    reportDate: yesterday,
  });
}
```

The daily report includes:
- Crawl stats (sources, raw jobs, unique stored, dupes)
- Score distribution histogram
- Alert quality (sent, avg score, quality index)
- Source intelligence (tier breakdown, failing sources)
- Market signals (top skills, dominant stack, remote %)
- Resource safety (worker invocations, D1 writes, AI calls)
- Config validation warnings

---

## Flow Diagram

```
evaluateJobs()
    │
    ├── Score job (scoreJob, scoreResult)
    ├── score ≥ MINIMUM_ALERT_SCORE (55)?
    │       NO → skip
    │       YES ↓
    ├── sentAlertsSet.has(jobId:profileId)?
    │       YES → skip (already alerted)
    │       NO ↓
    ├── ALERT_QUEUE.send({ profileId, job, scoreResult })
    │       → withRetry (3 attempts, backoff)
    │       → Fallback: sendAlert() inline if queue fails
    │
ALERT_QUEUE consumer:
    └── sendAlerts(messages)
            ├── sendAlert(job, scoreResult) → Discord embed
            ├── sendAlert(job, scoreResult) → Telegram message
            ├── stats.sent > 0 → msg.ack()
            └── stats.sent = 0 → msg.retry(delay=15min)
```

**Channels:** Discord (webhook), Telegram (Bot API)  
**Dedup:** In-memory Set + D1 `sent_alerts` table  
**Retry:** 5 attempts × 15-minute delay = 75 minutes resilience  
**Daily report:** Midnight UTC, via same notification channels
