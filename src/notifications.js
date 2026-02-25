/**
 * @module notifications
 * @description Send job alerts to Discord and Telegram. Supports dry-run mode.
 * Uses Discord embeds for rich formatting with salary, skills, and tags.
 */

import logger from './logger.js';
import { escapeRegex } from './utils.js';

/**
 * Validate that a string looks like a valid URL.
 * @param {string} url
 * @returns {boolean}
 */
function isValidUrl(url) {
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
}

/**
 * Extract salary information from job text using common patterns.
 * @param {string} text - Job title + content text.
 * @returns {string|null} Extracted salary string or null.
 */
function extractSalary(text) {
    if (!text) return null;

    // Match patterns like: $100k-$150k, $100,000 - $150,000, USD 80k-120k, €50,000, etc.
    const patterns = [
        /(?:salary|compensation|pay|offer)[:\s]*([$€£]\s?[\d,]+(?:k)?\s*[-–to]+\s*[$€£]?\s?[\d,]+(?:k)?(?:\s*(?:per\s+)?(?:year|yr|annum|annually|pa|p\.?a\.?))?)/i,
        /([$€£]\s?[\d,]+(?:k)?\s*[-–to]+\s*[$€£]?\s?[\d,]+(?:k)?\s*(?:per\s+)?(?:year|yr|annum|annually|pa|p\.?a\.?|usd|eur|gbp))/i,
        /([$€£]\s?[\d,]+(?:k)?\s*[-–to]+\s*[$€£]?\s?[\d,]+(?:k)?)/i,
        /((?:USD|EUR|GBP)\s?[\d,]+(?:k)?\s*[-–to]+\s*[\d,]+(?:k)?)/i,
        /([\d,]+(?:k)?\s*[-–to]+\s*[\d,]+(?:k)?\s*(?:USD|EUR|GBP))/i,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1].trim();
    }

    return null;
}

/**
 * Extract matched skill keywords from job text.
 * @param {string} text - Job title + content text.
 * @param {string[]} profileKeywords - User's profile keywords.
 * @returns {string[]} List of matched keywords.
 */
function extractMatchedSkills(text, profileKeywords) {
    if (!text || !profileKeywords?.length) return [];
    const lower = text.toLowerCase();
    return profileKeywords.filter((kw) => {
        const regex = new RegExp(`\\b${escapeRegex(kw.toLowerCase())}\\b`, 'i');
        return regex.test(lower);
    });
}

/**
 * Format a date string into a clean, readable format.
 * @param {string} dateStr - Raw date string from RSS.
 * @returns {string} Formatted date string.
 */
