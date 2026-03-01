/**
 * @module intelligence/dailyReport
 * @description Daily Intelligence Report — accumulates metrics during the day,
 * generates a rich formatted report, and sends it via Discord/Telegram.
 */

import logger from '../core/logger.js';

// ── Date Helpers ──────────────────────────────────────────────────────────────

function todayUTC() {
    return new Date().toISOString().split('T')[0]; // "2026-03-01"
}

function formatDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// ── Metric Accumulator ────────────────────────────────────────────────────────

/**
 * Increment daily metric counters. Creates today's row if it doesn't exist.
 *
 * @param {D1Database} db
 * @param {object} deltas - { sources_scanned: 5, raw_jobs_found: 42, ... }
 */
export async function incrementDailyMetrics(db, deltas) {
    const date = todayUTC();

    try {
        // Ensure today's row exists
        await db.prepare(
            `INSERT OR IGNORE INTO daily_metrics (date) VALUES (?)`
        ).bind(date).run();

        // Build dynamic SET clause from deltas
        const setClauses = [];
        const values = [];

        for (const [key, val] of Object.entries(deltas)) {
            if (key === 'skill_counts') continue; // handled separately
            if (key === 'score_max') {
                setClauses.push(`score_max = MAX(score_max, ?)`);
            } else {
                setClauses.push(`${key} = ${key} + ?`);
            }
            values.push(val);
        }

        if (setClauses.length > 0) {
            await db.prepare(
                `UPDATE daily_metrics SET ${setClauses.join(', ')} WHERE date = ?`
            ).bind(...values, date).run();
        }

        // Merge skill_counts JSON
        if (deltas.skill_counts && Object.keys(deltas.skill_counts).length > 0) {
            await mergeSkillCounts(db, date, deltas.skill_counts);
        }
    } catch (err) {
        logger.warn(`[DailyMetrics] Failed to increment: ${err.message}`);
    }
}

async function mergeSkillCounts(db, date, newCounts) {
    try {
        const row = await db.prepare(
            `SELECT skill_counts FROM daily_metrics WHERE date = ?`
        ).bind(date).first();

        let existing = {};
        try { existing = JSON.parse(row?.skill_counts || '{}'); } catch { /* empty */ }

        for (const [skill, count] of Object.entries(newCounts)) {
            existing[skill] = (existing[skill] || 0) + count;
        }

        await db.prepare(
            `UPDATE daily_metrics SET skill_counts = ? WHERE date = ?`
        ).bind(JSON.stringify(existing), date).run();
    } catch (err) {
        logger.warn(`[DailyMetrics] Skill merge failed: ${err.message}`);
    }
}

// ── Report Data Fetcher ───────────────────────────────────────────────────────

/**
 * Fetch today's metrics + source tier breakdown for the report.
 *
 * @param {D1Database} db
 * @returns {Promise<object>} Report data object
 */
export async function getDailyReportData(db) {
    const date = todayUTC();
    const yesterday = new Date(Date.now() - 86400_000).toISOString().split('T')[0];

    try {
        const [todayRes, yesterdayRes, sourceBreakdownRes, totalSourcesRes] = await db.batch([
            db.prepare(`SELECT * FROM daily_metrics WHERE date = ?`).bind(date),
            db.prepare(`SELECT * FROM daily_metrics WHERE date = ?`).bind(yesterday),
            db.prepare(`
                SELECT crawl_tier,
                       COUNT(*) as count,
                       AVG(priority_score) as avg_score
                FROM source_registry
                WHERE enabled = 1
                GROUP BY crawl_tier
            `),
            db.prepare(`
                SELECT
                    COUNT(*) as total,
                    SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as active,
                    SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END) as disabled
                FROM source_registry
            `),
        ]);

        const today = todayRes.results?.[0] || {};
        const prev = yesterdayRes.results?.[0] || {};
        const tiers = {};
        for (const row of (sourceBreakdownRes.results || [])) {
            tiers[row.crawl_tier || 'unknown'] = { count: row.count, avgScore: row.avg_score };
        }
        const sources = totalSourcesRes.results?.[0] || { total: 0, active: 0, disabled: 0 };

        return { date, today, prev, tiers, sources };
    } catch (err) {
        logger.warn(`[DailyReport] Failed to fetch data: ${err.message}`);
        return { date, today: {}, prev: {}, tiers: {}, sources: { total: 0, active: 0, disabled: 0 } };
    }
}

// ── Report Formatter ──────────────────────────────────────────────────────────

function pctChange(curr, prev) {
    if (!prev || prev === 0) return '';
    const diff = ((curr - prev) / prev * 100).toFixed(1);
    return diff > 0 ? ` (+${diff}%)` : ` (${diff}%)`;
}

