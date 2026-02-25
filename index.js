import Parser from 'rss-parser';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

// Initialize RSS Parser
const parser = new Parser();

// Config
const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SEEN_JOBS_FILE = 'seen_jobs.json';

// Feed URLs (add more as needed)
// Using Remotive and WeWorkRemotely as examples since they are reliable RSS sources for devs.
// Web3.career often requires an API key or custom scraping, so these are safer defaults.
const FEEDS = [
    'https://remotive.com/remote-jobs/software-dev/feed',
    'https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss',
    'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss'
];

// Keywords to filter for (OR logic usually, but here we want matches)
const MUST_HAVE_KEYWORDS = ['node', 'typescript', 'backend', 'full stack', 'engineer'];
const LOCATION_KEYWORDS = ['remote']; // Usually implicit in these feeds, but good to check.

// Load seen jobs from file to avoid duplicates on restart
let seenJobs = new Set();
try {
    if (fs.existsSync(SEEN_JOBS_FILE)) {
        const data = fs.readFileSync(SEEN_JOBS_FILE, 'utf8');
        seenJobs = new Set(JSON.parse(data));
        console.log(`Loaded ${seenJobs.size} seen jobs from history.`);
    }
} catch (err) {
    console.error('Error loading seen jobs:', err);
}

// Helper to save seen jobs
function saveSeenJobs() {
    try {
        fs.writeFileSync(SEEN_JOBS_FILE, JSON.stringify([...seenJobs], null, 2));
    } catch (err) {
        console.error('Error saving seen jobs:', err);
    }
}

// Function to send alert (Discord or Telegram)
async function sendAlert(job) {
    const message = `🚨 **New Job Alert!** 🚨\n\n**${job.title}**\n${job.link}\n\n*Posted: ${job.pubDate}*`;

    // 1. Discord Webhook
    if (DISCORD_WEBHOOK_URL) {
        try {
            await fetch(DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: message })
            });
            console.log(`Sent Discord alert for: ${job.title}`);
        } catch (error) {
            console.error('Failed to send Discord alert:', error);
        }
    }

    // 2. Telegram Bot
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        try {
            const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
            await fetch(telegramUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message.replace(/\*\*/g, '*'), // Telegram uses * for bold in Markdown
                    parse_mode: 'Markdown'
                })
            });
            console.log(`Sent Telegram alert for: ${job.title}`);
        } catch (error) {
            console.error('Failed to send Telegram alert:', error);
        }
    }

    if (!DISCORD_WEBHOOK_URL && !TELEGRAM_BOT_TOKEN) {
        console.log(`[Mock Alert] New Job: ${job.title} - ${job.link}`);
    }
}

// Main polling function
async function checkFeeds() {
    console.log(`Checking feeds at ${new Date().toISOString()}...`);
    let newJobsCount = 0;

    for (const feedUrl of FEEDS) {
        try {
            const feed = await parser.parseURL(feedUrl);
            
            for (const item of feed.items) {
                // Check if already seen (using GUID or Link as unique ID)
                const id = item.guid || item.link;
                if (seenJobs.has(id)) continue;

                // Filter Logic
                const title = (item.title || '').toLowerCase();
                const content = (item.content || item.contentSnippet || '').toLowerCase();
                const combinedText = `${title} ${content}`;

                // Check for "Remote" (usually in title/feed, but explicit check is good)
                // And check for Node/TS related terms
                const isRelevant = MUST_HAVE_KEYWORDS.some(keyword => combinedText.includes(keyword));
                
                if (isRelevant) {
                    // New relevant job found!
                    seenJobs.add(id);
                    newJobsCount++;
                    await sendAlert(item);
                } else {
                    // Mark as seen so we don't re-process logic every time, even if ignored
                    seenJobs.add(id);
                }
            }
        } catch (error) {
            console.error(`Error fetching feed ${feedUrl}:`, error.message);
        }
    }

    if (newJobsCount > 0) {
        saveSeenJobs();
        console.log(`Found ${newJobsCount} new relevant jobs.`);
    } else {
        console.log('No new relevant jobs found.');
    }
}

// Start
console.log('🤖 Job Hunter Bot started!');
console.log(`Filters: ${MUST_HAVE_KEYWORDS.join(', ')}`);
checkFeeds(); // Initial check
setInterval(checkFeeds, POLL_INTERVAL_MS); // Schedule
