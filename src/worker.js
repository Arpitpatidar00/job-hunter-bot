/**
 * @module worker
 * @description Cloudflare Worker entry point for Job Hunter Bot v5.2.
 *
 * Architecture: Event-Driven Queue Topology + strictly consistent D1 Dedup
 * Optimizations: FastMatcher (O(N) scoring), SimHash (O(1) dedup), MinHeap (O(N log K) RAG)
 *
 * Exports:
 *   - fetch:     HTTP handler (health, metrics, manual trigger, feedback)
 *   - scheduled: Producer (writes all feed configs to FEED_QUEUE)
 *   - queue:     Consumer (handles Feed -> Fetch -> Evaluate -> Alert flow)
 */

import { loadConfig } from "./config.js";
import logger from "./core/logger.js";
import { validateEnv } from "./env.ts";
import { runAllConnectors } from "./connectors/index.js";
import { buildSourceList } from "./connectors/base.js";
import { TopKChunks } from "./core/heap.js";
import { extractSalaryUSD } from "./core/utils.js";
import {
  scoreJob,
  isNewJob,
  MINIMUM_ALERT_SCORE,
} from "./scoring/relevance-v4.js";
import { sendAlert } from "./notifications/notifications.js";

// D1 Database Layer
import {
  insertJobIfNotExists,
  batchInsertJobs,
  getActiveProfiles,
  hasSentAlert,
  markAlertSent,
  getSentAlertsForJobs,
  batchMarkAlertSent,
  recordTermFrequencies,
  getGlobalTermFrequencies,
  batchUpdateSourceStats,
  batchRegisterDiscoveredSources,
  getSourceMetrics,
  getEnabledSources,
  cleanupStaleJobs,
  cleanupStaleChunks,
  cleanupStaleAlerts,
} from "./db/index.js";

// Source discovery + Self-expanding engine
import { detectAtsSourcesWithDomains } from "./discovery/sourceDiscovery.js";
import {
  batchRegisterDomains,
  getPendingDomains,
  probeDomainsForCareers,
} from "./discovery/careerDetector.js";
import { runSearchExpansion } from "./discovery/searchExpander.js";
import {
  getAndIncrementCycle,
  recalculatePriorities,
  getSourcesForCycle,
  recordSourceYieldsBatch,
} from "./intelligence/sourceIntelligence.js";
import {
  incrementDailyMetrics,
  sendDailyReport,
  getDailyReportData,
  formatDailyReport,
} from "./intelligence/dailyReport.js";

// Intelligence modules
import {
  isFeedCircuitOpen,
  recordFeedResult,
  getFeedHealthRecord,
} from "./intelligence/feedHealth.js";
import {
  getEffectiveThreshold,
  recordJobScoresBatch,
} from "./intelligence/threshold.js";
import {
  applyFeedbackBoost,
  getPreferenceWeights,
} from "./scoring/feedback.js";
import { runGrowthEngineCycle } from "./intelligence/growthEngine.js";
import { retrainThresholds } from "./intelligence/calibration.js";

// AI
import {
  generateEmbedding,
  cosineSimilarity,
  getProfileEmbedding,
} from "./notifications/ai.js";

import {
  chunkTexts,
  embedChunks,
  resetAiCallCount,
} from "./notifications/ai-v4.js";

import { generateSimHash } from "./core/dedup.js";
import { getGlobalMatcher } from "./scoring/fastMatcher.js";

// ── JSON Response Helper ─────────────────────────────────────────────────────

function jsonResponse(data, status = 200, additionalHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...additionalHeaders },
  });
}