function qualityIndex(avgScore) {
    if (avgScore >= 75) return '🟢 Excellent';
    if (avgScore >= 60) return '🟡 Strong';
    if (avgScore >= 45) return '🔵 Moderate';
    return '🔴 Needs Tuning';
}

function resourceSafety(invocations) {
    const pct = Math.round((invocations / 100_000) * 100);
    if (pct <= 50) return { pct, emoji: '🟢', label: 'Safe' };
    if (pct <= 75) return { pct, emoji: '🟡', label: 'Moderate' };
    return { pct, emoji: '🔴', label: 'High' };
}

/**
 * Build the formatted daily intelligence report string.
 *
 * @param {object} data - from getDailyReportData()
 * @returns {string} Formatted report text
 */
export function formatDailyReport(data) {
    const { date, today: t, prev: p, tiers, sources } = data;
    const m = (key, fallback = 0) => t[key] ?? fallback;
    const pm = (key, fallback = 0) => p[key] ?? fallback;

    // Derived calculations
    const newSources = m('new_sources_ats') + m('new_sources_career') + m('new_sources_search');
    const prevNewSources = pm('new_sources_ats') + pm('new_sources_career') + pm('new_sources_search');
    const totalRawJobs = m('raw_jobs_found');
    const uniqueStored = m('unique_jobs_stored');
    const dupes = m('duplicates_filtered');
    const sourcesScanned = m('sources_scanned');
    const successRate = sourcesScanned > 0 ? Math.round((m('crawl_successes') / sourcesScanned) * 100) : 0;
    const alertsSent = m('alerts_sent');
    const avgScore = alertsSent > 0 ? (m('score_sum') / alertsSent).toFixed(1) : '0';
    const highValueYield = totalRawJobs > 0 ? ((uniqueStored / totalRawJobs) * 100).toFixed(1) : '0';
    const totalJobs = uniqueStored + dupes;
    const relevancePass = totalJobs > 0 ? ((alertsSent / totalJobs) * 100).toFixed(0) : '0';

    // Skill parsing
    let skillCounts = {};
    try { skillCounts = JSON.parse(t.skill_counts || '{}'); } catch { /* empty */ }
    const topSkills = Object.entries(skillCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
    const topSkill = topSkills[0] ? topSkills[0][0] : 'N/A';

    // Stack detection
    const mern = ['mongodb', 'express', 'react', 'node.js'];
    const hasMern = mern.every(s => skillCounts[s] > 0);
    const dominantStack = hasMern ? 'MERN' : (topSkills.length >= 2 ? `${topSkills[0]?.[0]} + ${topSkills[1]?.[0]}` : 'Mixed');

    // Remote percentage
    const totalLocJobs = m('remote_jobs') + m('hybrid_jobs') + m('onsite_jobs');
    const remotePct = totalLocJobs > 0 ? Math.round((m('remote_jobs') / totalLocJobs) * 100) : 0;

    // Avg salary
    const avgSalary = m('salary_count') > 0 ? Math.round(m('salary_sum') / m('salary_count')) : 0;

    // Tier breakdown
    const tierHigh = tiers.high?.count || 0;
    const tierMed = tiers.medium?.count || 0;
    const tierLow = tiers.low?.count || 0;
    const tierDormant = tiers.dormant?.count || 0;
    const allTierCounts = tierHigh + tierMed + tierLow + tierDormant;
    const avgPriority = allTierCounts > 0
        ? ((tierHigh * (tiers.high?.avgScore || 0) + tierMed * (tiers.medium?.avgScore || 0) +
            tierLow * (tiers.low?.avgScore || 0) + tierDormant * (tiers.dormant?.avgScore || 0)) / allTierCounts).toFixed(1)
        : '0';

    // Resource safety
    const res = resourceSafety(m('worker_invocations'));

    // Optimization trend
    const prevAvgPriority = pm('score_sum', 0) > 0 ? (pm('score_sum') / Math.max(pm('alerts_sent'), 1)).toFixed(1) : 0;
    const priorityDelta = (parseFloat(avgPriority) - parseFloat(prevAvgPriority)).toFixed(1);
    const trend = parseFloat(priorityDelta) > 0 ? '📈 Improving' : parseFloat(priorityDelta) < 0 ? '📉 Declining' : '➡️ Stable';

    return `📊 JOB HUNTER BOT — DAILY INTELLIGENCE
🗓 ${formatDate(date)}

━━━━━━━━━━━━━━━━━━
🚀 GROWTH & EXPANSION
• New Sources: +${newSources}${pctChange(newSources, prevNewSources)}
   ↳ ATS: +${m('new_sources_ats')} | Career: +${m('new_sources_career')} | Search: +${m('new_sources_search')}
• Active Sources: ${sources.active}
• Disabled: ${sources.disabled}

━━━━━━━━━━━━━━━━━━
📡 CRAWL PERFORMANCE
• Sources Scanned: ${sourcesScanned}
• Success Rate: ${successRate}%
• Raw Jobs: ${totalRawJobs}
• Unique Stored: ${uniqueStored}
• Duplicates Filtered: ${dupes}
• High-Value Yield: ${highValueYield}%
• Relevance Pass Rate: ${relevancePass}%

━━━━━━━━━━━━━━━━━━
🔔 ALERT QUALITY
• Alerts Sent: ${alertsSent}
• Delivery Failures: ${m('alert_failures')}
• Avg Score: ${avgScore}
• Highest Score: ${m('score_max')}
• Quality Index: ${qualityIndex(parseFloat(avgScore))}

━━━━━━━━━━━━━━━━━━
🧠 SOURCE INTELLIGENCE
• High: ${tierHigh} | Med: ${tierMed} | Low: ${tierLow} | Dormant: ${tierDormant}
• Avg Priority: ${avgPriority}  (${priorityDelta > 0 ? '+' : ''}${priorityDelta})
• Optimization Trend: ${trend}

━━━━━━━━━━━━━━━━━━
📊 MARKET SIGNALS
• Top Skill: ${topSkill}
• Dominant Stack: ${dominantStack}
• Remote Roles: ${remotePct}%
• Avg Salary: ${avgSalary > 0 ? '$' + avgSalary.toLocaleString('en-US') : 'N/A'}
${topSkills.length > 0 ? `• Top 3: ${topSkills.map(([s, c]) => `${s} (${c})`).join(' · ')}` : ''}

━━━━━━━━━━━━━━━━━━
☁ RESOURCE SAFETY
• Worker Invocations: ${m('worker_invocations').toLocaleString('en-US')}
• D1 Writes: ${m('d1_writes').toLocaleString('en-US')}
• Queue Messages: ${m('queue_messages').toLocaleString('en-US')}
• AI Calls: ${m('ai_calls')}
• Free Tier Usage: ${res.pct}%  ${res.emoji} ${res.label}

━━━━━━━━━━━━━━━━━━
• Cycles Today: ${m('cycles_completed')}
${getEngineStatus(successRate, alertsSent, newSources)}`;
}

function getEngineStatus(successRate, alertsSent, newSources) {
    const parts = [];
    parts.push(successRate >= 80 ? '🟢 Healthy' : successRate >= 50 ? '🟡 Degraded' : '🔴 Unhealthy');
    if (newSources > 0) parts.push('Expanding');
    parts.push(successRate >= 70 ? 'Optimized' : 'Needs Tuning');
    return `${parts[0]} • ${parts.slice(1).join(' • ')}`;
}

// ── Discord Report Sender ─────────────────────────────────────────────────────

/**
 * Send the daily report via Discord webhook.
 *
 * @param {string} webhookUrl
 * @param {string} reportText
 */
async function sendDiscordReport(webhookUrl, reportText) {
    const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            content: `\`\`\`\n${reportText}\n\`\`\``,
        }),
    });

    if (!res.ok) {
        throw new Error(`Discord report failed: ${res.status} ${res.statusText}`);
    }
}