function formatDate(dateStr) {
    if (!dateStr) return 'Unknown';
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString('en-US', {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    } catch {
        return dateStr;
    }
}

/**
 * Truncate a string to a max length, adding ellipsis if needed.
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/**
 * Build a Discord embed object for a job alert.
 * @param {object} job - The RSS job item.
 * @param {object} config - Bot config (for keyword extraction).
 * @returns {object} Discord embed object.
 */
function buildDiscordEmbed(job, config) {
    const fullText = `${job.title || ''} ${job.content || job.contentSnippet || ''}`;
    const salary = extractSalary(fullText);
    const skills = extractMatchedSkills(fullText, config?.profileKeywords || []);
    const tags = (job.categories || []).slice(0, 5);
    const postedDate = formatDate(job.pubDate || job.isoDate);
    const description = truncate(job.contentSnippet || job.content || '', 300);

    // Build embed fields
    const fields = [];

    if (salary) {
        fields.push({ name: '💰 Salary', value: salary, inline: true });
    }

    if (skills.length > 0) {
        fields.push({
            name: '🛠️ Matched Skills',
            value: skills.map((s) => `\`${s}\``).join('  '),
            inline: false,
        });
    }

    if (tags.length > 0) {
        fields.push({
            name: '🏷️ Tags',
            value: tags.map((t) => `\`${t}\``).join('  '),
            inline: false,
        });
    }

    fields.push({ name: '📅 Posted', value: postedDate, inline: true });

    if (job.creator) {
        fields.push({ name: '🏢 Source', value: job.creator, inline: true });
    }

    return {
        title: `🚀 ${truncate(job.title, 250)}`,
        url: job.link,
        description: description || undefined,
        color: 0x5865f2, // Discord blurple
        fields,
        footer: { text: 'Job Hunter Bot' },
        timestamp: new Date().toISOString(),
    };
}

/**
 * Escape special characters for Telegram MarkdownV2.
 * @param {string} text - Text to escape.
 * @returns {string} Escaped text.
 */
function escTg(text) {
    if (!text) return '';
    return String(text).replace(/[_*[\]()~`>#+=|{}.!\-]/g, '\\$&');
}

/**
 * Build a Telegram message for a job alert.
 * @param {object} job - The RSS job item.
 * @param {object} config - Bot config.
 * @returns {string} Formatted Telegram message.
 */
function buildTelegramMessage(job, config) {
    const fullText = `${job.title || ''} ${job.content || job.contentSnippet || ''}`;
    const salary = extractSalary(fullText);
    const skills = extractMatchedSkills(fullText, config?.profileKeywords || []);
    const tags = (job.categories || []).slice(0, 5);
    const postedDate = formatDate(job.pubDate || job.isoDate);

    let msg = `🚀 *${escTg(job.title || 'Untitled')}*\n\n`;

    if (salary) msg += `💰 *Salary:* ${escTg(salary)}\n`;
    if (skills.length > 0) msg += `🛠️ *Skills:* ${skills.map(s => escTg(s)).join(', ')}\n`;
    if (tags.length > 0) msg += `🏷️ *Tags:* ${tags.map(t => escTg(t)).join(', ')}\n`;
    msg += `📅 *Posted:* ${escTg(postedDate)}\n`;
    if (job.creator) msg += `🏢 *Source:* ${escTg(job.creator)}\n`;
    msg += `\n🔗 [Apply / View Job](${job.link})`;

    return msg;
}

/**
 * Send a job alert to all configured notification channels.
 *
 * @param {object} job - The job item (title, link, pubDate, content, categories, etc.).
 * @param {object} options - Notification options.
 * @param {boolean} options.dryRun - If true, log the alert without sending.
 * @param {object} [options.config] - Bot config for skill extraction.
 * @returns {Promise<{ sent: number, failed: number, channels: string[] }>} Stats.
 */
export async function sendAlert(job, options = {}) {
    const { dryRun = false, config = {} } = options;
    const stats = { sent: 0, failed: 0, channels: [] };

    // --- Dry-run mode ---
    if (dryRun) {
        const fullText = `${job.title || ''} ${job.content || job.contentSnippet || ''}`;
        const salary = extractSalary(fullText);
        const skills = extractMatchedSkills(fullText, config?.profileKeywords || []);
        logger.info(
            `[DRY RUN] Would send alert: ${job.title} — ${job.link}` +
            (salary ? ` | Salary: ${salary}` : '') +
            (skills.length ? ` | Skills: ${skills.join(', ')}` : '')
        );
        stats.sent = 1;
        stats.channels.push('dry-run');
        return stats;
    }

    const discordUrl = process.env.DISCORD_WEBHOOK_URL;
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;

    const hasDiscord = discordUrl && isValidUrl(discordUrl);
    const hasTelegram = telegramToken && telegramChatId;

    // --- Discord (Rich Embed) ---
    if (hasDiscord) {
        try {
            const embed = buildDiscordEmbed(job, config);
            const res = await fetch(discordUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ embeds: [embed] }),
            });
            if (!res.ok) {
                throw new Error(`Discord responded with ${res.status}: ${res.statusText}`);
            }
            logger.info(`✅ Discord alert sent: ${job.title}`);
            stats.sent++;
            stats.channels.push('discord');
        } catch (err) {
            logger.error(`❌ Discord alert failed for "${job.title}": ${err.message}`);
            stats.failed++;
        }
    } else if (discordUrl && !isValidUrl(discordUrl)) {
        logger.warn(`Discord webhook URL is invalid: "${discordUrl}"`);
    }

    // --- Telegram (MarkdownV2) ---
    if (hasTelegram) {
        try {
            const telegramUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
            const text = buildTelegramMessage(job, config);
            const res = await fetch(telegramUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: telegramChatId,
                    text,
                    parse_mode: 'MarkdownV2',
                    disable_web_page_preview: false,
                }),
            });
            if (!res.ok) {
                const body = await res.text();
                throw new Error(`Telegram responded with ${res.status}: ${body}`);
            }
            logger.info(`✅ Telegram alert sent: ${job.title}`);
            stats.sent++;
            stats.channels.push('telegram');
        } catch (err) {
            logger.error(`❌ Telegram alert failed for "${job.title}": ${err.message}`);
            stats.failed++;
        }
    }

    // --- No channels configured ---
    if (!hasDiscord && !hasTelegram) {
        logger.info(`[Mock Alert] ${job.title} — ${job.link} (no notification channels configured)`);
        stats.channels.push('mock');
    }

    return stats;
}
