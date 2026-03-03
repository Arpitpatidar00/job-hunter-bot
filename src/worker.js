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

import { loadConfig } from './config.js';
import logger from './core/logger.js';
import { validateEnv } from './env.ts';
import { runAllConnectors } from './connectors/index.js';
import { buildSourceList } from './connectors/base.js';
import { scoreJob, isNewJob } from './scoring/relevance.js';
import { sendAlert } from './notifications/notifications.js';

// D1 Database Layer
import {
    insertJobIfNotExists, getActiveProfiles, hasSentAlert, markAlertSent,
    recordTermFrequencies, getGlobalTermFrequencies,
    updateSourceStats, registerDiscoveredSource, getSourceMetrics,
    getEnabledSources, cleanupStaleJobs
} from './db/index.js';

// Source discovery + Self-expanding engine
import { detectAtsSourcesWithDomains } from './discovery/sourceDiscovery.js';
import { registerDomain, getPendingDomains, probeDomainsForCareers } from './discovery/careerDetector.js';
import { runSearchExpansion } from './discovery/searchExpander.js';
import {
    getAndIncrementCycle, recalculatePriorities,
    getSourcesForCycle, recordSourceYield
} from './intelligence/sourceIntelligence.js';
import { incrementDailyMetrics, sendDailyReport, getDailyReportData, formatDailyReport } from './intelligence/dailyReport.js';

// Intelligence modules
import { isFeedCircuitOpen, recordFeedResult } from './intelligence/feedHealth.js';
import { getEffectiveThreshold, recordJobScore } from './intelligence/threshold.js';
import { applyFeedbackBoost, getPreferenceWeights } from './scoring/feedback.js';

// AI
import { generateEmbedding, cosineSimilarity } from './notifications/ai.js';

// ── JSON Response Helper ─────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

// ── Queue Router ─────────────────────────────────────────────────────────────

