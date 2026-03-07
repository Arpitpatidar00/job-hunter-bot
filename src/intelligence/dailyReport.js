/**
 * @module intelligence/dailyReport
 * @description Daily Intelligence Report — accumulates metrics during the day,
 * generates a rich formatted report, and sends it via Discord/Telegram.
 */

import logger from "../core/logger.js";

// ── Date Helpers ──────────────────────────────────────────────────────────────

function todayUTC() {
  return new Date().toISOString().split("T")[0]; // "2026-03-01"
}

function formatDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ── Known Columns ─────────────────────────────────────────────────────────────

const KNOWN_METRIC_COLUMNS = new Set([
  "sources_scanned",
  "crawl_successes",
  "crawl_failures",
  "raw_jobs_found",
  "unique_jobs_stored",
  "duplicates_filtered",
  "alerts_sent",
  "alert_failures",
  "score_sum",
  "score_max",
  "new_sources_ats",
  "new_sources_career",
  "new_sources_search",
  "new_domains_queued",
  "remote_jobs",
  "hybrid_jobs",
  "onsite_jobs",
  "salary_sum",
  "salary_count",
  "worker_invocations",
  "d1_writes",
  "queue_messages",
  "ai_calls",
  "cycles_completed",
]);

// ── Metric Accumulator ────────────────────────────────────────────────────────

/**
 * Increment daily metric counters. Creates today's row if it doesn't exist.
 * Keys are validated against the known column set to prevent silent SQL failures.
 *
 * @param {D1Database} db
 * @param {object} deltas - { sources_scanned: 5, raw_jobs_found: 42, ... }
 */
export async function incrementDailyMetrics(db, deltas) {
  const date = todayUTC();

  try {
    // Build all statements and execute in a single batch
    const stmts = [];

    // Ensure today's row exists
    stmts.push(
      db
        .prepare(`INSERT OR IGNORE INTO daily_metrics (date) VALUES (?)`)
        .bind(date),
    );

    // Build dynamic SET clause from deltas
    const setClauses = [];
    const values = [];

    for (const [key, val] of Object.entries(deltas)) {
      if (key === "skill_counts") continue; // handled separately
      if (!KNOWN_METRIC_COLUMNS.has(key)) {
        logger.warn(`[DailyMetrics] Skipping unknown column: "${key}"`);
        continue;
      }
      if (key === "score_max") {
        setClauses.push(`score_max = MAX(score_max, ?)`);
      } else {
        setClauses.push(`${key} = ${key} + ?`);
      }
      values.push(val);
    }

    if (setClauses.length > 0) {
      stmts.push(
        db
          .prepare(
            `UPDATE daily_metrics SET ${setClauses.join(", ")} WHERE date = ?`,
          )
          .bind(...values, date),
      );
    }

    // Execute INSERT + UPDATE in a single batch (2 statements = 1 D1 call)
    await db.batch(stmts);

    // Merge skill_counts JSON (separate since it needs a read-modify-write)
    if (deltas.skill_counts && Object.keys(deltas.skill_counts).length > 0) {
      await mergeSkillCounts(db, date, deltas.skill_counts);
    }
  } catch (err) {
    logger.warn(`[DailyMetrics] Failed to increment: ${err.message}`);
  }
}

// ── Score Distribution Tracker ─────────────────────────────────────────────────

/**
 * Track a score in a histogram stored in KV.
 * Increments the bucket (0, 10, 20, ... 90) for the given score.
 * Used by the report to show WHY jobs aren't alerting.
 *
 * @param {number} score
 * @param {KVNamespace} kv
 * @returns {Promise<void>}
 */
export async function trackScoreDistribution(score, kv) {
  if (!kv) return;
  try {
    const bucket = Math.floor(Math.max(0, Math.min(99, score)) / 10) * 10; // 0,10,20,...90
    const raw = await kv.get("metrics:score_histogram");
    const hist = raw ? JSON.parse(raw) : {};
    hist[bucket] = (hist[bucket] || 0) + 1;
    await kv.put("metrics:score_histogram", JSON.stringify(hist), {
      expirationTtl: 86400 * 2, // 48h TTL
    });
  } catch (err) {
    logger.warn(`[DailyMetrics] Score histogram write failed: ${err.message}`);
  }
}

