# 🕵️‍♂️ Job Hunter Bot v2

Your personal 24/7 job scout for **remote dev roles** — polls RSS feeds, matches your skills with fuzzy + regex matching, and alerts via **Discord** or **Telegram**.

## ✨ Features

- 🔄 **Configurable polling** — interval, feeds, keywords all in `config.json`
- 🔍 **Smart matching** — exact, fuzzy (string-similarity), and regex keyword support
- 🚨 **Alerts** — Discord Webhook & Telegram Bot notifications
- 💾 **Persistent deduplication** — Map-based `seen_jobs.json` with atomic saves & backups
- 🔒 **Validated config** — Joi schema validation on startup
- 📊 **Health logging** — structured Winston logs (console + `logs/app.log`)
- 🧪 **Dry-run mode** — test without sending real notifications
- ⚡ **Concurrent fetching** — `Promise.allSettled` + `p-limit` for fast, safe polling
- 🛡️ **Crash-proof** — graceful shutdown, uncaught error handlers, retries with backoff
- 🧩 **Modular** — split into clean, testable modules with JSDoc

## 🚀 Quick Start

### 1. Install

```bash
git clone <your-repo-url>
cd job-hunter-bot
npm install
```

### 2. Configure

Copy and edit the environment file:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `DISCORD_WEBHOOK_URL` | Discord channel webhook URL |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID from @userinfobot |

Edit `config.json` to customize feeds, keywords, interval, etc.

### 3. Run

```bash
# Production
npm start

# Dry-run (no real notifications)
npm run dev
```

## 🖥️ CLI Usage

```bash
node index.js [options]

Options:
  -i, --interval   Poll interval (e.g. "30m", "1h")
  -k, --keywords   Comma-separated profile keywords override
  -d, --dry-run    Log alerts without actually sending them     [boolean]
  -c, --config     Path to a custom config.json file            [default: "config.json"]
  -h, --help       Show help
```

**Examples:**

```bash
# Poll every 30 minutes with custom keywords
node index.js --interval=30m --keywords='react,vue,angular'

# Use a custom config file in dry-run mode
node index.js --config=./my-config.json --dry-run
```

## ⚙️ Configuration (`config.json`)

| Key | Type | Default | Description |
|---|---|---|---|
| `feeds` | `string[]` | 14 RSS URLs | RSS feed URLs to poll |
| `profileKeywords` | `string[]` | 30 skill terms | Keywords to match your skills |
| `locationKeywords` | `string[]` | `["remote"]` | Location filter keywords |
| `regexKeywords` | `string[]` | `[]` | Optional regex patterns for matching |
| `pollIntervalMs` | `number` | `900000` (15m) | Polling interval in ms |
| `timeWindowHours` | `number` | `24` | How old a job can be (hours) |
| `fuzzyThreshold` | `number` | `0.8` | Minimum fuzzy similarity (0–1) |
| `maxConcurrentFeeds` | `number` | `5` | Max concurrent RSS fetches |
| `maxRetries` | `number` | `3` | Retry attempts per feed |
| `seenJobsFile` | `string` | `"seen_jobs.json"` | Path to seen-jobs file |

## 📁 Project Structure

```
job-hunter-bot/
├── config.json            # Default configuration
├── index.js               # Entry point (orchestrator)
├── src/
│   ├── config.js          # Config loading + Joi validation + yargs CLI
│   ├── logger.js          # Winston structured logging
│   ├── storage.js         # Seen-jobs Map with backup & atomic I/O
│   ├── relevance.js       # Fuzzy + regex keyword matching
│   ├── feeds.js           # RSS fetching with retries & concurrency
│   ├── notifications.js   # Discord & Telegram alerts
│   └── utils.js           # Shared helpers (retry, date, sanitize)
├── tests/                 # Jest unit tests
├── logs/                  # Auto-created log files
├── package.json
└── .env.example
```

## 🧪 Testing

```bash
npm test
```

Runs Jest unit tests for relevance matching, storage, utilities, and feed processing.

## 🚢 Deployment (PM2)

Keep the bot running 24/7 on a server:

```bash
sudo npm install -g pm2
pm2 start index.js --name job-hunter
pm2 save
pm2 startup
```

Or use Railway/Render — push to GitHub, connect repo, add env vars, it runs `npm start` automatically.

## 🔧 Customization

- **Keywords** — Edit `profileKeywords` in `config.json` or use `--keywords` CLI flag
- **Feeds** — Add/remove RSS URLs in `config.json`
- **Matching** — Adjust `fuzzyThreshold` (lower = more matches) or add `regexKeywords`
- **Interval** — Change `pollIntervalMs` or use `--interval=30m`