async function queueHandler(batch, env) {
    const queueName = batch.queue;

    if (queueName === 'feed-queue' || queueName.endsWith('-feed-queue')) {
        await processFeeds(batch.messages, env);
    } else if (queueName === 'job-queue' || queueName.endsWith('-job-queue')) {
        await evaluateJobs(batch.messages, env);
    } else if (queueName === 'alert-queue' || queueName.endsWith('-alert-queue')) {
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

    // Each message.body is a source definition from scheduled()
    const allSources = messages.map(m => m.body);

    // Separate RSS feeds from ATS sources
    const rssFeedUrls = allSources.filter(s => s.type === 'rss').map(s => s.url || s);
    const atsSources = allSources.filter(s => s.type && s.type !== 'rss');

    // Build a config for runAllConnectors that uses these specific sources
    const batchConfig = {
        ...config,
        feeds: rssFeedUrls,
        sources: atsSources,
    };

    // Check circuit breakers and filter healthy sources
    const healthyFeeds = [];
    for (const url of batchConfig.feeds) {
        const isOpen = await isFeedCircuitOpen(env.SEEN_JOBS, url);
        if (isOpen) {
            logger.warn(`[Circuit] Skipping ${url} — circuit is OPEN`);
        } else {
            healthyFeeds.push(url);
        }
    }
    batchConfig.feeds = healthyFeeds;

    // Run all connectors in parallel
    const { jobs, feedStats, totalItems, totalErrors } = await runAllConnectors(batchConfig);

    // Record circuit breaker metrics
    let crawlSuccesses = 0;
    let crawlFailures = 0;
    for (const stat of feedStats) {
        try {
            await recordFeedResult(env.SEEN_JOBS, stat.url, {
                success: !stat.error,
                latencyMs: stat.durationMs || 0,
                error: stat.error || '',
            });
        } catch (err) { logger.warn(`[Fetcher] recordFeedResult failed: ${err.message}`); }
        if (!stat.error) crawlSuccesses++; else crawlFailures++;
        try {
            await updateSourceStats(env.DB, stat.url, {
                success: !stat.error,
                jobCount: stat.count || 0,
            });
        } catch (err) { logger.warn(`[Fetcher] updateSourceStats failed: ${err.message}`); }
    }

    // Intra-batch dedup + D1 insert + JOB_QUEUE dispatch
    const seenHashes = new Set();
    let newlyInsertedCount = 0;
    let duplicateCount = 0;
    let queueMsgs = 0;
    const batchSkillCounts = {};
    let remoteJobs = 0, hybridJobs = 0, onsiteJobs = 0;
    let salarySum = 0, salaryCount = 0;
    const perSourceNewJobs = new Map(); // Track per-source new job counts for yield recording
    const jobsToQueue = []; // Collect jobs for batch send to JOB_QUEUE

    for (const job of jobs) {
        if (job.content_hash && seenHashes.has(job.content_hash)) {
            duplicateCount++;
            continue;
        }
        if (job.content_hash) seenHashes.add(job.content_hash);

        const { inserted } = await insertJobIfNotExists(env.DB, job);
        if (!inserted) { duplicateCount++; continue; }

        newlyInsertedCount++;
        // Track per-source yield
        const jobSourceUrl = job.sourceUrl || '';
        perSourceNewJobs.set(jobSourceUrl, (perSourceNewJobs.get(jobSourceUrl) || 0) + 1);

        jobsToQueue.push(job);

        // Track market signals
        if (job.matchedTerms?.length) {
            for (const term of job.matchedTerms) {
                batchSkillCounts[term] = (batchSkillCounts[term] || 0) + 1;
            }
            try { await recordTermFrequencies(env.DB, job.matchedTerms); } catch (err) { logger.warn(`[Fetcher] recordTermFrequencies failed: ${err.message}`); }
        }

        // Remote/location detection
        const jobText = `${job.title || ''} ${job.contentSnippet || ''}`.toLowerCase();
        if (/\b(remote|wfh|work from home|distributed|anywhere)\b/.test(jobText)) remoteJobs++;
        else if (/\bhybrid\b/.test(jobText)) hybridJobs++;
        else onsiteJobs++;

        // Salary tracking
        const salaryMatch = jobText.match(/\$([\d,]+)/g);
        if (salaryMatch) {
            const val = parseInt(salaryMatch[0].replace(/[$,]/g, ''), 10);
            if (val > 1000 && val < 1_000_000) { salarySum += val; salaryCount++; }
        }
    }

    // Batch send to JOB_QUEUE: pack jobs into chunks (max ~50 per message to stay under 128KB)
    // This reduces queue operations from hundreds to a handful per cycle.
    const JOB_CHUNK_SIZE = 50;
    let jobQueueSuccess = false;
    try {
        for (let i = 0; i < jobsToQueue.length; i += JOB_CHUNK_SIZE) {
            await env.JOB_QUEUE.send({ jobs: jobsToQueue.slice(i, i + JOB_CHUNK_SIZE) });
        }
        queueMsgs = Math.ceil(jobsToQueue.length / JOB_CHUNK_SIZE);
        logger.info(`[Fetcher] Sent ${jobsToQueue.length} jobs in ${queueMsgs} queue messages`);
        jobQueueSuccess = true;
    } catch (err) {
        logger.error(`[Fetcher] JOB_QUEUE send failed: ${err.message}. Falling back to direct evaluation.`);
    }

    // ── Daily Metrics (Phase 1: Core crawl + job metrics) ──────────────────
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
    if (!jobQueueSuccess && jobsToQueue.length > 0) {
        try {
            const fakeMessages = [{ body: { jobs: jobsToQueue }, ack() { }, retry() { } }];
            await evaluateJobs(fakeMessages, env);
            logger.info(`[Fetcher] Direct evaluation completed for ${jobsToQueue.length} jobs`);
        } catch (evalErr) {
            logger.error(`[Fetcher] Direct evaluation fallback failed: ${evalErr.message}`);
        }
    }

    // Source Discovery (Layer 3+4)
    let newAts = 0, newDomains = 0;
    try {
        const jobUrls = jobs.map(j => j.link).filter(Boolean);
        const knownUrls = new Set(allSources.map(s => s.url));
        const { sources: newSources, domains: discoveredDomains } = detectAtsSourcesWithDomains(jobUrls, knownUrls);

        for (const src of newSources) {
            await registerDiscoveredSource(env.DB, src);
        }
        newAts = newSources.length;
        if (newAts > 0) logger.info(`[Discovery] Auto-registered ${newAts} new ATS sources`);

        for (const { domain, sourceUrl } of discoveredDomains.slice(0, 20)) {
            await registerDomain(env.DB, domain, sourceUrl);
        }
        newDomains = Math.min(discoveredDomains.length, 20);
        if (newDomains > 0) logger.info(`[Discovery] Queued ${newDomains} domains for career detection`);
    } catch (err) {
        logger.warn(`[Discovery] Source detection failed: ${err.message}`);
    }

    // Record yield for intelligence layer
    for (const fs of feedStats) {
        if (!fs.error) {
            const sourceNewJobs = perSourceNewJobs.get(fs.url) || 0;
            try { await recordSourceYield(env.DB, fs.url, sourceNewJobs, fs.count || 0); } catch (err) { logger.warn(`[Fetcher] recordSourceYield failed: ${err.message}`); }
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

    logger.info(`[Fetcher] Harvest complete. Inserted ${newlyInsertedCount} new jobs (${duplicateCount} dupes filtered).`);

    for (const msg of messages) {
        msg.ack();
    }
}

// ── 2. Evaluator (Consumes JOB_QUEUE) ────────────────────────────────────────
async function evaluateJobs(messages, env) {
    const config = loadConfig();

    const profiles = await getActiveProfiles(env.DB);
    let activeProfiles = profiles.length ? profiles : [{ id: 'default', notification_threshold: config.notificationThreshold }];

    const prefWeights = await getPreferenceWeights(env.SEEN_JOBS);

    const thresholdContext = await getEffectiveThreshold(env.SEEN_JOBS, config.notificationThreshold);
    const globalThreshold = thresholdContext.effective;

    // Pre-compute profile embedding ONCE (same config for all jobs/profiles)
    const profileSpecs = [...(config.searchRules?.mustMatch || []), ...(config.searchRules?.niceToHave || [])].join(' ');
    const profileVector = await generateEmbedding(env.AI, profileSpecs);
    let aiCallsCount = 1; // Count the profile embedding call
    let alertsQueued = 0;
    let scoreSum = 0;
    let scoreMax = 0;

    for (const msg of messages) {
        // Support both batched format { jobs: [...] } and legacy single job format
        const msgJobs = msg.body.jobs || [msg.body];

        for (const job of msgJobs) {
            if (!isNewJob(job, config.timeWindowHours)) {
                continue;
            }

            const jobTextForAi = `${job.title} ${job.company || ''} ${job.categories?.join(' ') || ''}`;
            const jobVector = await generateEmbedding(env.AI, jobTextForAi);
            aiCallsCount++;

            for (const profile of activeProfiles) {
                if (await hasSentAlert(env.DB, job.id, profile.id)) {
                    continue;
                }

                const tempResult = scoreJob(job, config, { totalDocs: 1, termCounts: {} });
                const localTerms = tempResult.matchedSkills || [];
                const idfData = await getGlobalTermFrequencies(env.DB, localTerms);

                const semanticSim = cosineSimilarity(jobVector, profileVector);

                let scoreResult = scoreJob(job, config, idfData, semanticSim);

                if (scoreResult.excluded) continue;

                const { adjustedScore, feedbackDelta } = applyFeedbackBoost(scoreResult, prefWeights);
                if (feedbackDelta !== 0) {
                    scoreResult.score = adjustedScore;
                    if (!scoreResult.breakdown) scoreResult.breakdown = {};
                    scoreResult.breakdown.feedbackBoost = feedbackDelta;
                }

                await recordJobScore(env.SEEN_JOBS, scoreResult.score);

                const threshold = profile.notification_threshold || globalThreshold;

                if (scoreResult.score >= threshold) {
                    logger.info(`🚨 [Evaluator] Match for profile ${profile.id}: [${scoreResult.score}] ${job.title}`);

                    try {
                        await env.ALERT_QUEUE.send({
                            profileId: profile.id,
                            job: job,
                            scoreResult: scoreResult
                        });
                    } catch (queueErr) {
                        // DIRECT FALLBACK: Send alert inline when ALERT_QUEUE is rate-limited
                        logger.warn(`[Evaluator] ALERT_QUEUE failed, sending alert directly: ${queueErr.message}`);
                        try {
                            await sendAlert(job, scoreResult, {
                                dryRun: config.dryRun,
                                config,
                                env,
                                attempt: 1
                            });
                        } catch (alertErr) {
                            logger.error(`[Evaluator] Direct alert also failed: ${alertErr.message}`);
                        }
                    }

                    await markAlertSent(env.DB, job.id, profile.id);
                    alertsQueued++;
                    scoreSum += scoreResult.score;
                    scoreMax = Math.max(scoreMax, scoreResult.score);
                }
            }
        }

        msg.ack();
    }

    // ── Auto-adjust threshold for next run based on this run's match count ──
    try {
        await getEffectiveThreshold(env.SEEN_JOBS, config.notificationThreshold, { matchedLastRun: alertsQueued });
    } catch (err) { logger.warn(`[Evaluator] Threshold auto-adjust failed: ${err.message}`); }

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
                attempt: msg.attempts || 1
            });

            if (stats.sent > 0) {
                logger.info(`[Sender] Alert successfully delivered to profile ${profileId}`);
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

// ── Worker Export ─────────────────────────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === '/health') {
            const envCheck = validateEnv(env);
            return jsonResponse({
                status: 'ok',
                version: '5.1.0',
                architecture: 'event-driven-queues',
                timestamp: new Date().toISOString(),
                secrets: envCheck.valid ? 'all configured' : `missing: ${envCheck.missing.join(', ')}`,
            });
        }

        if (url.pathname === '/metrics') {
            try {
                const metrics = await getSourceMetrics(env.DB);
                return jsonResponse({
                    status: 'ok',
                    version: '5.1.0',
                    timestamp: new Date().toISOString(),
                    ...metrics,
                });
            } catch (err) {
                return jsonResponse({ status: 'error', message: err.message }, 500);
            }
        }

        if (url.pathname === '/report') {
            try {
                // Support ?date=YYYY-MM-DD to view any day's report (default: today)
                const reportDate = url.searchParams.get('date') || undefined;
                const data = await getDailyReportData(env.DB, { reportDate });
                const report = formatDailyReport(data);
                if (request.method === 'POST') {
                    const result = await sendDailyReport(env.DB, env, { reportDate });
                    return jsonResponse({ status: 'ok', sent: result.sent, channels: result.channels, report });
                }
                return new Response(report, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
            } catch (err) {
                return jsonResponse({ status: 'error', message: err.message }, 500);
            }
        }

        if (url.pathname === '/trigger' && request.method === 'POST') {
            try {
                const config = loadConfig();
                const allSources = buildSourceList(config);

                // Try queue-based dispatch first
                let sent = 0;
                let queueFailed = false;
                try {
                    const batchMessages = allSources.map(s => ({ body: s }));
                    for (let i = 0; i < batchMessages.length; i += 100) {
                        await env.FEED_QUEUE.sendBatch(batchMessages.slice(i, i + 100));
                    }
                    sent = allSources.length;
                } catch (err) {
                    logger.warn(`[Trigger] Queue send failed: ${err.message}. Using direct processing.`);
                    queueFailed = true;
                }

                // DIRECT FALLBACK: Process feeds inline when queues are rate-limited
                // Process 5 sources per batch with a 25-second wall-time guard
                if (queueFailed) {
                    const startTime = Date.now();
                    const WALL_TIME_LIMIT_MS = 25_000; // Stop before 30s Worker timeout
                    const DIRECT_BATCH_SIZE = 5;
                    const fakeMessages = allSources.map(s => ({ body: s, ack() { }, retry() { } }));
                    for (let i = 0; i < fakeMessages.length; i += DIRECT_BATCH_SIZE) {
                        if (Date.now() - startTime > WALL_TIME_LIMIT_MS) {
                            logger.warn(`[Trigger] Wall-time guard: processed ${sent}/${allSources.length} sources in ${((Date.now() - startTime) / 1000).toFixed(1)}s, deferring rest.`);
                            break;
                        }
                        try {
                            await processFeeds(fakeMessages.slice(i, i + DIRECT_BATCH_SIZE), env);
                            sent += Math.min(DIRECT_BATCH_SIZE, fakeMessages.length - i);
                        } catch (err) {
                            logger.error(`[Trigger] Direct batch ${Math.floor(i / DIRECT_BATCH_SIZE)} failed: ${err.message}`);
                        }
                    }
                    return jsonResponse({ status: 'ok', mode: 'direct', msg: `Processed ${sent}/${allSources.length} sources directly (queues rate-limited). Remaining will be picked up by next cron.` });
                }

                return jsonResponse({ status: 'ok', msg: `Triggered ${sent}/${allSources.length} source messages to queue.` });
            } catch (err) {
                return jsonResponse({ status: 'error', message: err.message }, 500);
            }
        }

        return jsonResponse({ status: 'ok', version: '5.1.0' });
    },

    /**
     * Cron producer — Self-Expanding Engine scheduler.
     */
    async scheduled(event, env, ctx) {
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
        } catch (err) { logger.warn(`[Producer] D1 registry query failed: ${err.message}`); }

        const configUrls = new Set(configSources.map(s => s.url));
        const additionalSources = registrySources.filter(s => !configUrls.has(s.url));
        const allSources = [...configSources, ...additionalSources];

        // ── 2. Priority-based source selection ────────────────────────────────
        let sourcesToCrawl;
        if (isIntelEnabled) {
            try {
                const prioritySources = await getSourcesForCycle(env.DB, cycleNumber);
                sourcesToCrawl = [
                    ...configSources,
                    ...prioritySources.filter(s => !configUrls.has(s.url)),
                ];
                logger.info(`[Producer] Intelligence: ${sourcesToCrawl.length} sources selected (${configSources.length} config + ${prioritySources.filter(s => !configUrls.has(s.url)).length} registry)`);
            } catch (err) {
                logger.warn(`[Producer] Intelligence fallback: ${err.message}`);
                sourcesToCrawl = allSources;
            }
        } else {
            sourcesToCrawl = allSources;
        }

        logger.info(`[Producer] Broadcasting ${sourcesToCrawl.length} sources to FEED_QUEUE...`);

        // Use batch send to avoid queue rate limiting
        let queueSuccess = false;
        try {
            const batchMessages = sourcesToCrawl.map(s => ({ body: s }));
            // sendBatch supports up to 100 messages per call
            for (let i = 0; i < batchMessages.length; i += 100) {
                await env.FEED_QUEUE.sendBatch(batchMessages.slice(i, i + 100));
            }
            logger.info(`[Producer] Successfully queued ${sourcesToCrawl.length} sources`);
            queueSuccess = true;
        } catch (err) {
            logger.error(`[Producer] Queue send failed: ${err.message}. Falling back to DIRECT processing.`);
        }

        // ── DIRECT FALLBACK: Process feeds inline when queues are rate-limited ──
        // Use a wall-time guard to stop before the Worker timeout (30s for cron on free tier)
        if (!queueSuccess) {
            const directStart = Date.now();
            const WALL_TIME_LIMIT_MS = 25_000; // Stop before 30s Worker timeout
            const DIRECT_BATCH_SIZE = 5; // Smaller batches for faster turnaround
            let directProcessed = 0;
            logger.info(`[Producer] Direct mode: processing ${sourcesToCrawl.length} sources inline...`);
            const fakeMessages = sourcesToCrawl.map(s => ({ body: s, ack() { }, retry() { } }));
            for (let i = 0; i < fakeMessages.length; i += DIRECT_BATCH_SIZE) {
                if (Date.now() - directStart > WALL_TIME_LIMIT_MS) {
                    logger.warn(`[Producer] Wall-time guard: processed ${directProcessed}/${sourcesToCrawl.length} sources in ${((Date.now() - directStart) / 1000).toFixed(1)}s, deferring rest to next cycle.`);
                    break;
                }
                try {
                    await processFeeds(fakeMessages.slice(i, i + DIRECT_BATCH_SIZE), env);
                    directProcessed += Math.min(DIRECT_BATCH_SIZE, fakeMessages.length - i);
                } catch (err) {
                    logger.error(`[Producer] Direct batch ${Math.floor(i / DIRECT_BATCH_SIZE)} failed: ${err.message}`);
                }
            }
            logger.info(`[Producer] Direct processing: ${directProcessed}/${sourcesToCrawl.length} sources completed.`);
        }

        // ── 3. Periodic intelligence tasks ────────────────────────────────────

        if (isIntelEnabled && cycleNumber % (intel.recalcIntervalCycles || 4) === 0) {
            try {
                const updated = await recalculatePriorities(env.DB);
                logger.info(`[Intelligence] Priority recalculation: ${updated} sources updated`);
            } catch (err) {
                logger.warn(`[Intelligence] Priority recalc failed: ${err.message}`);
            }
        }

        if (isIntelEnabled && cycleNumber % (intel.careerProbeIntervalCycles || 12) === 0) {
            try {
                const domains = await getPendingDomains(env.DB, intel.maxCareerProbes || 5);
                if (domains.length > 0) {
                    const registered = await probeDomainsForCareers(env.DB, domains, intel.maxCareerProbes || 5);
                    logger.info(`[CareerDetector] Probed ${domains.length} domains, registered ${registered.length} career pages`);
                    if (registered.length > 0) {
                        await incrementDailyMetrics(env.DB, { new_sources_career: registered.length });
                    }
                }
            } catch (err) {
                logger.warn(`[CareerDetector] Career probing failed: ${err.message}`);
            }
        }

        if (isIntelEnabled && config.searchExpansion?.enabled && cycleNumber % (intel.searchIntervalCycles || 24) === 0) {
            try {
                const knownUrls = new Set(allSources.map(s => s.url));
                const { newAtsSources, newDomains } = await runSearchExpansion(
                    env.DB,
                    config.searchExpansion.queries || [],
                    knownUrls,
                    config.searchExpansion.maxSearchesPerCycle || 3,
                    config.searchExpansion.maxDomainsPerSearch || 10
                );
                logger.info(`[SearchExpander] Expansion: ${newAtsSources} ATS sources, ${newDomains} domains queued`);
                if (newAtsSources > 0 || newDomains > 0) {
                    await incrementDailyMetrics(env.DB, { new_sources_search: newAtsSources, new_domains_queued: newDomains });
                }
            } catch (err) {
                logger.warn(`[SearchExpander] Search expansion failed: ${err.message}`);
            }
        }

        try {
            await cleanupStaleJobs(env.DB, 30);
        } catch (err) { logger.warn(`[Producer] Cleanup failed: ${err.message}`); }

        // ── Daily Metrics: track cycle ─────────────────────────────────────
        try {
            await incrementDailyMetrics(env.DB, { cycles_completed: 1, worker_invocations: 1 });
        } catch (err) { logger.error(`[Producer] Daily metrics update failed: ${err.message}`); }

        // ── Daily Intelligence Report (trigger at midnight UTC cycle) ──────
        const hourUTC = new Date().getUTCHours();
        const minuteUTC = new Date().getUTCMinutes();
        if (hourUTC === 0 && minuteUTC < 15) {
            try {
                // At midnight UTC, report on the PREVIOUS day's complete data
                const yesterday = new Date(Date.now() - 86400_000).toISOString().split('T')[0];
                const result = await sendDailyReport(env.DB, env, { reportDate: yesterday });
                logger.info(`[DailyReport] Sent to: ${result.channels.join(', ') || 'none'}`);
            } catch (err) {
                logger.warn(`[DailyReport] Failed: ${err.message}`);
            }
        }

        logger.info(`[Producer] Cycle #${cycleNumber} dispatch complete.`);
    },

    async queue(batch, env, ctx) {
        await queueHandler(batch, env);
    }
};
