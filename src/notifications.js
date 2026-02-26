/**
 * @module notifications
 * @description Send color-coded, score-aware job alerts to Discord and Telegram.
 * Follows the master prompt notification format with match %, role, salary, skills, reasons.
 */

import logger from './logger.js';
import { timeAgo } from './relevance.js';

// ── Color constants ────────────────────────────────────────────────────────

/** Discord embed colors by score tier. */
const DISCORD_COLORS = {
    '🟢': 0x22c55e, // green
    '🟡': 0xeab308, // yellow
    '🔵': 0x3b82f6, // blue
    '🟣': 0xa855f7, // purple
    '🔴': 0xef4444, // red
};

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Validate that a string looks like a valid URL.
 * @param {string} url
 * @returns {boolean}
 */
function isValidUrl(url) {
    try { new URL(url); return true; } catch { return false; }
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
 * Escape special characters for Telegram MarkdownV2.
 * @param {string} text
 * @returns {string}
 */
function escTg(text) {
    if (!text) return '';
    return String(text).replace(/[_*[\]()~`>#+=|{}.!\-]/g, '\\$&');
}

// ── Discord Embed Builder ──────────────────────────────────────────────────

/**
 * Build a Discord embed for a scored job alert.
 *
 * @param {object}  job          - RSS job item.
 * @param {import('./relevance.js').ScoreResult} scoreResult
 * @returns {object} Discord embed payload.
 */
function buildDiscordEmbed(job, scoreResult) {
    const { score, label, color, matchedSkills, reasons } = scoreResult;

    const posted = timeAgo(job.pubDate || job.isoDate);
    const description = truncate(job.contentSnippet || job.content || '', 300);
    const tags = (job.categories || []).slice(0, 5);

    const fields = [];

    // Match score badge
    fields.push({ name: 'Match', value: `**${score}%** — ${label}`, inline: true });

    if (job.creator) {
        fields.push({ name: 'Company', value: job.creator, inline: true });
    }

    fields.push({ name: 'Posted', value: posted, inline: true });

    // Salary (extracted inline from reasons)
    const salaryReason = reasons.find(r => r.startsWith('Salary detected'));
    if (salaryReason) {
        const salaryValue = salaryReason.replace('Salary detected: ', '');
        fields.push({ name: 'Salary', value: `**${salaryValue}**`, inline: true });
    }

    // Skills
    if (matchedSkills.length > 0) {
        fields.push({
            name: 'Required Skills',
            value: matchedSkills.slice(0, 8).map(s => `\`${s}\``).join('  '),
            inline: false,
        });
    }

    // Why this matches
    const whyReasons = reasons
        .filter(r => !r.startsWith('Salary detected'))
        .slice(0, 5)
        .map(r => `✔ ${r}`);
    if (whyReasons.length > 0) {
        fields.push({
            name: 'Why This Matches',
            value: whyReasons.join('\n'),
            inline: false,
        });
    }

    if (tags.length > 0) {
        fields.push({
            name: 'Tags',
            value: tags.map(t => `\`${t}\``).join('  '),
            inline: false,
        });
    }

    return {
        title: `${color} ${label.toUpperCase()} (${score}%) — ${truncate(job.title, 200)}`,
        url: job.link,
        description: description || undefined,
        color: DISCORD_COLORS[color] || 0x5865f2,
        fields,
        footer: { text: 'Job Hunter Bot' },
        timestamp: new Date().toISOString(),
    };
}

// ── Telegram Message Builder ───────────────────────────────────────────────

/**
 * Build a Telegram MarkdownV2 message for a scored job alert.
 *
 * @param {object}  job
 * @param {import('./relevance.js').ScoreResult} scoreResult
 * @returns {string}
 */
function buildTelegramMessage(job, scoreResult) {
    const { score, label, color, matchedSkills, reasons } = scoreResult;

    const posted = timeAgo(job.pubDate || job.isoDate);
    const salaryReason = reasons.find(r => r.startsWith('Salary detected'));
    const salary = salaryReason ? salaryReason.replace('Salary detected: ', '') : null;

    let msg = `${color} *${escTg(label.toUpperCase())} \\(${score}%\\)*\n\n`;
    msg += `*Role:* ${escTg(job.title || 'Untitled')}\n`;
    if (job.creator) msg += `*Company:* ${escTg(job.creator)}\n`;
    if (salary) msg += `*Salary:* ${escTg(salary)}\n`;
    msg += `*Posted:* ${escTg(posted)}\n`;

    if (matchedSkills.length > 0) {
        msg += `\n*Required Skills:*\n`;
        for (const s of matchedSkills.slice(0, 8)) {
            msg += `\\- ${escTg(s)}\n`;
        }
    }

    const whyReasons = reasons
        .filter(r => !r.startsWith('Salary detected'))
        .slice(0, 5);
    if (whyReasons.length > 0) {
        msg += `\n*Why This Matches:*\n`;
        for (const r of whyReasons) {
            msg += `✔ ${escTg(r)}\n`;
        }
    }

    msg += `\n*Apply Here:*\n[View Job](${job.link})`;
    return msg;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Send a scored job alert to all configured notification channels.
 *
 * @param {object} job   - RSS job item.
 * @param {import('./relevance.js').ScoreResult} scoreResult - Scoring output.
 * @param {object} options
 * @param {boolean} options.dryRun
 * @param {object}  options.config
 * @returns {Promise<{ sent: number, failed: number, channels: string[] }>}
 */
export async function sendAlert(job, scoreResult, options = {}) {
    const { dryRun = false, config = {} } = options;
    const stats = { sent: 0, failed: 0, channels: [] };

    // ── Dry-run mode ───────────────────────────────────────────────────
    if (dryRun) {
        logger.info(
            `[DRY RUN] Would send alert: ${scoreResult.color} ${scoreResult.label} (${scoreResult.score}%) — ` +
            `${job.title} — ${job.link}`
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

    // ── Discord ────────────────────────────────────────────────────────
    if (hasDiscord) {
        try {
            const embed = buildDiscordEmbed(job, scoreResult);
            const res = await fetch(discordUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ embeds: [embed] }),
            });
            if (!res.ok) {
                throw new Error(`Discord responded with ${res.status}: ${res.statusText}`);
            }
            stats.sent++;
            stats.channels.push('Discord');
        } catch (err) {
            logger.error(`Discord alert failed for "${job.title}": ${err.message}`);
            stats.failed++;
        }
    } else if (discordUrl && !isValidUrl(discordUrl)) {
        logger.warn(`Discord webhook URL is invalid: "${discordUrl}"`);
    }

    // ── Telegram ───────────────────────────────────────────────────────
    if (hasTelegram) {
        try {
            const telegramUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
            const text = buildTelegramMessage(job, scoreResult);
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
            stats.sent++;
            stats.channels.push('Telegram');
        } catch (err) {
            logger.error(`Telegram alert failed for "${job.title}": ${err.message}`);
            stats.failed++;
        }
    }

    // ── No channels ────────────────────────────────────────────────────
    if (!hasDiscord && !hasTelegram) {
        logger.info(
            `[Mock Alert] ${scoreResult.color} ${scoreResult.score}% — ` +
            `${job.title} — ${job.link} (no notification channels configured)`
        );
        stats.channels.push('mock');
    }

    // Structured notification log
    if (stats.sent > 0) {
        logger.notified(scoreResult.label, stats.channels);
    }

    return stats;
}