// ── Telegram Report Sender ────────────────────────────────────────────────────

/**
 * Send the daily report via Telegram.
 *
 * @param {string} botToken
 * @param {string} chatId
 * @param {string} reportText
 */
async function sendTelegramReport(botToken, chatId, reportText) {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: `\`\`\`\n${reportText}\n\`\`\``,
            parse_mode: 'MarkdownV2',
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Telegram report failed: ${res.status}: ${body}`);
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate and send the daily intelligence report.
 *
 * @param {D1Database} db
 * @param {object} env - Worker env bindings
 * @returns {Promise<{ sent: boolean, channels: string[] }>}
 */
export async function sendDailyReport(db, env) {
    const result = { sent: false, channels: [] };

    try {
        const data = await getDailyReportData(db);
        const report = formatDailyReport(data);

        logger.info(`[DailyReport] Generated report for ${data.date}`);

        // Send to Discord
        if (env.DISCORD_WEBHOOK_URL) {
            try {
                await sendDiscordReport(env.DISCORD_WEBHOOK_URL, report);
                result.channels.push('Discord');
                result.sent = true;
                logger.info('[DailyReport] Sent to Discord');
            } catch (err) {
                logger.error(`[DailyReport] Discord failed: ${err.message}`);
            }
        }

        // Send to Telegram
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
            try {
                await sendTelegramReport(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, report);
                result.channels.push('Telegram');
                result.sent = true;
                logger.info('[DailyReport] Sent to Telegram');
            } catch (err) {
                logger.error(`[DailyReport] Telegram failed: ${err.message}`);
            }
        }

        if (!result.sent) {
            logger.info(`[DailyReport] No channels configured. Report:\n${report}`);
        }
    } catch (err) {
        logger.error(`[DailyReport] Generation failed: ${err.message}`);
    }

    return result;
}