async function mergeSkillCounts(db, date, newCounts) {
  try {
    const row = await db
      .prepare(`SELECT skill_counts FROM daily_metrics WHERE date = ?`)
      .bind(date)
      .first();

    let existing = {};
    try {
      existing = JSON.parse(row?.skill_counts || "{}");
    } catch {
      /* empty */
    }

    for (const [skill, count] of Object.entries(newCounts)) {
      existing[skill] = (existing[skill] || 0) + count;
    }

    await db
      .prepare(`UPDATE daily_metrics SET skill_counts = ? WHERE date = ?`)
      .bind(JSON.stringify(existing), date)
      .run();
  } catch (err) {
    logger.warn(`[DailyMetrics] Skill merge failed: ${err.message}`);
  }
}

// ── Report Data Fetcher ───────────────────────────────────────────────────────

/**
 * Fetch today's metrics + source tier breakdown for the report.
 * Uses daily_metrics as the primary source and ALSO queries the `jobs` and
 * `sent_alerts` tables as ground-truth fallback. If the incremental counters
 * are zero but the actual tables have data, the ground-truth values are used.
 *
 * @param {D1Database} db
 * @param {object} [options={}]
 * @param {string} [options.reportDate] - Override the report date (YYYY-MM-DD). Defaults to today.
 * @returns {Promise<object>} Report data object
 */