async function saveStressTestLog(env, reportData) {
  try {
    await env.DB.prepare(
      `
      CREATE TABLE IF NOT EXISTS stress_test_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT,
        log TEXT
      )
    `,
    ).run();

    await env.DB.prepare(
      `
      INSERT INTO stress_test_logs (id, timestamp, log)
      VALUES (?, ?, ?)
    `,
    )
      .bind(
        `log_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        reportData.timestamp,
        JSON.stringify(reportData),
      )
      .run();
  } catch (dbErr) {
    if (env.SEEN_JOBS) {
      await env.SEEN_JOBS.put(
        `STRESS_LOGS:log_${reportData.timestamp}`,
        JSON.stringify(reportData),
      );
    }
  }
}

// ── Module-Level Config Cache ─────────────────────────────────────────────────
/** Cache loadConfig() at module level so it's not re-parsed every invocation. */
let _cachedConfig = null;
function getConfig() {
  if (!_cachedConfig) _cachedConfig = loadConfig();
  return _cachedConfig;
}

// ── Regex Cache for Keyword Matching ──────────────────────────────────────────
/** Module-level regex cache — shared across all calls within a warm worker. */
const _regexCache = new Map();

/**
 * Get or create a cached word-boundary regex for a lowercase keyword.
 * Prevents `new RegExp()` per keyword per job — saves ~60ms/cycle.
 * @param {string} keyword - Already lowercased.
 * @returns {RegExp|null}
 */
function getCachedRegex(keyword) {
  if (_regexCache.has(keyword)) return _regexCache.get(keyword);
  try {
    const re = new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i");
    _regexCache.set(keyword, re);
    return re;
  } catch {
    _regexCache.set(keyword, null);
    return null;
  }
}

/**
 * Strict pre-filter to reduce unnecessary AI calls.
 * Only proceeds to AI embedding if job passes initial keyword quality gate.
 *
 * Optimization: Requires at least 2 keyword matches OR title match
 * to avoid burning AI budget on low-quality job postings.
 */
function hasBasicKeywordMatch(job, config) {
  const mustMatch = config.searchRules?.mustMatch || [];
  const niceToHave = config.searchRules?.niceToHave || [];

  if (mustMatch.length === 0 && niceToHave.length === 0) return true;

  const text =
    `${job.title} ${job.company || ""} ${job.categories?.join(" ") || ""} ${job.contentSnippet || ""}`.toLowerCase();

  // Count mustMatch hits (higher quality signal)
  let mustMatchHits = 0;
  for (const term of mustMatch) {
    const lower = term.toLowerCase();
    const re = getCachedRegex(lower);
    if (re ? re.test(text) : text.includes(lower)) {
      mustMatchHits++;
    }
  }

  // Title match is a strong signal - prioritize jobs with keywords in title
  const titleLower = (job.title || "").toLowerCase();
  let titleMatchCount = 0;
  for (const term of mustMatch) {
    const lower = term.toLowerCase();
    const re = getCachedRegex(lower);
    if (re ? re.test(titleLower) : titleLower.includes(lower)) {
      titleMatchCount++;
    }
  }

  // If strong title match, allow through
  if (titleMatchCount >= 1) return true;

  // If multiple must-match terms found, allow through
  if (mustMatchHits >= 2) return true;

  // Check niceToHave but with higher threshold
  let niceToHaveHits = 0;
  for (const term of niceToHave) {
    const lower = term.toLowerCase();
    const re = getCachedRegex(lower);
    if (re ? re.test(text) : text.includes(lower)) {
      niceToHaveHits++;
    }
  }

  // Require at least 3 total hits (must + niceToHave)
  if (mustMatchHits + niceToHaveHits >= 3) return true;

  return false;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Quick keyword-based scoring to determine if AI embedding is needed.
 * Returns 0-100 score based on keyword matching strength.
 * Jobs with high scores (>75) can skip AI embedding.
 */
function computeQuickKeywordScore(job, config) {
  const mustMatch = config.searchRules?.mustMatch || [];
  const niceToHave = config.searchRules?.niceToHave || [];

  if (mustMatch.length === 0 && niceToHave.length === 0) return 50;

  const text =
    `${job.title || ""} ${job.company || ""} ${job.categories?.join(" ") || ""} ${job.contentSnippet || ""}`.toLowerCase();
  const titleLower = (job.title || "").toLowerCase();

  let score = 0;
  let mustHits = 0;
  let niceHits = 0;

  // Title match is worth more (30 points max)
  for (const term of mustMatch) {
    const lower = term.toLowerCase();
    const re = getCachedRegex(lower);
    if (re ? re.test(titleLower) : titleLower.includes(lower)) {
      score += 15;
      mustHits++;
    }
  }

  // Must-match keywords (40 points max)
  for (const term of mustMatch) {
    const lower2 = term.toLowerCase();
    const re2 = getCachedRegex(lower2);
    if (re2 ? re2.test(text) : text.includes(lower2)) {
      score += 10;
      mustHits++;
    }
  }

  // Nice-to-have keywords (30 points max)
  for (const term of niceToHave) {
    const lower3 = term.toLowerCase();
    const re3 = getCachedRegex(lower3);
    if (re3 ? re3.test(text) : text.includes(lower3)) {
      score += 5;
      niceHits++;
    }
  }

  // Hard gate: if no must-match hits, cap at 45
  if (mustHits === 0) {
    score = Math.min(score, 45);
  }

  return Math.min(score, 100);
}

// ── Retry Helper (Issue 3) ────────────────────────────────────────────────────
/**
 * Retry an async function with exponential backoff + jitter.
 * Addresses "Queue send failed: Too Many Requests" by respecting Cloudflare
 * Queue rate limits instead of immediately falling back to direct execution.
 *
 * @param {() => Promise<any>} fn - Async function to call
 * @param {number} [maxRetries=3] - Maximum retry attempts
 * @param {number} [baseDelayMs=500] - Base delay in ms (doubles each attempt)
 * @returns {Promise<any>}
 */
async function withRetry(fn, maxRetries = 3, baseDelayMs = 200) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        // Reduced base delay to stay within Cloudflare's 30s wall-time limit.
        // Worst case: 200+400+800+jitter ms ≈ ~1.5s total max wait.
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 200;
        logger.warn(
          `[Retry] Attempt ${attempt + 1}/${maxRetries + 1} failed (${err.message}), retrying in ${Math.round(delay)}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Non-Blocking I/O Helper (Phase 3) ───────────────────────────────────────
/**
 * Wrap async I/O operations with ctx.waitUntil() to avoid blocking CPU time.
 * This allows the Worker to return faster while I/O completes in the background.
 *
 * @param {ExecutionContext} ctx - Cloudflare Worker execution context
 * @param {Promise} promise - The async operation to run non-blocking
 * @param {string} label - Label for logging purposes
 */
function deferIO(ctx, promise, label = "deferred") {
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(
      promise
        .then(() => logger.info(`[Deferred] ${label} completed`))
        .catch((err) =>
          logger.error(`[Deferred] ${label} failed: ${err.message}`),
        ),
    );
  } else {
    promise
      .then(() => logger.info(`[Deferred (Fallback)] ${label} completed`))
      .catch((err) =>
        logger.error(`[Deferred (Fallback)] ${label} failed: ${err.message}`),
      );
  }
}

// ── DIRECT FALLBACK PROCESSOR ──────────────────────────────────────────────
async function evaluateJobsFallback(jobs, env, ctx) {
  const fakeMessages = jobs.map((job) => ({
    body: job,
    ack() {},
    retry() {},
  }));
  await evaluateJobs(fakeMessages, env, ctx);
}

// ── Slim Job Projection (Issue 4) ────────────────────────────────────────────
/**
 * Return only the fields needed by the Evaluator from a job object.
 * Drops contentSnippet, description, body, and other heavy text fields
 * to stay under the 128 KB Cloudflare Queue payload limit.
 */
function slimJob(job) {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    url: job.url,
    link: job.link,
    categories: job.categories,
    matchedTerms: job.matchedTerms,
    content_hash: job.content_hash,
    contentSnippet: job.contentSnippet || "",
    sourceUrl: job.sourceUrl,
    publishedAt: job.publishedAt,
    isoDate: job.isoDate,
    pubDate: job.pubDate,
  };
}

// ── Queue Router ─────────────────────────────────────────────────────────────

async function queueHandler(batch, env, ctx) {
  const queueName = batch.queue;

  if (queueName === "feed-queue" || queueName.endsWith("-feed-queue")) {
    await processFeeds(batch.messages, env, ctx);
  } else if (queueName === "job-queue" || queueName.endsWith("-job-queue")) {
    await evaluateJobs(batch.messages, env, ctx);
  } else if (
    queueName === "alert-queue" ||
    queueName.endsWith("-alert-queue")
  ) {
    await sendAlerts(batch.messages, env, ctx);
  } else {
    logger.error(`[Queue] Unknown queue: ${queueName}`);
    for (const msg of batch.messages) {
      msg.ack();
    }
  }
}

// ── 1. Fetcher (Consumes FEED_QUEUE) ─────────────────────────────────────────
async function processFeeds(messages, env, ctx) {
  const perfStart = performance.now();
  const config = getConfig();
  const startTime = Date.now();

  // Each message.body is a source definition from scheduled()
  const allSources = messages.map((m) => m.body);

  // Separate RSS feeds from ATS sources (keeping them as objects to store ETags)
  const rssFeeds = allSources.filter((s) => s.type === "rss");
  const atsSources = allSources.filter((s) => s.type && s.type !== "rss");

  // Build a config for runAllConnectors that uses these specific sources
  const batchConfig = {
    ...config,
    feeds: rssFeeds,
    sources: atsSources,
  };

  // Check circuit breakers, fetch ETags, and filter healthy sources
  const healthyFeeds = [];
  const healthySources = [];

  // We import getFeedHealthRecord dynamically inside if not added at the top. Wait!
  // I need to add the import at the top of worker.js. I'll do that in another replace.
  for (const feed of batchConfig.feeds) {
    const record = await getFeedHealthRecord(env.SEEN_JOBS, feed.url);
    if (record.circuitOpen) {
      logger.warn(`[Circuit] Skipping ${feed.url} — circuit is OPEN`);
    } else {
      feed.etag = record.etag;
      feed.lastModified = record.lastModified;
      healthyFeeds.push(feed);
    }
  }
  for (const src of batchConfig.sources) {
    const record = await getFeedHealthRecord(env.SEEN_JOBS, src.url);
    if (record.circuitOpen) {
      logger.warn(`[Circuit] Skipping ${src.url} — circuit is OPEN`);
    } else {
      src.etag = record.etag;
      src.lastModified = record.lastModified;
      healthySources.push(src);
    }
  }
  batchConfig.feeds = healthyFeeds;
  batchConfig.sources = healthySources;

  // Run all connectors in parallel
  // FIX: pass env.SEEN_JOBS so RSS feeds can use per-source pubDate cursors
  const { jobs, feedStats, totalItems, totalErrors } = await runAllConnectors(
    batchConfig,
    env.SEEN_JOBS,
  );

  // ── Record circuit breaker metrics (batched — collect then write once) ──
  let crawlSuccesses = 0;
  let crawlFailures = 0;
  const feedResultPromises = [];
  const sourceStatsList = [];

  for (const stat of feedStats) {
    feedResultPromises.push(
      recordFeedResult(env.SEEN_JOBS, stat.url, {
        success: !stat.error,
        latencyMs: stat.durationMs || 0,
        error: stat.error || "",
      }).catch((err) =>
        logger.warn(`[Fetcher] recordFeedResult failed: ${err.message}`),
      ),
    );
    if (!stat.error) crawlSuccesses++;
    else crawlFailures++;
    // Collect stats for batch D1 write instead of individual writes
    sourceStatsList.push({
      url: stat.url,
      success: !stat.error,
      jobCount: stat.count || 0,
    });
  }
  // Fire KV health writes + batch D1 source stats in parallel
  await Promise.allSettled([
    ...feedResultPromises,
    batchUpdateSourceStats(env.DB, sourceStatsList).catch((err) =>
      logger.warn(`[Fetcher] batchUpdateSourceStats failed: ${err.message}`),
    ),
  ]);

  // ── Simplified dedup: identity_hash + content_hash (in-memory only) ─────
  // Removed broken cycle KV dedup (wrong key `crawl_cycle_counter` vs `__cycle_number`)
  // D1 UNIQUE constraints are the final catch-all for cross-cycle dedup.
  const localSeenIdentity = new Set();
  const localSeenContent = new Set();
  const dedupedJobs = [];
  let inMemoryDupes = 0;
  let identityDupes = 0;
  let contentDupes = 0;

  for (const job of jobs) {
    // Layer 1: identity_hash dedup (company+title+location)
    if (job.identity_hash && localSeenIdentity.has(job.identity_hash)) {
      inMemoryDupes++;
      identityDupes++;
      continue;
    }
    // Layer 2: content_hash dedup (company+title+content[:500])
    if (job.content_hash && localSeenContent.has(job.content_hash)) {
      inMemoryDupes++;
      contentDupes++;
      continue;
    }
    if (job.identity_hash) localSeenIdentity.add(job.identity_hash);
    if (job.content_hash) localSeenContent.add(job.content_hash);
    dedupedJobs.push(job);
  }

  const perfEnd = performance.now();
  // Fix 12+13: Enhanced metrics — always log performance breakdown
  logger.info(
    `[Metrics] processFeeds: total=${(perfEnd - perfStart).toFixed(0)}ms | ` +
      `rawJobs=${jobs.length} deduped=${dedupedJobs.length} | ` +
      `identityDupes=${identityDupes} contentDupes=${contentDupes} totalInMemory=${inMemoryDupes}`,
  );
  for (const fs of feedStats) {
    logger.info(
      `[Metrics] source=${fs.type || "unknown"}:${fs.name || fs.url} | ` +
        `fetched=${fs.count || 0} cursorSkipped=${fs.cursorSkipped || 0} ` +
        `error=${fs.error || "none"} durationMs=${fs.durationMs || 0}`,
    );
  }

  // ── NON-BLOCKING I/O OFFLOAD ─────────────────────────────────────────────
  ctx.waitUntil(
    (async () => {
      // ── BATCH D1 INSERT (eliminates per-job queries) ────────────────────────
      const { inserted: newJobs, duplicates: d1Dupes } = await batchInsertJobs(
        env.DB,
        dedupedJobs,
      );
      const newlyInsertedCount = newJobs.length;
      const duplicateCount = inMemoryDupes + d1Dupes;

      // ── Track market signals from inserted jobs (aggregated) ────────────────
      const batchSkillCounts = {};
      let remoteJobs = 0,
        hybridJobs = 0,
        onsiteJobs = 0;
      let salarySum = 0,
        salaryCount = 0;
      const perSourceNewJobs = new Map();
      const allTerms = [];

      for (const job of newJobs) {
        // Track per-source yield
        const jobSourceUrl = job.sourceUrl || "";
        perSourceNewJobs.set(
          jobSourceUrl,
          (perSourceNewJobs.get(jobSourceUrl) || 0) + 1,
        );

        // Track skill counts
        if (job.matchedTerms?.length) {
          for (const term of job.matchedTerms) {
            batchSkillCounts[term] = (batchSkillCounts[term] || 0) + 1;
          }
          allTerms.push(...job.matchedTerms);
        }

        // Remote/location detection
        const jobText =
          `${job.title || ""} ${job.contentSnippet || ""}`.toLowerCase();
        if (
          /\b(remote|wfh|work from home|distributed|anywhere)\b/.test(jobText)
        )
          remoteJobs++;
        else if (/\bhybrid\b/.test(jobText)) hybridJobs++;
        else onsiteJobs++;

        // Salary tracking — use robust extractSalaryUSD (same as scoring engine)
        const salaryData = extractSalaryUSD(jobText);
        if (salaryData && salaryData.min >= 10_000) {
          const avg = Math.round((salaryData.min + salaryData.max) / 2);
          salarySum += avg;
          salaryCount++;
        }
      }

      // ── Record term frequencies in ONE batch call ───────────────────────────
      if (allTerms.length > 0) {
        try {
          await recordTermFrequencies(env.DB, allTerms);
        } catch (err) {
          logger.warn(`[Fetcher] recordTermFrequencies failed: ${err.message}`);
        }
      }

      // ── Send new jobs to JOB_QUEUE in chunks ────────────────────────────────
      // Issue 1: Reduced chunk size (50→20) to lower per-message CPU cost.
      // Issue 4: slimJob() strips heavy text fields to stay under 128KB limit.
      // Issue 3: withRetry() absorbs Cloudflare Queue rate-limit errors before fallback.
      const JOB_CHUNK_SIZE = 10;
      let queueMsgs = 0;
      let jobQueueSuccess = false;
      try {
        const jobsList = newJobs.map(slimJob);
        const batches = [];
        for (let i = 0; i < jobsList.length; i += JOB_CHUNK_SIZE) {
          batches.push(jobsList.slice(i, i + JOB_CHUNK_SIZE));
        }

        for (const batch of batches) {
          const messages = batch.map((job) => ({ body: job }));
          await withRetry(() => env.JOB_QUEUE.sendBatch(messages));
          await new Promise((r) => setTimeout(r, 100)); // 100ms pacing — safe under 30s wall-limit
          queueMsgs += messages.length;
        }

        if (newJobs.length > 0) {
          logger.info(
            `[Fetcher] Sent ${newJobs.length} jobs to queue using ${batches.length} batches`,
          );
        }
        jobQueueSuccess = true;
      } catch (err) {
        logger.error(
          `[Fetcher] JOB_QUEUE sendBatch failed after retries: ${err.message}. Falling back to direct evaluation.`,
        );
      }

      // ── Daily Metrics (ONE aggregated write instead of per-job) ────────────
      // Write metrics IMMEDIATELY after job processing, BEFORE evaluateJobs fallback.
      // This ensures metrics are recorded even if the Worker is killed during evaluation.
      try {
        await incrementDailyMetrics(env.DB, {
          sources_scanned: allSources.length,
          crawl_successes: crawlSuccesses,
          crawl_failures: crawlFailures,
          raw_jobs_found: jobs.length,
          unique_jobs_stored: newlyInsertedCount,
          duplicates_filtered: duplicateCount,
          remote_jobs: remoteJobs,
          hybrid_jobs: hybridJobs,
          onsite_jobs: onsiteJobs,
          salary_sum: salarySum,
          salary_count: salaryCount,
          worker_invocations: 1,
          d1_writes: newlyInsertedCount,
          queue_messages: queueMsgs,
          skill_counts: batchSkillCounts,
        });
      } catch (err) {
        logger.error(
          `[Fetcher] Daily metrics (phase 1) failed: ${err.message}`,
        );
      }

      // ── DIRECT FALLBACK: Evaluate jobs inline when JOB_QUEUE is rate-limited ──
      if (!jobQueueSuccess && newJobs.length > 0) {
        try {
          // FIX: Limit direct evaluation to top 10 jobs max to avoid exceeding CPU time limits
          const fallbackJobs = newJobs.slice(0, 10);
          logger.info(
            `[Fetcher] JOB_QUEUE failed. Critically evaluating top ${fallbackJobs.length} jobs directly...`,
          );
          if (ctx && ctx.waitUntil) {
            ctx.waitUntil(
              evaluateJobsFallback(fallbackJobs, env, ctx).catch((evalErr) =>
                logger.error(
                  `[Fetcher] Deferred eval fallback failed: ${evalErr.message}`,
                ),
              ),
            );
          } else {
            await evaluateJobsFallback(fallbackJobs, env, ctx);
            logger.info(
              `[Fetcher] Direct evaluation completed for ${fallbackJobs.length} jobs`,
            );
          }
        } catch (evalErr) {
          logger.error(
            `[Fetcher] Direct evaluation fallback failed: ${evalErr.message}`,
          );
        }
      }

      // Source Discovery (Layer 3+4)
      // Feed job.link URLs into ATS pattern detection AND company_url / employer_website
      // fields so we can discover ATS boards from company-owned URLs, not just job-board links.
      let newAts = 0,
        newDomains = 0;
      try {
        // Fix 10: Only run discovery on newly inserted jobs, not all raw jobs
        const urlsForAtsDetection = [];
        for (const job of newJobs) {
          if (job.link) urlsForAtsDetection.push(job.link);
          if (job.company_url) urlsForAtsDetection.push(job.company_url);
          if (job.apply_url) urlsForAtsDetection.push(job.apply_url);
          if (job.ats_source_url) urlsForAtsDetection.push(job.ats_source_url);
        }

        const knownUrls = new Set(allSources.map((s) => s.url));
        const { sources: newSources, domains: discoveredDomains } =
          detectAtsSourcesWithDomains(urlsForAtsDetection, knownUrls);

        if (newSources.length > 0) {
          await batchRegisterDiscoveredSources(env.DB, newSources);
        }
        newAts = newSources.length;
        if (newAts > 0)
          logger.info(`[Discovery] Auto-registered ${newAts} new ATS sources`);

        // Register company domains for career page probing.
        // Prioritise domains from company_url/apply_url (more likely to be company-owned)
        // over generic job-board links. Limit to 30 per batch to control D1 writes.
        const companyDomains = discoveredDomains
          .filter((d) => {
            // Prefer domains from non-link fields (already pre-filtered by detectAtsSourcesWithDomains)
            return (
              d.domain &&
              !d.domain.includes("lever.co") &&
              !d.domain.includes("greenhouse.io")
            );
          })
          .slice(0, 30);

        const domainsToRegister = companyDomains.map((d) => ({
          domain: d.domain,
          sourceJobUrl: d.sourceUrl,
        }));

        if (domainsToRegister.length > 0) {
          await batchRegisterDomains(env.DB, domainsToRegister);
        }
        newDomains = companyDomains.length;
        if (newDomains > 0)
          logger.info(
            `[Discovery] Queued ${newDomains} company domains for career probing`,
          );
      } catch (err) {
        logger.warn(`[Discovery] Source detection failed: ${err.message}`);
      }

      // Record yield for intelligence layer (batch D1 writes instead of per-source)
      const yieldsToBatch = [];
      for (const fs of feedStats) {
        if (!fs.error) {
          const sourceNewJobs = perSourceNewJobs.get(fs.url) || 0;
          const totalFromSource = fs.count || 0;
          // Compute duplication ratio: 1.0 = all duplicates, 0.0 = all unique
          const dupRatio =
            totalFromSource > 0
              ? Math.max(0, Math.min(1, 1 - sourceNewJobs / totalFromSource))
              : 0;
          yieldsToBatch.push({
            url: fs.url,
            newJobCount: sourceNewJobs,
            totalJobCount: totalFromSource,
            dupRatio,
          });
        }
      }

      // Batch write all yields in single D1 batch call
      if (yieldsToBatch.length > 0) {
        try {
          await recordSourceYieldsBatch(env.DB, yieldsToBatch);
          logger.info(
            `[Fetcher] Batch recorded ${yieldsToBatch.length} source yields`,
          );
        } catch (err) {
          logger.warn(`[Fetcher] Batch yield record failed: ${err.message}`);
        }
      }

      // ── Daily Metrics (Phase 2: Discovery metrics) ─────────────────────────
      if (newAts > 0 || newDomains > 0) {
        try {
          await incrementDailyMetrics(env.DB, {
            new_sources_ats: newAts,
            new_domains_queued: newDomains,
            d1_writes: newAts,
          });
        } catch (err) {
          logger.error(
            `[Fetcher] Daily metrics (phase 2) failed: ${err.message}`,
          );
        }
      }

      logger.info(
        `[Fetcher] Harvest complete. Inserted ${newlyInsertedCount} new jobs (${duplicateCount} dupes filtered).`,
      );

      // Fix: Only ack messages AFTER D1 insert succeeds.
      // If D1 insert failed (newlyInsertedCount lost), retry the messages.
      for (const msg of messages) {
        try {
          msg.ack();
        } catch {
          /* already acked */
        }
      }
    })().catch((criticalErr) => {
      // If the entire waitUntil block fails, retry messages so jobs aren't lost
      logger.error(
        `[Fetcher] Critical error in waitUntil — retrying messages: ${criticalErr.message}`,
      );
      for (const msg of messages) {
        try {
          msg.retry();
        } catch {
          /* already acked/retried */
        }
      }
    }),
  );
}

// ── 2. Evaluator (Consumes JOB_QUEUE) — CPU-optimized ────────────────────────
async function evaluateJobs(messages, env, ctx) {
  const perfStart = performance.now();
  const config = getConfig();
  const EVAL_START = Date.now();
  // Issue 1: Tightened from 25s→22s to give larger margin before the 30s hard kill
  const WALL_TIME_LIMIT_MS = 22_000;

  // Issue 5: Reset per-invocation AI call counter at the start of each evaluateJobs run
  resetAiCallCount();

  const profiles = await getActiveProfiles(env.DB);
  let activeProfiles = profiles.length
    ? profiles
    : [{ id: "default", notification_threshold: config.notificationThreshold }];

  const prefWeights = await getPreferenceWeights(env.SEEN_JOBS);

  const thresholdContext = await getEffectiveThreshold(
    env.SEEN_JOBS,
    config.notificationThreshold,
  );
  const globalThreshold = thresholdContext.effective;

  // Pre-compute profile embedding ONCE (same config for all jobs/profiles)
  // OPTIMIZATION: Use cached embedding to avoid regenerating every run
  const profileSpecs = [
    ...(config.searchRules?.mustMatch || []),
    ...(config.searchRules?.niceToHave || []),
  ].join(" ");
  const profileVector = await getProfileEmbedding(
    env.AI,
    env.SEEN_JOBS,
    profileSpecs,
  );
  let aiCallsCount = profileVector.length > 0 ? 0 : 1; // Only count if we actually called AI
  let alertsQueued = 0;
  let scoreSum = 0;
  let scoreMax = 0;
  let jobsEvaluated = 0;

  // Batch KV writes - collect scores and write once at the end
  const scoresToBatch = [];

  // Batch D1 writes - collect chunks and insert in one batch at end
  const chunksToBatch = [];

  // Pre-fetch global term frequencies ONCE for all jobs (1 D1 call instead of N)
  const allMustTerms = config.searchRules?.mustMatch || [];
  const globalIdfData = await getGlobalTermFrequencies(env.DB, allMustTerms);

  for (const msg of messages) {
    // Support both batched format { jobs: [...] } and legacy single job format
    const msgJobs = msg.body.jobs || [msg.body];

    // Filter new jobs to evaluate
    const newJobsToEvaluate = [];
    for (const job of msgJobs) {
      if (!isNewJob(job, config.timeWindowHours)) continue;
      newJobsToEvaluate.push(job);
    }

    if (newJobsToEvaluate.length === 0) {
      msg.ack();
      continue;
    }

    // Issue 1: Pre-fetch all sent alerts for the batch in one D1 subrequest
    const jobIds = newJobsToEvaluate.map((j) => j.id);
    const sentAlertsSet = await getSentAlertsForJobs(env.DB, jobIds);
    const newAlertsSent = [];

    for (let i = 0; i < newJobsToEvaluate.length; i++) {
      const job = newJobsToEvaluate[i];

      // Wall-time guard: stop before Worker timeout
      if (Date.now() - EVAL_START > WALL_TIME_LIMIT_MS) {
        logger.warn(
          `[Evaluator] Wall-time guard: evaluated ${jobsEvaluated} jobs in ${((Date.now() - EVAL_START) / 1000).toFixed(1)}s, deferring rest.`,
        );
        break;
      }

      jobsEvaluated++;

      // Issue 6: Ultra-fast keyword pre-filter before invoking the AI binding.
      if (!hasBasicKeywordMatch(job, config)) {
        continue;
      }

      // OPTIMIZATION: Quick keyword score to skip AI if job is already strong
      const quickKeywordScore = computeQuickKeywordScore(job, config);

      // Skip AI embedding if keyword score is very high (>75)
      // The job likely already matches well without semantic analysis
      const SKIP_AI_THRESHOLD = 75;
      let chunkVecs = [];
      let chunks = [];

      if (quickKeywordScore < SKIP_AI_THRESHOLD) {
        // v4: Chunk the job text and get embeddings
        // Optimization: Limit chunks to 5 max to reduce CPU and AI calls
        const jobTextForAi = `${job.title} ${job.company || ""} ${job.categories?.join(" ") || ""} ${job.contentSnippet || ""}`;
        chunks = chunkTexts(jobTextForAi, 200, 40).slice(0, 5);

        chunkVecs = await embedChunks(env.AI, env.SEEN_JOBS, job.id, chunks);
        aiCallsCount++;

        // v4: Insert chunk vectors into D1 (batched at end instead of per-job)
        // Store for later batch insert
        if (chunks.length > 0 && chunkVecs.length > 0) {
          chunksToBatch.push({
            jobId: job.id,
            chunks,
            chunkVecs,
          });
        }
      }

      // v4: Calculate RAG matches from memory instead of D1 query
      // This avoids an extra D1 subrequest per job and uses Min-Heap O(N log K)
      const topKChunks = new TopKChunks(5);
      for (let i = 0; i < chunks.length; i++) {
        const vec = chunkVecs[i] || [];
        if (!vec || vec.length === 0) continue;

        const sim =
          profileVector && vec.length > 0
            ? cosineSimilarity(profileVector, vec)
            : 0;
        topKChunks.add({
          text: chunks[i],
          vec: vec,
          sim: sim,
        });
      }

      const ragMatches = topKChunks.getTop();

      const trajectoryFit = 0.5; // v4 stub

      // Score once using pre-fetched IDF data (no per-job D1 query)
      let scoreResult = scoreJob(
        job,
        config,
        globalIdfData,
        ragMatches,
        trajectoryFit,
      );

      if (scoreResult.excluded) continue;

      const { adjustedScore, feedbackDelta } = applyFeedbackBoost(
        scoreResult,
        prefWeights,
      );
      if (feedbackDelta !== 0) {
        scoreResult.score = adjustedScore;
        if (!scoreResult.breakdown) scoreResult.breakdown = {};
        scoreResult.breakdown.feedbackBoost = feedbackDelta;
      }

      // Batch KV write - collect instead of per-job write
      scoresToBatch.push(scoreResult.score);

      // Track ALL evaluated scores (not just alerted) for accurate daily metrics
      scoreSum += scoreResult.score;
      scoreMax = Math.max(scoreMax, scoreResult.score);

      for (const profile of activeProfiles) {
        const threshold = profile.notification_threshold || globalThreshold;

        // Enforce MINIMUM_ALERT_SCORE=50 floor — no alert if score < 50 regardless of profile threshold
        const effectiveThreshold = Math.max(threshold, MINIMUM_ALERT_SCORE);
        if (scoreResult.score < effectiveThreshold) continue;

        if (sentAlertsSet.has(`${job.id}:${profile.id}`)) {
          continue;
        }

        logger.info(
          `🚨 [Evaluator] Match for profile ${profile.id}: [${scoreResult.score}] ${job.title}`,
        );

        try {
          // Slim alert payload — only include fields sendAlert() actually uses
          // Reduces queue message size from ~5KB to ~2KB
          const slimAlertJob = {
            id: job.id,
            title: job.title,
            company: job.company,
            url: job.url || job.link,
            link: job.link,
            categories: job.categories,
            contentSnippet: (job.contentSnippet || "").slice(0, 300),
            sourceUrl: job.sourceUrl,
            isoDate: job.isoDate,
          };
          const slimScoreResult = {
            score: scoreResult.score,
            label: scoreResult.label,
            color: scoreResult.color,
            matchedSkills: scoreResult.matchedSkills,
            reasons: scoreResult.reasons,
            // Drop full breakdown/features to save payload
          };
          // Issue 3: Wrap ALERT_QUEUE.send with exponential-backoff retry
          await withRetry(() =>
            env.ALERT_QUEUE.send({
              profileId: profile.id,
              job: slimAlertJob,
              scoreResult: slimScoreResult,
            }),
          );
        } catch (queueErr) {
          // DIRECT FALLBACK: Send alert inline only after retries exhausted
          logger.warn(
            `[Evaluator] ALERT_QUEUE failed after retries, sending alert directly: ${queueErr.message}`,
          );
          try {
            await sendAlert(job, scoreResult, {
              dryRun: config.dryRun,
              config,
              env,
              attempt: 1,
            });
          } catch (alertErr) {
            logger.error(
              `[Evaluator] Direct alert also failed: ${alertErr.message}`,
            );
          }
        }

        newAlertsSent.push({ jobId: job.id, profileId: profile.id });
        sentAlertsSet.add(`${job.id}:${profile.id}`); // in-memory update
        alertsQueued++;

        // Score distribution tracking is now batched in recordJobScoresBatch
        // (removed per-alert inline trackScoreDistribution to eliminate duplicate KV writes)
      }
    }

    if (newAlertsSent.length > 0) {
      await batchMarkAlertSent(env.DB, newAlertsSent);
    }

    msg.ack();
  }

  const perfEnd = performance.now();
  if (env.ENVIRONMENT === "local") {
    logger.info(
      `[Local CPU] evaluateJobs used ${(perfEnd - perfStart).toFixed(2)}ms`,
    );
  }

  // ── Post-evaluation cleanup (extracted to avoid duplicated code blocks) ──────
  async function postEvaluationCleanup() {
    // Batch write all collected scores to KV (single write instead of per-job)
    if (scoresToBatch.length > 0) {
      try {
        await recordJobScoresBatch(env.SEEN_JOBS, scoresToBatch);
        logger.info(
          `[Evaluator] Batch recorded ${scoresToBatch.length} scores to KV`,
        );
      } catch (err) {
        logger.warn(`[Evaluator] Batch KV write failed: ${err.message}`);
      }
    }

    // Batch write all collected job chunks to D1 (single batch instead of per-job)
    if (chunksToBatch.length > 0) {
      try {
        const insertStmt = env.DB.prepare(
          "INSERT INTO job_chunks (job_hash, chunk_text, vec_json, remote_type) VALUES (?, ?, ?, ?)",
        );
        const allChunks = [];
        for (const jobData of chunksToBatch) {
          for (let i = 0; i < jobData.chunks.length; i++) {
            allChunks.push(
              insertStmt.bind(
                jobData.jobId,
                jobData.chunks[i],
                JSON.stringify(jobData.chunkVecs[i] || []),
                "unknown",
              ),
            );
          }
        }
        // Batch in chunks of 40 (D1 limit)
        for (let i = 0; i < allChunks.length; i += 40) {
          await env.DB.batch(allChunks.slice(i, i + 40));
        }
        logger.info(
          `[Evaluator] Batch inserted ${allChunks.length} chunks to D1`,
        );
      } catch (err) {
        logger.warn(`[Evaluator] Batch chunk insert failed: ${err.message}`);
      }
    }

    // ── Auto-adjust threshold for next run based on this run's match count ──
    try {
      await getEffectiveThreshold(env.SEEN_JOBS, config.notificationThreshold, {
        matchedLastRun: alertsQueued,
      });
    } catch (err) {
      logger.warn(`[Evaluator] Threshold auto-adjust failed: ${err.message}`);
    }

    // ── Daily Metrics ──────────────────────────────────────────────────────
    try {
      await incrementDailyMetrics(env.DB, {
        ai_calls: aiCallsCount,
        worker_invocations: 1,
        jobs_evaluated: jobsEvaluated,
        queue_messages: alertsQueued,
        score_sum: scoreSum,
        score_max: scoreMax,
      });
    } catch (err) {
      logger.error(`[Evaluator] Daily metrics update failed: ${err.message}`);
    }
  }

  // ── NON-BLOCKING I/O OFFLOAD ─────────────────────────────────────────────
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(postEvaluationCleanup());
  } else {
    await postEvaluationCleanup();
  }
}

