/**
 * @module worker
 * @description Cloudflare Worker entry point for Job Hunter Bot v5.1.
 *
 * Architecture: Event-Driven Queue Topology + strictly consistent D1 Dedup
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
  updateSourceStats,
  registerDiscoveredSource,
  batchRegisterDiscoveredSources,
  getSourceMetrics,
  getEnabledSources,
  cleanupStaleJobs,
} from "./db/index.js";

// Source discovery + Self-expanding engine
import { detectAtsSourcesWithDomains } from "./discovery/sourceDiscovery.js";
import {
  registerDomain,
  batchRegisterDomains,
  getPendingDomains,
  probeDomainsForCareers,
} from "./discovery/careerDetector.js";
import { runSearchExpansion } from "./discovery/searchExpander.js";
import {
  getAndIncrementCycle,
  recalculatePriorities,
  getSourcesForCycle,
  recordSourceYield,
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
  recordJobScore,
} from "./intelligence/threshold.js";
import {
  applyFeedbackBoost,
  getPreferenceWeights,
} from "./scoring/feedback.js";
import { runGrowthEngineCycle } from "./intelligence/growthEngine.js";
import { retrainThresholds } from "./intelligence/calibration.js";

// AI
import { generateEmbedding, cosineSimilarity } from "./notifications/ai.js";

import {
  chunkTexts,
  embedChunks,
  retrieveRelevant,
  resetAiCallCount,
} from "./notifications/ai-v4.js";

// ── JSON Response Helper ─────────────────────────────────────────────────────

function jsonResponse(data, status = 200, additionalHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...additionalHeaders },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hasBasicKeywordMatch(job, config) {
  if (job.matchedTerms && job.matchedTerms.length > 0) return true;

  const terms = [
    ...(config.searchRules?.mustMatch || []),
    ...(config.searchRules?.niceToHave || []),
  ];
  if (terms.length === 0) return true; // if no rules configured, pass

  const text =
    `${job.title} ${job.company || ""} ${job.categories?.join(" ") || ""} ${job.contentSnippet || ""}`.toLowerCase();
  for (const term of terms) {
    if (text.includes(term.toLowerCase())) return true;
  }
  return false;
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
async function withRetry(fn, maxRetries = 3, baseDelayMs = 500) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 100;
        logger.warn(
          `[Retry] Attempt ${attempt + 1}/${maxRetries + 1} failed (${err.message}), retrying in ${Math.round(delay)}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
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
    sourceUrl: job.sourceUrl,
    publishedAt: job.publishedAt,
    isoDate: job.isoDate,
    pubDate: job.pubDate,
  };
}

// ── Queue Router ─────────────────────────────────────────────────────────────

async function queueHandler(batch, env) {
  const queueName = batch.queue;

  if (queueName === "feed-queue" || queueName.endsWith("-feed-queue")) {
    await processFeeds(batch.messages, env);
  } else if (queueName === "job-queue" || queueName.endsWith("-job-queue")) {
    await evaluateJobs(batch.messages, env);
  } else if (
    queueName === "alert-queue" ||
    queueName.endsWith("-alert-queue")
  ) {
    await sendAlerts(batch.messages, env);
  } else {
    logger.error(`[Queue] Unknown queue: ${queueName}`);
    for (const msg of batch.messages) {
      msg.ack();
    }
  }
}

// ── 1. Fetcher (Consumes FEED_QUEUE) ─────────────────────────────────────────
async function processFeeds(messages, env) {
  const config = loadConfig();
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
  const sourceStatPromises = [];

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
    sourceStatPromises.push(
      updateSourceStats(env.DB, stat.url, {
        success: !stat.error,
        jobCount: stat.count || 0,
      }).catch((err) =>
        logger.warn(`[Fetcher] updateSourceStats failed: ${err.message}`),
      ),
    );
  }
  // Fire KV + D1 stat writes in parallel (non-blocking)
  await Promise.allSettled([...feedResultPromises, ...sourceStatPromises]);

  // ── Intra-batch dedup (fast in-memory) ──────────────────────────────────
  const seenHashes = new Set();
  const dedupedJobs = [];
  let inMemoryDupes = 0;

  for (const job of jobs) {
    if (job.content_hash && seenHashes.has(job.content_hash)) {
      inMemoryDupes++;
      continue;
    }
    if (job.content_hash) seenHashes.add(job.content_hash);
    dedupedJobs.push(job);
  }

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
    if (/\b(remote|wfh|work from home|distributed|anywhere)\b/.test(jobText))
      remoteJobs++;
    else if (/\bhybrid\b/.test(jobText)) hybridJobs++;
    else onsiteJobs++;

    // Salary tracking
    const salaryMatch = jobText.match(/\$([\d,]+)/g);
    if (salaryMatch) {
      const val = parseInt(salaryMatch[0].replace(/[$,]/g, ""), 10);
      if (val > 1000 && val < 1_000_000) {
        salarySum += val;
        salaryCount++;
      }
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
  const JOB_CHUNK_SIZE = 20;
  let queueMsgs = 0;
  let jobQueueSuccess = false;
  try {
    const messages = [];
    for (let i = 0; i < newJobs.length; i += JOB_CHUNK_SIZE) {
      const slimChunk = newJobs.slice(i, i + JOB_CHUNK_SIZE).map(slimJob);
      const payload = { jobs: slimChunk };

      // Issue 4: Pre-flight size check — skip gracefully if still over limit
      const payloadSize = JSON.stringify(payload).length;
      if (payloadSize > 100_000) {
        logger.warn(
          `[Fetcher] JOB_QUEUE chunk too large (${payloadSize} bytes), skipping ${slimChunk.length} jobs to avoid Payload Too Large error.`,
        );
        continue;
      }
      messages.push({ body: payload });
    }

    // Cloudflare Queues support up to 100 messages per sendBatch
    for (let i = 0; i < messages.length; i += 100) {
      await withRetry(() =>
        env.JOB_QUEUE.sendBatch(messages.slice(i, i + 100)),
      );
      await sleep(200); // Pace queue sends
    }

    queueMsgs = messages.length;
    if (newJobs.length > 0) {
      logger.info(
        `[Fetcher] Sent ${newJobs.length} jobs in ${queueMsgs} queue messages`,
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
    logger.error(`[Fetcher] Daily metrics (phase 1) failed: ${err.message}`);
  }

  // ── DIRECT FALLBACK: Evaluate jobs inline when JOB_QUEUE is rate-limited ──
  if (!jobQueueSuccess && newJobs.length > 0) {
    try {
      const fakeMessages = [{ body: { jobs: newJobs }, ack() {}, retry() {} }];
      await evaluateJobs(fakeMessages, env);
      logger.info(
        `[Fetcher] Direct evaluation completed for ${newJobs.length} jobs`,
      );
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
    // Build a rich URL set: include all available URL fields from each job
    const urlsForAtsDetection = [];
    for (const job of jobs) {
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

  // Record yield for intelligence layer (with dedup ratio for scoring penalty)
  for (const fs of feedStats) {
    if (!fs.error) {
      const sourceNewJobs = perSourceNewJobs.get(fs.url) || 0;
      const totalFromSource = fs.count || 0;
      // Compute duplication ratio: 1.0 = all duplicates, 0.0 = all unique
      const dupRatio =
        totalFromSource > 0
          ? Math.max(0, Math.min(1, 1 - sourceNewJobs / totalFromSource))
          : 0;
      try {
        await recordSourceYield(
          env.DB,
          fs.url,
          sourceNewJobs,
          totalFromSource,
          dupRatio,
        );
      } catch (err) {
        logger.warn(`[Fetcher] recordSourceYield failed: ${err.message}`);
      }
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
      logger.error(`[Fetcher] Daily metrics (phase 2) failed: ${err.message}`);
    }
  }

  logger.info(
    `[Fetcher] Harvest complete. Inserted ${newlyInsertedCount} new jobs (${duplicateCount} dupes filtered).`,
  );

  for (const msg of messages) {
    msg.ack();
  }
}

// ── 2. Evaluator (Consumes JOB_QUEUE) — CPU-optimized ────────────────────────
async function evaluateJobs(messages, env) {
  const config = loadConfig();
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
  const profileSpecs = [
    ...(config.searchRules?.mustMatch || []),
    ...(config.searchRules?.niceToHave || []),
  ].join(" ");
  const profileVector = await generateEmbedding(env.AI, profileSpecs);
  let aiCallsCount = 1; // Count the profile embedding call
  let alertsQueued = 0;
  let scoreSum = 0;
  let scoreMax = 0;
  let jobsEvaluated = 0;

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

      // v4: Chunk the job text and get embeddings
      const jobTextForAi = `${job.title} ${job.company || ""} ${job.categories?.join(" ") || ""} ${job.contentSnippet || ""}`;
      const chunks = chunkTexts(jobTextForAi, 200, 40);

      const chunkVecs = await embedChunks(
        env.AI,
        env.SEEN_JOBS,
        job.id,
        chunks,
      );
      aiCallsCount++;

      // v4: Insert chunk vectors into D1
      try {
        const insertStmt = env.DB.prepare(
          "INSERT INTO job_chunks (job_hash, chunk_text, vec_json, remote_type) VALUES (?, ?, ?, ?)",
        );
        const batch = chunks.map((chunk, idx) =>
          insertStmt.bind(
            job.id,
            chunk,
            JSON.stringify(chunkVecs[idx] || []),
            "unknown",
          ),
        );
        if (batch.length > 0) await env.DB.batch(batch);
      } catch (e) {
        logger.warn(`[Evaluator] Failed inserting chunks to D1: ${e.message}`);
      }

      // v4: RAG Retrieval
      const ragMatches = await retrieveRelevant(
        env.DB,
        profileVector,
        job.id,
        5,
      );

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

      await recordJobScore(env.SEEN_JOBS, scoreResult.score);

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
          // Issue 3: Wrap ALERT_QUEUE.send with exponential-backoff retry
          await withRetry(() =>
            env.ALERT_QUEUE.send({
              profileId: profile.id,
              job: job,
              scoreResult: scoreResult,
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
        scoreSum += scoreResult.score;
        scoreMax = Math.max(scoreMax, scoreResult.score);
      }
    }

    if (newAlertsSent.length > 0) {
      await batchMarkAlertSent(env.DB, newAlertsSent);
    }

    msg.ack();
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
      queue_messages: alertsQueued,
      score_sum: scoreSum,
      score_max: scoreMax,
    });
  } catch (err) {
    logger.error(`[Evaluator] Daily metrics update failed: ${err.message}`);
  }
}

// ── 3. Sender (Consumes ALERT_QUEUE) ──────────────────────────────────────────
async function sendAlerts(messages, env) {
  const config = loadConfig();
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
  const config = loadConfig();
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

  // ── 2. Priority-based source selection ────────────────────────────────
  let sourcesToCrawl;
  if (isIntelEnabled) {
    try {
      const prioritySources = await getSourcesForCycle(env.DB, cycleNumber);
      sourcesToCrawl = [
        ...configSources,
        ...prioritySources.filter((s) => !configUrls.has(s.url)),
      ];
      logger.info(
        `[Producer] Intelligence: ${sourcesToCrawl.length} sources selected (${configSources.length} config + ${prioritySources.filter((s) => !configUrls.has(s.url)).length} registry)`,
      );
    } catch (err) {
      logger.warn(`[Producer] Intelligence fallback: ${err.message}`);
      sourcesToCrawl = allSources;
    }
  } else {
    sourcesToCrawl = allSources;
  }

  logger.info(
    `[Producer] Broadcasting ${sourcesToCrawl.length} sources to FEED_QUEUE...`,
  );

  // Issue 3: Use withRetry to absorb Cloudflare Queue rate-limit bursts before falling back
  let queueSuccess = false;
  try {
    const batchMessages = sourcesToCrawl.map((s) => ({ body: s }));
    // sendBatch supports up to 100 messages per call
    for (let i = 0; i < batchMessages.length; i += 100) {
      await withRetry(() =>
        env.FEED_QUEUE.sendBatch(batchMessages.slice(i, i + 100)),
      );
      await sleep(200); // Pace queue sends
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
  // Use a wall-time guard to stop before the Worker timeout (30s for cron on free tier)
  if (!queueSuccess) {
    const directStart = Date.now();
    const WALL_TIME_LIMIT_MS = 25_000; // Stop before 30s Worker timeout
    const DIRECT_BATCH_SIZE = 5; // Smaller batches for faster turnaround
    let directProcessed = 0;
    logger.info(
      `[Producer] Direct mode: processing ${sourcesToCrawl.length} sources inline...`,
    );
    const fakeMessages = sourcesToCrawl.map((s) => ({
      body: s,
      ack() {},
      retry() {},
    }));
    for (let i = 0; i < fakeMessages.length; i += DIRECT_BATCH_SIZE) {
      if (Date.now() - directStart > WALL_TIME_LIMIT_MS) {
        logger.warn(
          `[Producer] Wall-time guard: processed ${directProcessed}/${sourcesToCrawl.length} sources in ${((Date.now() - directStart) / 1000).toFixed(1)}s, deferring rest to next cycle.`,
        );
        break;
      }
      try {
        await processFeeds(fakeMessages.slice(i, i + DIRECT_BATCH_SIZE), env);
        directProcessed += Math.min(DIRECT_BATCH_SIZE, fakeMessages.length - i);
      } catch (err) {
        logger.error(
          `[Producer] Direct batch ${Math.floor(i / DIRECT_BATCH_SIZE)} failed: ${err.message}`,
        );
      }
    }
    logger.info(
      `[Producer] Direct processing: ${directProcessed}/${sourcesToCrawl.length} sources completed.`,
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
      // Force L5 behavior: Base DDG queries for "MERN remote India" as requested
      dynamicQueries.push('MERN remote India "careers"');

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
        env.SEEN_JOBS, // ← FIX: pass kv so DDG cooldown is tracked & cleared
        config.searchExpansion?.maxSearchesPerCycle || 8,
        config.searchExpansion?.maxDomainsPerSearch || 20,
      );
      logger.info(
        `[SearchExpander] Expansion: ${newAtsSources} ATS sources, ${newDomains} domains queued`,
      );
      if (newAtsSources > 0 || newDomains > 0) {
        await incrementDailyMetrics(env.DB, {
          new_sources_search: newAtsSources,
          new_domains_queued: newDomains,
        });
      }
    } catch (err) {
      logger.warn(`[SearchExpander] Search expansion failed: ${err.message}`);
    }
  }

  try {
    await cleanupStaleJobs(env.DB, 30);
  } catch (err) {
    logger.warn(`[Producer] Cleanup failed: ${err.message}`);
  }

  // ── Daily Metrics: track cycle ─────────────────────────────────────
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
        const config = loadConfig();
        const allSources = buildSourceList(config);

        // Try queue-based dispatch first
        let sent = 0;
        let queueFailed = false;
        try {
          const batchMessages = allSources.map((s) => ({ body: s }));
          for (let i = 0; i < batchMessages.length; i += 100) {
            // Issue 3: Retry with backoff before falling back to direct
            await withRetry(() =>
              env.FEED_QUEUE.sendBatch(batchMessages.slice(i, i + 100)),
            );
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
      logger.error(
        `[Scheduled] Unhandled error in cron "${event.cron}": ${err.message}`,
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
      await queueHandler(batch, env);
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