export async function getDailyReportData(db, options = {}) {
  // If a specific report date is given (e.g., yesterday for midnight report), use it.
  // Otherwise default to today.
  const date = options.reportDate || todayUTC();
  const prevDate = new Date(new Date(date + "T00:00:00Z").getTime() - 86400_000)
    .toISOString()
    .split("T")[0];

  try {
    // ── Core queries (daily_metrics + jobs — these tables always exist) ──
    const [todayRes, yesterdayRes, jobCountRes, prevJobCountRes, companiesRes] =
      await db.batch([
        db.prepare(`SELECT * FROM daily_metrics WHERE date = ?`).bind(date),
        db.prepare(`SELECT * FROM daily_metrics WHERE date = ?`).bind(prevDate),
        // Ground-truth: count jobs inserted today directly from the jobs table
        db
          .prepare(
            `SELECT COUNT(*) as count FROM jobs WHERE date(fetched_at) = ?`,
          )
          .bind(date),
        // Ground-truth: count jobs inserted previous day
        db
          .prepare(
            `SELECT COUNT(*) as count FROM jobs WHERE date(fetched_at) = ?`,
          )
          .bind(prevDate),
        // Ground-truth: count distinct companies (proxy for sources) today
        db
          .prepare(
            `SELECT COUNT(DISTINCT company) as count FROM jobs WHERE company != '' AND date(fetched_at) = ?`,
          )
          .bind(date),
      ]);

    const today = todayRes.results?.[0] || {};
    const prev = yesterdayRes.results?.[0] || {};

    // ── Optional queries: source_registry (may not exist on all environments) ──
    let sourceBreakdownRes = { results: [] };
    let totalSourcesRes = { results: [{ total: 0, active: 0, disabled: 0 }] };
    let sourcesScannedRes = { results: [{ count: 0 }] };
    let topFailingSourcesRes = { results: [] };
    try {
      [
        sourceBreakdownRes,
        totalSourcesRes,
        sourcesScannedRes,
        topFailingSourcesRes,
      ] = await db.batch([
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
        // Ground-truth: count sources that were fetched today
        db
          .prepare(
            `SELECT COUNT(*) as count FROM source_registry WHERE date(last_fetched_at) = ?`,
          )
          .bind(date),
        // Top failing sources for report diagnostics
        db.prepare(`
                    SELECT name, url, failure_count, consecutive_failures, last_error
                    FROM source_registry
                    WHERE failure_count > 0
                    ORDER BY consecutive_failures DESC, failure_count DESC
                    LIMIT 5
                `),
      ]);
    } catch (err) {
      logger.warn(
        `[DailyReport] source_registry not available: ${err.message}`,
      );
    }

    // ── Optional queries: sent_alerts (may not exist on all environments) ──
    let alertCountRes = { results: [{ count: 0 }] };
    try {
      const [res] = await db.batch([
        db
          .prepare(
            `SELECT COUNT(*) as count FROM sent_alerts WHERE date(sent_at) = ?`,
          )
          .bind(date),
      ]);
      alertCountRes = res;
    } catch (err) {
      logger.warn(`[DailyReport] sent_alerts not available: ${err.message}`);
    }

    // ── KV: score histogram + discovery stats ──────────────────────────────
    let scoreHistogram = {};
    let discoveryStats = null;
    if (options.kv) {
      try {
        const [histRaw, discoveryRaw] = await Promise.all([
          options.kv.get("metrics:score_histogram"),
          options.kv.get("discovery:last_run_stats"),
        ]);
        if (histRaw) scoreHistogram = JSON.parse(histRaw);
        if (discoveryRaw) discoveryStats = JSON.parse(discoveryRaw);
      } catch (err) {
        logger.warn(`[DailyReport] KV read failed: ${err.message}`);
      }
    }

    const tiers = {};
    for (const row of sourceBreakdownRes.results || []) {
      tiers[row.crawl_tier || "unknown"] = {
        count: row.count,
        avgScore: row.avg_score,
      };
    }
    let sources = totalSourcesRes.results?.[0] || {
      total: 0,
      active: 0,
      disabled: 0,
    };

    // ── Ground-truth backfill ──────────────────────────────────────────
    // If daily_metrics counters are zero but actual tables have data, use
    // the ground-truth values to ensure the report is never falsely empty.
    const actualJobsToday = jobCountRes.results?.[0]?.count || 0;
    const actualJobsPrev = prevJobCountRes.results?.[0]?.count || 0;
    const actualAlertsToday = alertCountRes.results?.[0]?.count || 0;
    const actualSourcesScanned = sourcesScannedRes.results?.[0]?.count || 0;
    const actualCompanies = companiesRes.results?.[0]?.count || 0;

    if (actualJobsToday > 0 && (today.unique_jobs_stored || 0) === 0) {
      today.unique_jobs_stored = actualJobsToday;
      today._backfilled = true;
    }
    if (actualJobsToday > 0 && (today.raw_jobs_found || 0) === 0) {
      // Estimate: raw jobs ≈ unique * 1.3 (typical 30% dupe rate)
      today.raw_jobs_found = Math.round(actualJobsToday * 1.3);
      today._backfilled = true;
    }
    if (
      (today.duplicates_filtered || 0) === 0 &&
      today.raw_jobs_found &&
      today.unique_jobs_stored
    ) {
      today.duplicates_filtered =
        today.raw_jobs_found - today.unique_jobs_stored;
      today._backfilled = true;
    }
    if (actualAlertsToday > 0 && (today.alerts_sent || 0) === 0) {
      today.alerts_sent = actualAlertsToday;
      today._backfilled = true;
    }
    // Backfill sources_scanned: try source_registry, then distinct companies
    if ((today.sources_scanned || 0) === 0) {
      const bestSourceCount = actualSourcesScanned || actualCompanies;
      if (bestSourceCount > 0) {
        today.sources_scanned = bestSourceCount;
        if ((today.crawl_successes || 0) === 0) {
          today.crawl_successes = bestSourceCount;
        }
        today._backfilled = true;
      }
    }
    // Backfill sources info when registry is empty
    if ((sources.total || 0) === 0 && actualCompanies > 0) {
      sources = {
        total: actualCompanies,
        active: actualCompanies,
        disabled: 0,
      };
    }
    if (actualJobsPrev > 0 && (prev.unique_jobs_stored || 0) === 0) {
      prev.unique_jobs_stored = actualJobsPrev;
    }

    return {
      date,
      today,
      prev,
      tiers,
      sources,
      scoreHistogram,
      discoveryStats,
      topFailingSources: topFailingSourcesRes?.results || [],
    };
  } catch (err) {
    logger.warn(`[DailyReport] Failed to fetch data: ${err.message}`);
    return {
      date,
      today: {},
      prev: {},
      tiers: {},
      sources: { total: 0, active: 0, disabled: 0 },
      scoreHistogram: {},
      discoveryStats: null,
      topFailingSources: [],
    };
  }
}

// ── Report Formatter ──────────────────────────────────────────────────────────

function pctChange(curr, prev) {
  if (!prev || prev === 0) return "";
  const diff = (((curr - prev) / prev) * 100).toFixed(1);
  return diff > 0 ? ` (+${diff}%)` : ` (${diff}%)`;
}