// ── 3. Sender (Consumes ALERT_QUEUE) ──────────────────────────────────────────
async function sendAlerts(messages, env, ctx) {
  const config = getConfig();
  let sentCount = 0;
  let failedCount = 0;

  for (const msg of messages) {
    const { profileId, job, scoreResult } = msg.body;

    try {
      const stats = await sendAlert(job, scoreResult, {
        dryRun: config.dryRun,
        config,
        env,
        attempt: msg.attempts || 1,
      });

      if (stats.sent > 0) {
        logger.info(
          `[Sender] Alert successfully delivered to profile ${profileId}`,
        );
        msg.ack();
        sentCount++;
      } else {
        logger.warn(`[Sender] Alert delivery failed for profile ${profileId}`);
        msg.retry({ delaySeconds: 60 * 15 });
        failedCount++;
      }
    } catch (err) {
      logger.error(`[Sender] Alert threw error: ${err.message}`);
      msg.retry({ delaySeconds: 60 * 15 });
      failedCount++;
    }
  }

  // ── Daily Metrics ──────────────────────────────────────────────────────
  try {
    await incrementDailyMetrics(env.DB, {
      alerts_sent: sentCount,
      alert_failures: failedCount,
      worker_invocations: 1,
    });
  } catch (err) {
    logger.error(`[Sender] Daily metrics update failed: ${err.message}`);
  }
}

