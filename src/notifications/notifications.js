/**
 * @module notifications
 * @description Send score-aware, breakdown-enriched job alerts to Discord and Telegram.
 * Features:
 *   - Discord: rich embed with score breakdown fields, salary, seniority, remote type
 *   - Telegram: structured MarkdownV2 message with all extracted features
 *   - Discord 429 Retry-After handling
 *   - Optional WhatsApp via Twilio-compatible webhook
 * Secrets sourced from Cloudflare Worker `env` bindings.
 */

import logger from '../core/logger.js';
import { timeAgo } from '../scoring/relevance.js';

// ── Color constants ────────────────────────────────────────────────────────
const DISCORD_COLORS = {
    '🟢': 0x22c55e,
    '🟡': 0xeab308,
    '🔵': 0x3b82f6,
    '🟣': 0xa855f7,
    '🔴': 0xef4444,
};

// ── Helpers ────────────────────────────────────────────────────────────────

function isValidUrl(url) {
    try { new URL(url); return true; } catch { return false; }
}

function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function escTg(text) {
    if (!text) return '';
    return String(text).replace(/[_*[\]()~`>#+=|{}.!\-]/g, '\\$&');
}

function formatSalary(scoreResult) {
    const salaryFeature = scoreResult.features?.salaryUSD;
    if (salaryFeature) {
        const { min, max, currency } = salaryFeature;
        if (min === max) return `~$${min.toLocaleString()} USD`;
        return `$${min.toLocaleString()}–$${max.toLocaleString()} USD`;
    }
    // Fallback: extract from reasons text
    const salaryReason = (scoreResult.reasons || []).find(r => r.startsWith('Salary detected'));
    return salaryReason ? salaryReason.replace('Salary detected: ', '') : null;
}

function remoteTypeBadge(rt) {
    return { remote: '🌍 Remote', hybrid: '🏢 Hybrid', onsite: '🏠 Onsite', unknown: '' }[rt] || '';
}

function seniorityBadge(s) {
    return { junior: '🟢 Junior', mid: '🔵 Mid-level', senior: '🟡 Senior', lead: '🔴 Lead', unknown: '' }[s] || '';
}

// ── Fetch with Discord 429 Retry-After handling ────────────────────────────

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

// ── Discord Embed Builder ──────────────────────────────────────────────────

function buildDiscordEmbed(job, scoreResult) {
    const { score, label, color, matchedSkills, reasons, breakdown, features } = scoreResult;
    const posted = timeAgo(job.pubDate || job.isoDate);
    const description = truncate(job.contentSnippet || job.content || '', 280);
    const tags = (job.categories || []).slice(0, 5);
    const salary = formatSalary(scoreResult);
    const remoteLabel = remoteTypeBadge(features?.remoteType);
    const seniorityLabel = seniorityBadge(features?.seniority);

    const fields = [];

    // Score badge
    fields.push({ name: '🎯 Match', value: `**${score}%** — ${label}`, inline: true });

    if (job.company || job.creator) {
        fields.push({ name: '🏢 Company', value: job.company || job.creator, inline: true });
    }

    fields.push({ name: '📅 Posted', value: posted, inline: true });

    if (salary) fields.push({ name: '💰 Salary', value: `**${salary}**`, inline: true });
    if (remoteLabel) fields.push({ name: '📍 Location', value: remoteLabel, inline: true });
    if (seniorityLabel) fields.push({ name: '📊 Level', value: seniorityLabel, inline: true });

    // Experience required
    if (features?.experience) {
        const expStr = features.experience.max
            ? `${features.experience.min}–${features.experience.max} yrs`
            : `${features.experience.min}+ yrs`;
        fields.push({ name: '⏳ Experience', value: expStr, inline: true });
    }

    // Matched skills
    if (matchedSkills.length > 0) {
        fields.push({
            name: '🛠 Matched Skills',
            value: matchedSkills.slice(0, 10).map(s => `\`${s}\``).join('  '),
            inline: false,
        });
    }

    // Why this matches
    const whyReasons = reasons
        .filter(r => !r.startsWith('Salary detected') && !r.startsWith('Experience:'))
        .slice(0, 6)
        .map(r => `✔ ${r}`);
    if (whyReasons.length > 0) {
        fields.push({ name: '💡 Why This Matches', value: whyReasons.join('\n'), inline: false });
    }

    // Score breakdown
    if (breakdown) {
        const bd = [
            `Title: **${breakdown.titleScore}**`,
            `Skills: **${breakdown.skillsScore}**`,
            `Tech: **${breakdown.techScore}**`,
            `Location: **${breakdown.locationScore}**`,
            `Salary: **${breakdown.salaryScore}**`,
            breakdown.tfidfBoost > 0 ? `TF-IDF: **+${breakdown.tfidfBoost}**` : null,
            breakdown.bonuses > 0 ? `Bonuses: **+${breakdown.bonuses}**` : null,
            breakdown.penalties < 0 ? `Penalties: **${breakdown.penalties}**` : null,
        ].filter(Boolean).join(' · ');
        fields.push({ name: '📐 Score Breakdown', value: bd, inline: false });
    }

    if (tags.length > 0) {
        fields.push({ name: '🏷 Tags', value: tags.map(t => `\`${t}\``).join('  '), inline: false });
    }

    return {
        title: `${color} ${label.toUpperCase()} (${score}%) — ${truncate(job.title, 190)}`,
        url: job.link,
        description: description || undefined,
        color: DISCORD_COLORS[color] || 0x5865f2,
        fields,
        footer: { text: 'Job Hunter Bot v3.1' },
        timestamp: new Date().toISOString(),
    };
}

