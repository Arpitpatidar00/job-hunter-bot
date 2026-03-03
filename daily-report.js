#!/usr/bin/env node

/**
 * @module daily-report
 * @description Standalone daily report script — fetches all RSS feeds once,
 * scores every job, and prints a full summary report to the console.
 * Also sends the report to Discord + Telegram.
 *
 * Usage:
 *   node daily-report.js              # Full report, sent to Discord + Telegram
 *   node daily-report.js --console    # Print to console only (no notifications)
 *   node daily-report.js --dry-run    # Same as --console
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env manually (no dotenv dependency needed)
try {
    const envFile = readFileSync(resolve('.env'), 'utf8');
    for (const line of envFile.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
    }
} catch { /* .env not found — that's fine */ }

import { loadConfig } from './src/config.js';
import { runAllConnectors } from './src/connectors/index.js';
import { scoreJob, isNewJob, timeAgo } from './src/scoring/relevance.js';
import { sanitizeText } from './src/core/utils.js';

// ── CLI flags ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const consoleOnly = args.includes('--console') || args.includes('--dry-run');

// ── Helpers ──────────────────────────────────────────────────────────────────

function escTg(text) {
    if (!text) return '';
    return String(text).replace(/[_*[\]()~`>#+=|{}.!\-]/g, '\\$&');
}

function formatSalary(scoreResult) {
    const salaryFeature = scoreResult.features?.salaryUSD;
    if (salaryFeature) {
        const { min, max } = salaryFeature;
        if (min === max) return `~$${min.toLocaleString()} USD`;
        return `$${min.toLocaleString()}–$${max.toLocaleString()} USD`;
    }
    const salaryReason = (scoreResult.reasons || []).find(r => r.startsWith('Salary detected'));
    return salaryReason ? salaryReason.replace('Salary detected: ', '') : null;
}

function tierLabel(score) {
    if (score >= 88) return { label: 'Excellent', emoji: '🟢' };
    if (score >= 72) return { label: 'Strong', emoji: '🟡' };
    if (score >= 55) return { label: 'Moderate', emoji: '🔵' };
    if (score >= 38) return { label: 'Weak', emoji: '🟣' };
    return { label: 'Poor', emoji: '🔴' };
}

function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const startTime = Date.now();
    const config = loadConfig();

    console.log('\n🔍 Fetching all feeds...\n');

    // Fetch all jobs from all connectors (RSS + ATS)
    const { jobs: allJobs, feedStats, totalErrors } = await runAllConnectors(config);

    const totalFetched = allJobs.length;
    const successFeeds = feedStats.filter(f => f.success).length;
    const failedFeeds = feedStats.filter(f => !f.success).length;

    // Filter to new jobs only (within time window)
    const newJobs = allJobs.filter(job => isNewJob(job, config.timeWindowHours));

    // Score every new job
    const scoredJobs = newJobs.map(job => ({
        job,
        result: scoreJob(job, config),
    }));

    // Filter out excluded jobs
    const validJobs = scoredJobs.filter(({ result }) => !result.excluded);

    // Sort by score descending
    validJobs.sort((a, b) => b.result.score - a.result.score);

    // Tier breakdown
    const excellent = validJobs.filter(j => j.result.score >= 88);
    const strong = validJobs.filter(j => j.result.score >= 72 && j.result.score < 88);
    const moderate = validJobs.filter(j => j.result.score >= 55 && j.result.score < 72);
    const weak = validJobs.filter(j => j.result.score >= 38 && j.result.score < 55);
    const poor = validJobs.filter(j => j.result.score < 38);

    const aboveThreshold = validJobs.filter(j => j.result.score >= (config.notificationThreshold || 50));
    const avgScore = validJobs.length > 0
        ? (validJobs.reduce((sum, j) => sum + j.result.score, 0) / validJobs.length).toFixed(1)
        : 0;
    const topScore = validJobs.length > 0 ? validJobs[0].result.score : 0;

    // Skill frequency
    const skillFreq = {};
    for (const { result } of validJobs) {
        for (const skill of result.matchedSkills || []) {
            skillFreq[skill] = (skillFreq[skill] || 0) + 1;
        }
    }
    const topSkills = Object.entries(skillFreq).sort((a, b) => b[1] - a[1]).slice(0, 8);

    // Salary stats
    const salaries = validJobs
        .map(j => j.result.features?.salaryUSD)
        .filter(Boolean);
    const avgSalary = salaries.length > 0
        ? Math.round(salaries.reduce((s, sal) => s + (sal.min + sal.max) / 2, 0) / salaries.length)
        : 0;

    // Remote type breakdown
    const remoteCount = validJobs.filter(j => j.result.features?.remoteType === 'remote').length;
    const hybridCount = validJobs.filter(j => j.result.features?.remoteType === 'hybrid').length;

    // Seniority breakdown
    const seniorityBk = {};
    for (const { result } of validJobs) {
        const s = result.features?.seniority || 'unknown';
        seniorityBk[s] = (seniorityBk[s] || 0) + 1;
    }

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const dateStr = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });

    // ── Build Console Report ─────────────────────────────────────────────────

    const sep = '━'.repeat(50);

    let report = `
📊  JOB HUNTER BOT — DAILY REPORT
🗓  ${dateStr}

${sep}
📡  FEED PERFORMANCE
• Sources Scanned: ${feedStats.length}
• Successful: ${successFeeds} | Failed: ${failedFeeds}
• Total Jobs Fetched: ${totalFetched.toLocaleString()}
• New Jobs (last ${config.timeWindowHours}h): ${newJobs.length}
• Scan Duration: ${elapsedSec}s

${sep}
🎯  SCORING SUMMARY
• Jobs Scored: ${validJobs.length}
• Above Alert Threshold (${config.notificationThreshold}%): ${aboveThreshold.length}
• Average Score: ${avgScore}%
• Top Score: ${topScore}%

${sep}
📊  TIER BREAKDOWN
• 🟢 Excellent (88+):  ${excellent.length}
• 🟡 Strong (72–87):   ${strong.length}
• 🔵 Moderate (55–71): ${moderate.length}
• 🟣 Weak (38–54):     ${weak.length}
• 🔴 Poor (<38):       ${poor.length}

${sep}
🛠  TOP SKILLS IN DEMAND
${topSkills.length > 0 ? topSkills.map(([s, c], i) => `  ${i + 1}. ${s} — ${c} jobs`).join('\n') : '  No skill data'}

${sep}
📍  LOCATION & LEVEL
• Remote: ${remoteCount} | Hybrid: ${hybridCount}
${Object.entries(seniorityBk).filter(([k]) => k !== 'unknown').map(([k, v]) => `• ${k.charAt(0).toUpperCase() + k.slice(1)}: ${v}`).join('\n')}
• Avg Salary: ${avgSalary > 0 ? '$' + avgSalary.toLocaleString() + ' USD' : 'N/A'}
• Salaries Found: ${salaries.length}
`;

    // ── Top 15 Jobs ──────────────────────────────────────────────────────────

    const topJobs = aboveThreshold.slice(0, 15);
    if (topJobs.length > 0) {
        report += `\n${sep}\n🚀  TOP ${topJobs.length} JOBS TODAY\n\n`;
        for (let i = 0; i < topJobs.length; i++) {
            const { job, result } = topJobs[i];
            const { emoji } = tierLabel(result.score);
            const salary = formatSalary(result);
            const skills = (result.matchedSkills || []).slice(0, 5).join(', ');
            const posted = timeAgo(job.pubDate || job.isoDate);
            const company = job.company || job.creator || '';

            report += `${i + 1}. ${emoji} ${result.score}% — ${truncate(job.title, 60)}\n`;
            if (company) report += `   🏢 ${company}\n`;
            if (salary) report += `   💰 ${salary}\n`;
            if (skills) report += `   🛠  ${skills}\n`;
            report += `   📅 ${posted}\n`;
            report += `   🔗 ${job.link}\n\n`;
        }
    } else {
        report += `\n${sep}\n⚠️  No jobs above threshold today.\n`;
    }

    // ── Failed Feeds ─────────────────────────────────────────────────────────

    const failedList = feedStats.filter(f => !f.success);
    if (failedList.length > 0) {
        report += `${sep}\n⚠️  FAILED FEEDS (${failedList.length})\n`;
        for (const f of failedList.slice(0, 10)) {
            report += `  ✗ ${f.name || f.url} — ${f.error}\n`;
        }
        report += '\n';
    }

    report += `${sep}\n✅  Report generated in ${elapsedSec}s\n`;

    // ── Print to console ─────────────────────────────────────────────────────
    console.log(report);

    // ── Send to Discord + Telegram ───────────────────────────────────────────
    if (!consoleOnly) {
        const discordUrl = process.env.DISCORD_WEBHOOK_URL;
        const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
        const telegramChatId = process.env.TELEGRAM_CHAT_ID;

        // Discord — send as code block (fits nicely in monospace)
        if (discordUrl) {
            try {
                // Discord has 2000 char limit; split if needed
                const chunks = splitMessage(report, 1950);
                for (const chunk of chunks) {
                    const res = await fetch(discordUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: `\`\`\`\n${chunk}\n\`\`\`` }),
                    });
                    if (!res.ok) throw new Error(`Discord ${res.status}: ${res.statusText}`);
                    // Small delay between chunks to avoid rate limit
                    if (chunks.length > 1) await sleep(1000);
                }
                console.log('✅ Report sent to Discord');
            } catch (err) {
                console.error(`❌ Discord send failed: ${err.message}`);
            }
        }

        // Telegram — send as pre-formatted monospace block
        if (telegramToken && telegramChatId) {
            try {
                const chunks = splitMessage(report, 3900);
                for (const chunk of chunks) {
                    const tgUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
                    const escapedChunk = escTg(chunk);
                    const res = await fetch(tgUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: telegramChatId,
                            text: `\`\`\`\n${escapedChunk}\n\`\`\``,
                            parse_mode: 'MarkdownV2',
                        }),
                    });
                    if (!res.ok) {
                        const body = await res.text();
                        throw new Error(`Telegram ${res.status}: ${body}`);
                    }
                    if (chunks.length > 1) await sleep(500);
                }
                console.log('✅ Report sent to Telegram');
            } catch (err) {
                console.error(`❌ Telegram send failed: ${err.message}`);
            }
        }

        if (!discordUrl && !(telegramToken && telegramChatId)) {
            console.log('ℹ️  No notification channels configured (set DISCORD_WEBHOOK_URL or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env)');
        }
    } else {
        console.log('ℹ️  Console-only mode — skipping notifications.');
    }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function splitMessage(text, maxLen) {
    const chunks = [];
    const lines = text.split('\n');
    let current = '';

    for (const line of lines) {
        if ((current + '\n' + line).length > maxLen) {
            if (current) chunks.push(current);
            current = line;
        } else {
            current += (current ? '\n' : '') + line;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ── Run ──────────────────────────────────────────────────────────────────────

main().then(() => {
    process.exit(0);
}).catch(err => {
    console.error(`❌ Report failed: ${err.message}`);
    process.exit(1);
});