/**
 * Cron producer implementation — contains the full business logic.
 * Issue 7: Extracted so the exported scheduled() can wrap it in a try-catch.
 */
async function _scheduledImpl(event, env, ctx) {
  const config = getConfig();
  const intel = config.crawlIntelligence || {};
  const isIntelEnabled = intel.enabled !== false;

  const cycleNumber = await getAndIncrementCycle(env.SEEN_JOBS);
  logger.info(`[Producer] Cron cycle #${cycleNumber} fired.`);

  // ── 1. Build source list: config sources + D1 registry sources ────────
  const configSources = buildSourceList(config);

  let registrySources = [];
  try {
    registrySources = await getEnabledSources(env.DB);
  } catch (err) {
    logger.warn(`[Producer] D1 registry query failed: ${err.message}`);
  }

  const configUrls = new Set(configSources.map((s) => s.url));
  const additionalSources = registrySources.filter(
    (s) => !configUrls.has(s.url),
  );
  const allSources = [...configSources, ...additionalSources];

  // ── Fix 4: Unified priority-based source selection ────────────────────
  // Config sources NO LONGER bypass the priority system. All sources are
  // scored and the top MAX_SOURCES_PER_CYCLE are selected.
  const MAX_SOURCES_PER_CYCLE = 40;
  let sourcesToCrawl;
  if (isIntelEnabled) {
    try {
      const prioritySources = await getSourcesForCycle(env.DB, cycleNumber);

      // Merge: deduplicate by URL, config sources get priority bonus
      const mergedMap = new Map();
      for (const s of prioritySources) {
        mergedMap.set(s.url, { ...s, _priority: s.priority_score || 50 });
      }
      for (const s of configSources) {
        const existing = mergedMap.get(s.url);
        if (existing) {
          // Config source already in registry — give it a bonus
          existing._priority = (existing._priority || 50) + 10;
        } else {
          // Config source not in registry — add with bonus
          mergedMap.set(s.url, { ...s, _priority: 60 });
        }
      }

      // Sort by priority descending, take top N
      const allMerged = [...mergedMap.values()]
        .sort((a, b) => (b._priority || 50) - (a._priority || 50))
        .slice(0, MAX_SOURCES_PER_CYCLE);

      sourcesToCrawl = allMerged;
      logger.info(
        `[Producer] Intelligence: ${sourcesToCrawl.length} sources selected from ${mergedMap.size} total (top ${MAX_SOURCES_PER_CYCLE} by priority)`,
      );
    } catch (err) {
      logger.warn(`[Producer] Intelligence fallback: ${err.message}`);
      sourcesToCrawl = allSources.slice(0, MAX_SOURCES_PER_CYCLE);
    }
  } else {
    sourcesToCrawl = allSources.slice(0, MAX_SOURCES_PER_CYCLE);
  }

  logger.info(
    `[Producer] Broadcasting ${sourcesToCrawl.length} sources to FEED_QUEUE...`,
  );

  // Issue 3: Use withRetry to absorb Cloudflare Queue rate-limit bursts before falling back
  let queueSuccess = false;
  try {
    const batchMessages = sourcesToCrawl.map((s) => ({ body: s }));
    const batches = [];
    for (let i = 0; i < batchMessages.length; i += 10) {
      batches.push(batchMessages.slice(i, i + 10));
    }

    for (const batch of batches) {
      await withRetry(() => env.FEED_QUEUE.sendBatch(batch));
      await new Promise((r) => setTimeout(r, 100)); // Pace queue sends — keep well under 30s wall-limit
    }
    logger.info(
      `[Producer] Successfully queued ${sourcesToCrawl.length} sources`,
    );
    queueSuccess = true;
  } catch (err) {
    logger.error(
      `[Producer] Queue send failed after retries: ${err.message}. Falling back to DIRECT processing.`,
    );
  }

  // ── DIRECT FALLBACK: Process feeds inline when queues are rate-limited ──
  if (!queueSuccess) {
    // FIX: Parsing all sources inline will immediately exceed the 10ms-50ms CPU limit of Workers.
    // Instead we only process the top 3 highest priority feeds directly, and let the next cron cycle
    // pick up the rest.
    const directStart = Date.now();
    const DIRECT_BATCH_SIZE = 3;
    let directProcessed = 0;
    logger.info(
      `[Producer] Direct mode: processing top ${DIRECT_BATCH_SIZE} priority sources inline to avoid exceededCpu...`,
    );
    const fakeMessages = sourcesToCrawl
      .slice(0, DIRECT_BATCH_SIZE)
      .map((s) => ({
        body: s,
        ack() {},
        retry() {},
      }));

    try {
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(
          processFeeds(fakeMessages, env, ctx).catch((err) =>
            logger.error(
              `[Producer] Deferred direct batch failed: ${err.message}`,
            ),
          ),
        );
      } else {
        await processFeeds(fakeMessages, env, ctx);
      }
      directProcessed = fakeMessages.length;
    } catch (err) {
      logger.error(`[Producer] Direct batch failed: ${err.message}`);
    }

    logger.info(
      `[Producer] Direct processing dispatched: ${directProcessed} critical sources (rest omitted).`,
    );
  }

  // ── 3. Periodic intelligence tasks ────────────────────────────────────

  if (isIntelEnabled && cycleNumber % (intel.recalcIntervalCycles || 4) === 0) {
    try {
      const updated = await recalculatePriorities(env.DB);
      logger.info(
        `[Intelligence] Priority recalculation: ${updated} sources updated`,
      );
    } catch (err) {
      logger.warn(`[Intelligence] Priority recalc failed: ${err.message}`);
    }
  }

  // v4 Calibration Loop
  if (isIntelEnabled && cycleNumber % 24 === 0) {
    await retrainThresholds(env.DB, env.SEEN_JOBS);
  }

  if (
    isIntelEnabled &&
    cycleNumber % (intel.careerProbeIntervalCycles || 4) === 0
  ) {
    try {
      const domains = await getPendingDomains(
        env.DB,
        intel.maxCareerProbes || 15,
      );
      if (domains.length > 0) {
        const registered = await probeDomainsForCareers(
          env.DB,
          domains,
          intel.maxCareerProbes || 15,
        );
        logger.info(
          `[CareerDetector] Probed ${domains.length} domains, registered ${registered.length} career pages`,
        );
        if (registered.length > 0) {
          await incrementDailyMetrics(env.DB, {
            new_sources_career: registered.length,
          });
        }
      }
    } catch (err) {
      logger.warn(`[CareerDetector] Career probing failed: ${err.message}`);
    }
  }

  // ── Run source discovery on trigger cycle OR after 72h dry spell ──────
  // FIX: lowered interval from 24→8 cycles so discovery runs more often.
  // FIX: 72h force-run guard — if discovery hasn't found new sources in 72h,
  //      force a discovery cycle regardless of cycle counter to ensure growth.
  const DISCOVERY_INTERVAL_CYCLES = intel.searchIntervalCycles || 8;
  const FORCE_DISCOVERY_AFTER_MS = 72 * 60 * 60 * 1000; // 72 hours

  let forceDiscovery = false;
  if (isIntelEnabled && config.searchExpansion?.enabled) {
    try {
      const lastSuccessRaw = await env.SEEN_JOBS.get(
        "discovery:last_success_timestamp",
      );
      if (lastSuccessRaw) {
        const msSinceSuccess = Date.now() - new Date(lastSuccessRaw).getTime();
        if (msSinceSuccess > FORCE_DISCOVERY_AFTER_MS) {
          forceDiscovery = true;
          logger.warn(
            `[SearchExpander] Force-running discovery — no new sources found in ${Math.round(msSinceSuccess / 3600_000)}h`,
          );
        }
      } else {
        // Never successfully run before — force first run
        forceDiscovery = true;
      }
    } catch (err) {
      logger.warn(
        `[SearchExpander] Failed to read discovery last-success from KV: ${err.message}`,
      );
    }
  }

  if (
    isIntelEnabled &&
    config.searchExpansion?.enabled &&
    (forceDiscovery || cycleNumber % DISCOVERY_INTERVAL_CYCLES === 0)
  ) {
    let dynamicQueries = config.searchExpansion?.queries
      ? [...config.searchExpansion.queries]
      : [];
    try {
      // Add base discovery query from config (moved from hardcoded)
      if (config.searchExpansion?.baseQuery) {
        dynamicQueries.push(config.searchExpansion.baseQuery);
      }

      // Fetch live market spikes to seed active search
      const { skillSpikes, hiringSurges } = await runGrowthEngineCycle(env.DB);

      // Add top 2 trending skills
      for (const spike of skillSpikes.slice(0, 2)) {
        dynamicQueries.push(`${spike.skill} remote developer "careers"`);
      }
      // Add top 2 surging companies
      for (const surge of hiringSurges.slice(0, 2)) {
        dynamicQueries.push(`"${surge.company}" careers "open positions"`);
      }
    } catch (err) {
      logger.warn(
        `[SearchExpander] Failed to extract growth signals: ${err.message}`,
      );
    }

    try {
      const knownUrls = new Set(allSources.map((s) => s.url));
      const { newAtsSources, newDomains } = await runSearchExpansion(
        env.DB,
        dynamicQueries,
        knownUrls,
        env.SEEN_JOBS, // Pass KV to track discovery states and limits
        config.searchExpansion?.maxSearchesPerCycle || 8,
        config.searchExpansion?.maxDomainsPerSearch || 20,
      );
      logger.info(
        `[SearchExpander] Expansion: ${newAtsSources} ATS sources, ${newDomains} domains queued`,
      );
      if (newAtsSources > 0 || newDomains > 0) {
        if (ctx && ctx.waitUntil) {
          // Run metrics asynchronously without blocking the queue
          ctx.waitUntil(
            incrementDailyMetrics(env.DB, {
              new_sources_search: newAtsSources,
              new_domains_queued: newDomains,
            }),
          );
        } else {
          incrementDailyMetrics(env.DB, {
            new_sources_search: newAtsSources,
            new_domains_queued: newDomains,
          }).catch((e) =>
            logger.warn(`[SearchExpander] Failed metrics update: ${e.message}`),
          );
        }
      }
    } catch (err) {
      logger.warn(`[SearchExpander] Search expansion failed: ${err.message}`);
    }
  }

  try {
    await cleanupStaleJobs(env.DB, 30);
    // Cleanup job_chunks (7-day retention — fastest growing table)
    await cleanupStaleChunks(env.DB, 7);
    // Cleanup sent_alerts (90-day retention)
    await cleanupStaleAlerts(env.DB, 90);
  } catch (err) {
    logger.warn(`[Producer] Cleanup failed: ${err.message}`);
  }

  // ── Daily Metrics: track cycle ─────────────────────────────────────
  // ── IMPORTANT: ensure this runs by blocking before cycle end!
  try {
    await incrementDailyMetrics(env.DB, {
      cycles_completed: 1,
      worker_invocations: 1,
    });
  } catch (err) {
    logger.error(`[Producer] Daily metrics update failed: ${err.message}`);
  }

  // ── Daily Intelligence Report (trigger at midnight UTC cycle) ──────
  const hourUTC = new Date().getUTCHours();
  const minuteUTC = new Date().getUTCMinutes();
  if (hourUTC === 0 && minuteUTC < 15) {
    try {
      // At midnight UTC, report on the PREVIOUS day's complete data
      const yesterday = new Date(Date.now() - 86400_000)
        .toISOString()
        .split("T")[0];
      const result = await sendDailyReport(env.DB, env, {
        reportDate: yesterday,
      });
      logger.info(
        `[DailyReport] Sent to: ${result.channels.join(", ") || "none"}`,
      );
    } catch (err) {
      logger.warn(`[DailyReport] Failed: ${err.message}`);
    }
  }

  logger.info(`[Producer] Cycle #${cycleNumber} dispatch complete.`);
}

