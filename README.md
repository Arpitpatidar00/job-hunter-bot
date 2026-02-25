# 🕵️‍♂️ Job Hunter Bot

Your personal 24/7 job scout for **Node.js** & **TypeScript** remote roles.

## Features

- 🕒 Polls job feeds every 15 minutes.
- 🔍 Filters for keywords: `node`, `typescript`, `backend`, `full stack`, `engineer`.
- 🚨 Alerts via **Discord Webhook** or **Telegram Bot**.
- 💾 Remembers seen jobs (deduplication) across restarts.

## Setup

1. **Clone & Install:**
   ```bash
   git clone <your-repo-url>
   cd job-hunter-bot
   npm install
   ```

2. **Configure:**
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   Fill in your credentials:
   - **Discord:** Create a Webhook in your server settings > Integrations > Webhooks.
   - **Telegram:** Talk to `@BotFather` to get a token, and `@userinfobot` to get your Chat ID.

3. **Run:**
   ```bash
   npm start
   ```

## Deployment

### AWS EC2 (Free Tier)
1. Launch a `t2.micro` instance (Ubuntu).
2. SSH in and install Node.js:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
3. Clone your repo and install dependencies.
4. Use **PM2** to keep it running 24/7:
   ```bash
   sudo npm install -g pm2
   pm2 start index.js --name job-hunter
   pm2 save
   pm2 startup
   ```

### Railway / Render
1. Push this code to a GitHub repository.
2. Connect your repo to Railway/Render.
3. Add the Environment Variables (`DISCORD_WEBHOOK_URL`, etc.) in the dashboard.
4. It will automatically run `npm start`.

## Customization

- **Keywords:** Edit `MUST_HAVE_KEYWORDS` in `index.js`.
- **Feeds:** Add more RSS URLs to the `FEEDS` array in `index.js`.