// ── Telegram Message Builder ───────────────────────────────────────────────

function buildTelegramMessage(job, scoreResult) {
    const { score, label, color, matchedSkills, reasons, features } = scoreResult;
    const posted = timeAgo(job.pubDate || job.isoDate);
    const salary = formatSalary(scoreResult);
    const remoteLabel = remoteTypeBadge(features?.remoteType);
    const seniorityLabel = seniorityBadge(features?.seniority);

    let msg = `${color} *${escTg(label.toUpperCase())} \\(${score}%\\)*\n\n`;
    msg += `*Role:* ${escTg(job.title || 'Untitled')}\n`;
    if (job.company || job.creator) msg += `*Company:* ${escTg(job.company || job.creator)}\n`;
    if (salary) msg += `*Salary:* ${escTg(salary)}\n`;
    if (remoteLabel) msg += `*Location:* ${escTg(remoteLabel)}\n`;
    if (seniorityLabel) msg += `*Level:* ${escTg(seniorityLabel)}\n`;
    if (features?.experience) {
        const expStr = features.experience.max
            ? `${features.experience.min}–${features.experience.max} yrs`
            : `${features.experience.min}+ yrs`;
        msg += `*Experience:* ${escTg(expStr)}\n`;
    }
    msg += `*Posted:* ${escTg(posted)}\n`;

    if (matchedSkills.length > 0) {
        msg += `\n*Matched Skills:*\n`;
        for (const s of matchedSkills.slice(0, 8)) msg += `\\- \`${escTg(s)}\`\n`;
    }

    const whyReasons = reasons
        .filter(r => !r.startsWith('Salary detected') && !r.startsWith('Experience:'))
        .slice(0, 4);
    if (whyReasons.length > 0) {
        msg += `\n*Why This Matches:*\n`;
        for (const r of whyReasons) msg += `✔ ${escTg(r)}\n`;
    }

    msg += `\n*Apply Here:*\n[View Job](${job.link})`;
    return msg;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Send a scored job alert to all configured notification channels.
 *
 * @param {object} job
 * @param {import('./relevance.js').ScoreResult} scoreResult
 * @param {object} options
 * @param {boolean} [options.dryRun]
 * @param {object}  [options.config]
 * @param {object}  [options.env] - Cloudflare Worker env bindings.
 * @returns {Promise<{ sent: number, failed: number, channels: string[] }>}
 */
export async function sendAlert(job, scoreResult, options = {}) {
    const { dryRun = false, env = {} } = options;
    const stats = { sent: 0, failed: 0, channels: [] };
    const errors = []; // Collect errors; throw at end for queue retry

    if (dryRun) {
        logger.info(
            `[DRY RUN] Would send alert: ${scoreResult.color} ${scoreResult.label} ` +
            `(${scoreResult.score}%) — ${job.title} — ${job.link}`
        );
        stats.sent = 1;
        stats.channels.push('dry-run');
        return stats;
    }

    const discordUrl = env.DISCORD_WEBHOOK_URL;
    const telegramToken = env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = env.TELEGRAM_CHAT_ID;

    const hasDiscord = discordUrl && isValidUrl(discordUrl);
    const hasTelegram = telegramToken && telegramChatId;

    // ── Discord ────────────────────────────────────────────────────────────
    if (hasDiscord) {
        try {
            const embed = buildDiscordEmbed(job, scoreResult);
            // Add retry context footer if applicable
            if (options.attempt > 1) {
                embed.footer.text += ` | Retry ${options.attempt}`;
            }

            const res = await fetchWithRetry(discordUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ embeds: [embed] }),
            });
            if (!res.ok) throw new Error(`Discord ${res.status}: ${res.statusText}`);
            stats.sent++;
            stats.channels.push('Discord');
        } catch (err) {
            logger.error(`Discord alert failed for "${job.title}": ${err.message}`);
            stats.failed++;
            errors.push(err);
        }
    } else if (discordUrl && !isValidUrl(discordUrl)) {
        logger.warn(`Discord webhook URL is invalid: "${discordUrl}"`);
    }

    // ── Telegram ───────────────────────────────────────────────────────────
    if (hasTelegram) {
        try {
            const tgUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
            const text = buildTelegramMessage(job, scoreResult);
            // Append retry context if applicable
            let finalText = text;
            if (options.attempt > 1) {
                finalText += `\n\n_Retry attempt: ${options.attempt}_`;
            }

            const res = await fetch(tgUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: telegramChatId,
                    text: finalText,
                    parse_mode: 'MarkdownV2',
                    disable_web_page_preview: false,
                }),
            });
            if (!res.ok) {
                const body = await res.text();
                throw new Error(`Telegram ${res.status}: ${body}`);
            }
            stats.sent++;
            stats.channels.push('Telegram');
        } catch (err) {
            logger.error(`Telegram alert failed for "${job.title}": ${err.message}`);
            stats.failed++;
            errors.push(err);
        }
    }

    // ── No channels ────────────────────────────────────────────────────────
    if (!hasDiscord && !hasTelegram) {
        logger.info(
            `[Mock Alert] ${scoreResult.color} ${scoreResult.score}% — ` +
            `${job.title} — ${job.link} (no channels configured)`
        );
        stats.channels.push('mock');
    }

    if (stats.sent > 0) {
        logger.notified(scoreResult.label, stats.channels);
    }

    // If ALL channels failed, throw the first error to trigger queue retry
    if (errors.length > 0 && stats.sent === 0) {
        throw errors[0];
    }

    return stats;
}