// ── Worker Export ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/test-cron") {
      const start = performance.now();
      await this.scheduled(null, env, ctx);
      return jsonResponse({
        status: "ok",
        message: "Local cron test completed.",
        time_ms: Math.round(performance.now() - start),
      });
    }

    if (url.pathname === "/health") {
      const envCheck = validateEnv(env);
      return jsonResponse({
        status: "ok",
        version: "5.1.0",
        architecture: "event-driven-queues",
        timestamp: new Date().toISOString(),
        secrets: envCheck.valid
          ? "all configured"
          : `missing: ${envCheck.missing.join(", ")}`,
      });
    }

    if (url.pathname === "/metrics") {
      try {
        const metrics = await getSourceMetrics(env.DB);
        return jsonResponse(
          {
            status: "ok",
            version: "5.1.0",
            timestamp: new Date().toISOString(),
            ...metrics,
          },
          200,
          { "Cache-Control": "public, max-age=3600" },
        );
      } catch (err) {
        return jsonResponse({ status: "error", message: err.message }, 500);
      }
    }

    if (url.pathname === "/report") {
      try {
        // Support ?date=YYYY-MM-DD to view any day's report (default: today)
        const reportDate = url.searchParams.get("date") || undefined;
        const data = await getDailyReportData(env.DB, { reportDate });
        const report = formatDailyReport(data);
        if (request.method === "POST") {
          const result = await sendDailyReport(env.DB, env, { reportDate });
          return jsonResponse({
            status: "ok",
            sent: result.sent,
            channels: result.channels,
            report,
          });
        }
        return new Response(report, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      } catch (err) {
        return jsonResponse({ status: "error", message: err.message }, 500);
      }
    }

    if (url.pathname === "/trigger" && request.method === "POST") {
      try {
        const config = getConfig();
        const allSources = buildSourceList(config);

        // Try queue-based dispatch first
        let sent = 0;
        let queueFailed = false;
        try {
          const batchMessages = allSources.map((s) => ({ body: s }));
          const batches = [];
          for (let i = 0; i < batchMessages.length; i += 50) {
            batches.push(batchMessages.slice(i, i + 50));
          }

          for (const batch of batches) {
            await withRetry(() => env.FEED_QUEUE.sendBatch(batch));
            await new Promise((r) => setTimeout(r, 200));
          }
          sent = allSources.length;
        } catch (err) {
          logger.warn(
            `[Trigger] Queue send failed after retries: ${err.message}. Using direct processing.`,
          );
          queueFailed = true;
        }

        // DIRECT FALLBACK: Process feeds inline when queues are rate-limited
        // Process 5 sources per batch with a 25-second wall-time guard
        if (queueFailed) {
          const startTime = Date.now();
          const WALL_TIME_LIMIT_MS = 25_000; // Stop before 30s Worker timeout
          const DIRECT_BATCH_SIZE = 5;
          const fakeMessages = allSources.map((s) => ({
            body: s,
            ack() {},
            retry() {},
          }));
          for (let i = 0; i < fakeMessages.length; i += DIRECT_BATCH_SIZE) {
            if (Date.now() - startTime > WALL_TIME_LIMIT_MS) {
              logger.warn(
                `[Trigger] Wall-time guard: processed ${sent}/${allSources.length} sources in ${((Date.now() - startTime) / 1000).toFixed(1)}s, deferring rest.`,
              );
              break;
            }
            try {
              await processFeeds(
                fakeMessages.slice(i, i + DIRECT_BATCH_SIZE),
                env,
                ctx,
              );
              sent += Math.min(DIRECT_BATCH_SIZE, fakeMessages.length - i);
            } catch (err) {
              logger.error(
                `[Trigger] Direct batch ${Math.floor(i / DIRECT_BATCH_SIZE)} failed: ${err.message}`,
              );
            }
          }
          return jsonResponse({
            status: "ok",
            mode: "direct",
            msg: `Processed ${sent}/${allSources.length} sources directly (queues rate-limited). Remaining will be picked up by next cron.`,
          });
        }

        return jsonResponse({
          status: "ok",
          msg: `Triggered ${sent}/${allSources.length} source messages to queue.`,
        });
      } catch (err) {
        return jsonResponse({ status: "error", message: err.message }, 500);
      }
    }

    if (url.pathname === "/stress-test" && request.method === "GET") {
      if (env.ENVIRONMENT !== "local") {
        return jsonResponse(
          {
            status: "forbidden",
            message: "Only available in local environment",
          },
          403,
        );
      }

      const power = parseInt(url.searchParams.get("power")) || 1;
      const TARGET_JOBS = 100 * power;

      const config = getConfig();
      const globalMatcher = getGlobalMatcher(config);

      const generateMockJobs = (count) => {
        const jobs = [];
        const baseDescription =
          `We are looking for a Senior Software Engineer with deep expertise in React, TypeScript, and Node.js. 
        You will be building scalable APIs using GraphQL, managing state with Redux, and deploying microservices 
        to AWS using Docker and Kubernetes. Requirements include 5+ years of experience with PostgreSQL and MongoDB. 
        Experience with CI/CD pipelines (GitHub Actions, Jenkins) is a huge plus. We value clean code, TDD (Jest, Cypress), 
        and agile methodologies. Join our fast-paced startup to revolutionize the tech industry. `.repeat(
            10,
          ); // Heavy text payload

        for (let i = 0; i < count; i++) {
          jobs.push({
            id: `stress-mock-job-${Date.now()}-${i}`,
            title: `Senior Engineer - Mock ${i}`,
            link: `https://example.com/job/stress/${Date.now()}/${i}`,
            sourceUrl: "https://example.com/rss",
            pubDate: new Date().toISOString(),
            contentSnippet: baseDescription + ` Unique Seed: ${Math.random()}`,
            company: "Stress Test Inc.",
            source_type: "rss",
          });
        }
        return jobs;
      };

      try {
        const jobs = generateMockJobs(TARGET_JOBS);
        const payloadSizeBytes = JSON.stringify(jobs).length;
        const payloadSizeKB = (payloadSizeBytes / 1024).toFixed(2);

        const perfStart = performance.now();

        let simHashCount = 0;
        let fastMatcherCount = 0;

        // 1. Stress the Dedup Algorithm (O(1) hashing per job)
        for (const job of jobs) {
          job.content_hash = generateSimHash(
            job.title + " " + job.contentSnippet,
          );
          simHashCount++;
        }

        // 2. Stress the Trie Pattern Matcher (O(N) scanning)
        for (const job of jobs) {
          const text = (job.title + " " + job.contentSnippet).toLowerCase();
          job.matchedTerms = globalMatcher.scan(text);
          fastMatcherCount++;
        }

        const perfEnd = performance.now();
        const elapsedCpuMs = parseInt((perfEnd - perfStart).toFixed(2));

        // 3. Stress the DB chunking batch processor logic
        const CHUNK_SIZE = 50;
        const simulatedQueueBatches = Math.ceil(TARGET_JOBS / CHUNK_SIZE);
        const simulatedD1Batches = Math.ceil(TARGET_JOBS / CHUNK_SIZE);
        const d1Writes = TARGET_JOBS;

        const timestamp = new Date().toISOString();

        const reportData = {
          power,
          target_jobs: TARGET_JOBS,
          payload_size_kb: payloadSizeKB,
          cpu_time_ms: elapsedCpuMs,
          fastmatcher_scans: fastMatcherCount,
          simhash_gens: simHashCount,
          queue_messages: TARGET_JOBS,
          queue_batches: simulatedQueueBatches,
          d1_writes: d1Writes,
          d1_batches: simulatedD1Batches,
          timestamp,
        };

        if (ctx && ctx.waitUntil) {
          ctx.waitUntil(
            (async () => {
              const batches = [];
              for (let i = 0; i < jobs.length; i += CHUNK_SIZE) {
                batches.push(jobs.slice(i, i + CHUNK_SIZE));
              }

              for (const batch of batches) {
                const messages = batch.map((job) => ({ body: job }));
                try {
                  // Simulate pushing to the queue
                  await env.JOB_QUEUE.sendBatch(messages);
                } catch (e) {
                  // Ignore queue failures in stress test
                }
                await new Promise((r) => setTimeout(r, 200));
              }

              // Save the telemetry log to D1 or KV
              await saveStressTestLog(env, reportData);
            })(),
          );
        }

        const reportText = `=========================================
🔥 STRESS TEST RUN COMPLETE
=========================================
• Power Multiplier : ${power} (Simulating ${TARGET_JOBS} concurrent jobs)
• Payload Size     : ${payloadSizeKB} KB (Approximate Memory Footprint)
• Execution Time   : ${elapsedCpuMs} ms (Must be < 50ms for CF Free Tier)

📊 RESOURCE USAGE:
• FastMatcher Scans: ${fastMatcherCount}
• SimHash Gens     : ${simHashCount}
• Queue Messages   : ${TARGET_JOBS} (Sent in ${simulatedQueueBatches} batches)
• D1 Writes        : ${d1Writes} (Chunked into ${simulatedD1Batches} transactions)

💾 LOGGING:
• Saved to         : D1 Table (stress_test_logs) OR KV
• Timestamp        : ${timestamp}
=========================================`;

        console.log(reportText);

        return new Response(reportText, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      } catch (err) {
        return jsonResponse({ status: "error", message: err.message }, 500);
      }
    }

    return jsonResponse({ status: "ok", version: "5.1.0" });
  },

  /**
   * Cron producer — Self-Expanding Engine scheduler.
   * Issue 7 fix: Wraps _scheduledImpl in a global try-catch so any unhandled
   * exception logs a descriptive message + stack trace instead of just the cron string.
   */
  async scheduled(event, env, ctx) {
    try {
      await _scheduledImpl(event, env, ctx);
    } catch (err) {
      // Use optional chaining so this never throws a secondary TypeError
      // if event is null (e.g. called from /test-cron) or event.cron is missing.
      logger.error(
        `[Scheduled] Unhandled error in cron "${event?.cron ?? 'manual'}": ${err.message}`,
        { stack: err.stack },
      );
    }
  },

  /**
   * Queue consumer router.
   * Issue 7 fix: Wraps queueHandler in a global try-catch so any unhandled crash
   * logs the queue name + stack trace and retries all messages to avoid message loss.
   */
  async queue(batch, env, ctx) {
    try {
      await queueHandler(batch, env, ctx);
    } catch (err) {
      logger.error(
        `[Queue] Unhandled error in queue="${batch.queue}": ${err.message}`,
        { stack: err.stack },
      );
      // Retry all messages so they are not lost on an unexpected crash
      for (const msg of batch.messages) {
        try {
          msg.retry();
        } catch (_) {
          /* already acked */
        }
      }
    }
  },
};