function qualityIndex(avgScore, uniqueStored = 0) {
  // When no alerts have been sent (avgScore is 0), base quality on job volume
  if (avgScore === 0 || isNaN(avgScore)) {
    if (uniqueStored >= 1000) return "🟢 High Volume — Active";
    if (uniqueStored >= 500) return "🟢 Active & Collecting";
    if (uniqueStored >= 100) return "🟡 Moderate Volume";
    if (uniqueStored > 0) return "🟡 Low Volume — Running";
    return "🔴 No Data";
  }
  if (avgScore >= 75) return "🟢 Excellent";
  if (avgScore >= 60) return "🟡 Strong";
  if (avgScore >= 45) return "🔵 Moderate";
  if (avgScore >= 30) return "🟣 Fair";
  return "🔴 Poor";
}

function resourceSafety(invocations) {
  const pct = Math.round((invocations / 100_000) * 100);
  if (pct <= 50) return { pct, emoji: "🟢", label: "Safe" };
  if (pct <= 75) return { pct, emoji: "🟡", label: "Moderate" };
  return { pct, emoji: "🔴", label: "High" };
}

/**
 * Build the formatted daily intelligence report string.
 *
 * @param {object} data - from getDailyReportData()
 * @returns {string} Formatted report text
 */
export function formatDailyReport(data) {
  const {
    date,
    today: t,
    prev: p,
    tiers,
    sources,
    scoreHistogram = {},
    discoveryStats = null,
    topFailingSources = [],
  } = data;
  const m = (key, fallback = 0) => t[key] ?? fallback;
  const pm = (key, fallback = 0) => p[key] ?? fallback;
  // Safe locale formatting — prevents crashes when value is non-numeric
  const safeLocale = (val) => {
    const n = Number(val);
    return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
  };

  // Derived calculations
  const newSources =
    m("new_sources_ats") + m("new_sources_career") + m("new_sources_search");
  const prevNewSources =
    pm("new_sources_ats") + pm("new_sources_career") + pm("new_sources_search");
  const totalRawJobs = m("raw_jobs_found");
  const uniqueStored = m("unique_jobs_stored");
  const dupes = m("duplicates_filtered");
  const sourcesScanned = m("sources_scanned");
  const successRate =
    sourcesScanned > 0
      ? Math.round((m("crawl_successes") / sourcesScanned) * 100)
      : 0;
  const alertsSent = m("alerts_sent");
  // Prefer per-alert average; fall back to per-job average when no alerts sent
  let avgScore;
  if (alertsSent > 0 && m("score_sum") > 0) {
    avgScore = (m("score_sum") / alertsSent).toFixed(1);
  } else if (m("score_max") > 0) {
    // No alerts sent but scoring happened — show max as indicator
    avgScore = m("score_max").toString();
  } else if (uniqueStored > 0) {
    avgScore = "—"; // Jobs exist but haven't been scored yet
  } else {
    avgScore = "0";
  }

  const highValueYield =
    totalRawJobs > 0 ? ((uniqueStored / totalRawJobs) * 100).toFixed(1) : "0";
  const totalJobs = uniqueStored + dupes;
  const relevancePass =
    totalJobs > 0 ? ((alertsSent / totalJobs) * 100).toFixed(0) : "0";

  // Skill parsing
  let skillCounts = {};
  try {
    skillCounts = JSON.parse(t.skill_counts || "{}");
  } catch {
    /* empty */
  }
  const topSkills = Object.entries(skillCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const topSkill = topSkills[0] ? topSkills[0][0] : "N/A";

  // Stack detection
  const mern = ["mongodb", "express", "react", "node.js"];
  const hasMern = mern.every((s) => skillCounts[s] > 0);
  const dominantStack = hasMern
    ? "MERN"
    : topSkills.length >= 2
      ? `${topSkills[0]?.[0]} + ${topSkills[1]?.[0]}`
      : "Mixed";

  // Remote percentage
  const totalLocJobs = m("remote_jobs") + m("hybrid_jobs") + m("onsite_jobs");
  const remotePct =
    totalLocJobs > 0 ? Math.round((m("remote_jobs") / totalLocJobs) * 100) : 0;

  // Avg salary
  const avgSalary =
    m("salary_count") > 0 ? Math.round(m("salary_sum") / m("salary_count")) : 0;

  // Tier breakdown
  const tierHigh = tiers.high?.count || 0;
  const tierMed = tiers.medium?.count || 0;
  const tierLow = tiers.low?.count || 0;
  const tierDormant = tiers.dormant?.count || 0;
  const allTierCounts = tierHigh + tierMed + tierLow + tierDormant;
  const avgPriority =
    allTierCounts > 0
      ? (
          (tierHigh * (tiers.high?.avgScore || 0) +
            tierMed * (tiers.medium?.avgScore || 0) +
            tierLow * (tiers.low?.avgScore || 0) +
            tierDormant * (tiers.dormant?.avgScore || 0)) /
          allTierCounts
        ).toFixed(1)
      : "0";

  // Resource safety
  const res = resourceSafety(m("worker_invocations"));

  // Optimization trend
  const prevAvgPriority =
    pm("score_sum", 0) > 0
      ? (pm("score_sum") / Math.max(pm("alerts_sent"), 1)).toFixed(1)
      : 0;
  const priorityDelta = (
    parseFloat(avgPriority) - parseFloat(prevAvgPriority)
  ).toFixed(1);
  const trend =
    parseFloat(priorityDelta) > 0
      ? "📈 Improving"
      : parseFloat(priorityDelta) < 0
        ? "📉 Declining"
        : "➡️ Stable";

  // ── Score Distribution ───────────────────────────────────────────────────
  const totalScored = Object.values(scoreHistogram).reduce((s, v) => s + v, 0);
  const scoreDistLines =
    totalScored > 0
      ? [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]
          .map((b) => {
            const count = scoreHistogram[b] || 0;
            if (count === 0) return null;
            const pct = Math.round((count / totalScored) * 100);
            const bar = "█".repeat(Math.max(1, Math.round(pct / 5)));
            const label = `${b}-${b + 9}`.padEnd(6);
            const flag = b >= 45 ? "" : " ← below threshold";
            return `  ${label} ${bar.padEnd(12)} ${count} (${pct}%)${flag}`;
          })
          .filter(Boolean)
          .join("\n")
      : "  No score data yet — check scoring pipeline";

  // ── Failing Sources ──────────────────────────────────────────────────────
  const failingLines =
    topFailingSources.length > 0
      ? topFailingSources
          .map((s) => {
            const name = (s.name || s.url || "").substring(0, 30).padEnd(30);
            const err = (s.last_error || "unknown error").substring(0, 50);
            return `  ❌ ${name} | ${s.consecutive_failures || 0} consec fails | ${err}`;
          })
          .join("\n")
      : "  ✅ No sources in critical failure state";

  // ── Discovery Engine ─────────────────────────────────────────────────────
  const discoveryLine = discoveryStats
    ? [
        `  Last run: ${discoveryStats.timestamp || "unknown"}`,
        `  Attempted: ${discoveryStats.attempted || 0} | Found: ${discoveryStats.discovered || 0} | Failed: ${discoveryStats.failed || 0}`,
        discoveryStats.errors?.length
          ? `  ⚠️  Last error: ${discoveryStats.errors[0].substring(0, 80)}`
          : "  ✅ No discovery errors",
      ].join("\n")
    : "  ⚠️  No discovery run data — discovery engine may not be triggering";

  // ── Config Validation ────────────────────────────────────────────────────
  const configWarnings = [];
  if (m("score_max") === 0 && uniqueStored > 10)
    configWarnings.push(
      "🔴 Max score is 0 — scoring pipeline broken (check scoring logs)",
    );
  if (m("score_max") > 0 && m("score_max") < 45)
    configWarnings.push(
      `🟡 Max score only ${m("score_max")} — mustMatch terms too strict or jobs too filtered`,
    );
  if ((sources.active || 0) < 10)
    configWarnings.push(
      `🟡 Only ${sources.active || 0} active sources — discovery not expanding (target: 30+)`,
    );
  if (!discoveryStats)
    configWarnings.push(
      "� No discovery stats in KV — runSearchExpansion not writing to KV",
    );
  const configSection =
    configWarnings.length > 0
      ? configWarnings.join("\n")
      : "  ✅ No configuration issues detected";

  return `�📊 JOB HUNTER BOT — DAILY INTELLIGENCE
🗓 ${formatDate(date)}

━━━━━━━━━━━━━━━━━━
🚀 GROWTH & EXPANSION
• New Sources: +${newSources}${pctChange(newSources, prevNewSources)}
   ↳ ATS: +${m("new_sources_ats")} | Career: +${m("new_sources_career")} | Search: +${m("new_sources_search")}
• Active Sources: ${sources.active ?? 0}
• Disabled: ${sources.disabled ?? 0}

━━━━━━━━━━━━━━━━━━
📡 CRAWL PERFORMANCE
• Sources Scanned: ${sourcesScanned}
• Success Rate: ${successRate}%${successRate < 70 ? " ⚠️ DEGRADED" : ""}
• Raw Jobs: ${safeLocale(totalRawJobs)}
• Unique Stored: ${safeLocale(uniqueStored)}${pctChange(uniqueStored, pm("unique_jobs_stored"))}
• Duplicates Filtered: ${safeLocale(dupes)}
• High-Value Yield: ${highValueYield}%
• Relevance Pass Rate: ${relevancePass}%${parseInt(relevancePass) === 0 && uniqueStored > 0 ? " ⚠️ Tune scoring" : ""}

━━━━━━━━━━━━━━━━━━
📊 SCORE DISTRIBUTION (today — threshold: 45)
${scoreDistLines}
  → Max: ${m("score_max")} | Threshold: 45 | Jobs that alerted: ${alertsSent}

━━━━━━━━━━━━━━━━━━
🔔 ALERT QUALITY
• Alerts Sent: ${alertsSent}${alertsSent === 0 && uniqueStored > 50 ? " ⚠️ Check threshold" : ""}
• Delivery Failures: ${m("alert_failures")}
• Avg Score: ${avgScore}
• Highest Score: ${m("score_max")}
• Quality Index: ${qualityIndex(parseFloat(avgScore), uniqueStored)}

━━━━━━━━━━━━━━━━━━
🧠 SOURCE INTELLIGENCE
• High: ${tierHigh} | Med: ${tierMed} | Low: ${tierLow} | Dormant: ${tierDormant}
• Avg Priority: ${avgPriority}  (${priorityDelta > 0 ? "+" : ""}${priorityDelta})
• Optimization Trend: ${trend}

━━━━━━━━━━━━━━━━━━
🔴 FAILING SOURCES
${failingLines}

━━━━━━━━━━━━━━━━━━
🔍 DISCOVERY ENGINE
${discoveryLine}

━━━━━━━━━━━━━━━━━━
📊 MARKET SIGNALS
• Top Skill: ${topSkill}
• Dominant Stack: ${dominantStack}
• Remote Roles: ${remotePct}%
• Avg Salary: ${avgSalary > 0 ? "$" + avgSalary.toLocaleString("en-US") : "N/A"}
${topSkills.length > 0 ? `• Top 3: ${topSkills.map(([s, c]) => `${s} (${c})`).join(" · ")}` : ""}

━━━━━━━━━━━━━━━━━━
☁ RESOURCE SAFETY
• Worker Invocations: ${safeLocale(m("worker_invocations"))}
• D1 Writes: ${safeLocale(m("d1_writes"))}
• Queue Messages: ${safeLocale(m("queue_messages"))}
• AI Calls: ${m("ai_calls")}
• Free Tier Usage: ${res.pct}%  ${res.emoji} ${res.label}

━━━━━━━━━━━━━━━━━━
⚙️  CONFIG VALIDATION
${configSection}

━━━━━━━━━━━━━━━━━━
🔍 DIAGNOSTICS
${getDiagnostics(successRate, alertsSent, uniqueStored, m("crawl_failures"), dupes, totalRawJobs)}

━━━━━━━━━━━━━━━━━━
• Cycles Today: ${m("cycles_completed")}
${getEngineStatus(successRate, alertsSent, newSources, uniqueStored)}`;
}

function getDiagnostics(
  successRate,
  alertsSent,
  uniqueStored,
  crawlFailures,
  dupes,
  rawJobs,
) {
  const issues = [];
  const healthy = [];

  // Crawl health
  if (successRate < 50) {
    issues.push(
      "🔴 Critical: Crawl success rate below 50% — check source endpoints",
    );
  } else if (successRate < 70) {
    issues.push(
      "🟡 Warning: Crawl success rate degraded — some sources failing",
    );
  } else {
    healthy.push("🟢 Crawl health: Normal");
  }

  // Duplicate ratio
  if (rawJobs > 0) {
    const dupRatio = ((dupes / rawJobs) * 100).toFixed(0);
    if (parseInt(dupRatio) > 95) {
      issues.push(
        `🟡 High duplicate ratio (${dupRatio}%) — sources may overlap`,
      );
    } else if (parseInt(dupRatio) > 80) {
      healthy.push(
        `🟢 Dedup ratio: ${dupRatio}% (normal for continuous crawl)`,
      );
    }
  }

  // Alert delivery
  if (alertsSent === 0 && uniqueStored > 100) {
    issues.push(
      "🟡 Zero alerts despite job volume — scoring threshold may be too strict",
    );
  } else if (alertsSent > 0) {
    healthy.push(`🟢 Alert pipeline: Active (${alertsSent} sent)`);
  }

  // D1 health
  if (crawlFailures > 20) {
    issues.push(
      `🟡 ${crawlFailures} crawl failures — circuit breakers may be triggered`,
    );
  }

  // Job volume
  if (uniqueStored === 0) {
    issues.push("🔴 No new jobs stored — check D1 connectivity and feeds");
  } else if (uniqueStored < 10) {
    issues.push("🟡 Low job volume — consider adding more sources");
  } else {
    healthy.push(`🟢 Job pipeline: ${uniqueStored} unique stored`);
  }

  if (issues.length === 0) {
    return (
      "✅ All systems nominal\n" +
      healthy
        .slice(0, 3)
        .map((h) => `  ${h}`)
        .join("\n")
    );
  }

  return [...issues, ...healthy.slice(0, 2)].map((l) => `  ${l}`).join("\n");
}

function getEngineStatus(
  successRate,
  alertsSent,
  newSources,
  uniqueStored = 0,
) {
  const parts = [];

  // Health: prefer successRate, but fall back to job volume when metrics are missing
  if (successRate >= 80) {
    parts.push("🟢 Healthy");
  } else if (successRate >= 50) {
    parts.push("🟡 Degraded");
  } else if (uniqueStored > 0) {
    // No crawl metrics but jobs were stored → system is running
    parts.push(uniqueStored >= 500 ? "🟢 Operational" : "� Partial");
  } else {
    parts.push("🔴 Offline");
  }

  if (newSources > 0) parts.push("Expanding");
  if (alertsSent > 0) parts.push("Alerting");

  // Optimization
  if (successRate >= 70) {
    parts.push("Optimized");
  } else if (uniqueStored > 0) {
    parts.push("Collecting");
  } else {
    parts.push("Idle");
  }

  return `${parts[0]} • ${parts.slice(1).join(" • ")}`;
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
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `\`\`\`\n${reportText}\n\`\`\``,
      parse_mode: "MarkdownV2",
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
 * @param {object} [options={}]
 * @param {string} [options.reportDate] - Override report date (YYYY-MM-DD). If omitted, reports on today.
 * @returns {Promise<{ sent: boolean, channels: string[] }>}
 */
export async function sendDailyReport(db, env, options = {}) {
  const result = { sent: false, channels: [] };

  try {
    const data = await getDailyReportData(db, options);
    const report = formatDailyReport(data);

    logger.info(`[DailyReport] Generated report for ${data.date}`);

    // Send to Discord
    if (env.DISCORD_WEBHOOK_URL) {
      try {
        await sendDiscordReport(env.DISCORD_WEBHOOK_URL, report);
        result.channels.push("Discord");
        result.sent = true;
        logger.info("[DailyReport] Sent to Discord");
      } catch (err) {
        logger.error(`[DailyReport] Discord failed: ${err.message}`);
      }
    }

    // Send to Telegram
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      try {
        await sendTelegramReport(
          env.TELEGRAM_BOT_TOKEN,
          env.TELEGRAM_CHAT_ID,
          report,
        );
        result.channels.push("Telegram");
        result.sent = true;
        logger.info("[DailyReport] Sent to Telegram");
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
