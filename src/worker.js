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
import { detectAtsSources, detectAtsSourcesWithDomains } from './discovery/sourceDiscovery.js';
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

    if (queueName.endsWith('-feed-queue')) {
        await processFeeds(batch.messages, env);
    } else if (queueName.endsWith('-job-queue')) {
        await evaluateJobs(batch.messages, env);
    } else if (queueName.endsWith('-alert-queue')) {
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
    batchConfig.feeds = batchConfig.feeds.filter(url => {
        const isOpen = isFeedCircuitOpen(url);
        if (isOpen) logger.warn(`[Circuit] Skipping ${url} — circuit is OPEN`);
        return !isOpen;
    });

    // Run all connectors in parallel
    const { jobs, feedStats, totalItems, totalErrors } = await runAllConnectors(batchConfig);

    // Record circuit breaker metrics
    let crawlSuccesses = 0;
    let crawlFailures = 0;
    for (const stat of feedStats) {
        recordFeedResult(stat.url, !stat.error);
        if (!stat.error) crawlSuccesses++; else crawlFailures++;
        try {
            await updateSourceStats(env.DB, stat.url, {
                success: !stat.error,
                jobCount: stat.count || 0,
            });
        } catch { /* non-critical */ }
    }

    // Intra-batch dedup + D1 insert + JOB_QUEUE dispatch
    const seenHashes = new Set();
    let newlyInsertedCount = 0;
    let duplicateCount = 0;
    let queueMsgs = 0;
    const batchSkillCounts = {};
    let remoteJobs = 0, hybridJobs = 0, onsiteJobs = 0;
    let salarySum = 0, salaryCount = 0;

    for (const job of jobs) {
        if (job.content_hash && seenHashes.has(job.content_hash)) {
            duplicateCount++;
            continue;
        }
        if (job.content_hash) seenHashes.add(job.content_hash);

        const { inserted } = await insertJobIfNotExists(env.DB, job);
        if (!inserted) { duplicateCount++; continue; }

        newlyInsertedCount++;
        await env.JOB_QUEUE.send(job);
        queueMsgs++;

        // Track market signals
        if (job.matchedTerms?.length) {
            for (const term of job.matchedTerms) {
                batchSkillCounts[term] = (batchSkillCounts[term] || 0) + 1;
            }
            try { await recordTermFrequencies(env.DB, job.matchedTerms); } catch { }
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
        if (fs.success) {
            try { await recordSourceYield(env.DB, fs.url, newlyInsertedCount, fs.count || 0); } catch { }
        }
    }

    // ── Daily Metrics ──────────────────────────────────────────────────────
    try {
        await incrementDailyMetrics(env.DB, {
            sources_scanned: allSources.length,
            crawl_successes: crawlSuccesses,
            crawl_failures: crawlFailures,
            raw_jobs_found: jobs.length,
            unique_jobs_stored: newlyInsertedCount,
            duplicates_filtered: duplicateCount,
            new_sources_ats: newAts,
            new_domains_queued: newDomains,
            remote_jobs: remoteJobs,
            hybrid_jobs: hybridJobs,
            onsite_jobs: onsiteJobs,
            salary_sum: salarySum,
            salary_count: salaryCount,
            worker_invocations: 1,
            d1_writes: newlyInsertedCount + newAts,
            queue_messages: queueMsgs,
            skill_counts: batchSkillCounts,
        });
    } catch { /* non-critical */ }

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

    let aiCallsCount = 0;
    let alertsQueued = 0;
    let scoreSum = 0;
    let scoreMax = 0;

    for (const msg of messages) {
        const job = msg.body;

        if (!isNewJob(job, config.timeWindowHours)) {
            msg.ack();
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

            const profileSpecs = [...(config.searchRules?.mustMatch || []), ...(config.searchRules?.niceToHave || [])].join(' ');
            const profileVector = await generateEmbedding(env.AI, profileSpecs);
            const semanticSim = cosineSimilarity(jobVector, profileVector);
            aiCallsCount++;

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

                await env.ALERT_QUEUE.send({
                    profileId: profile.id,
                    job: job,
                    scoreResult: scoreResult
                });

                await markAlertSent(env.DB, job.id, profile.id);
                alertsQueued++;
                scoreSum += scoreResult.score;
                scoreMax = Math.max(scoreMax, scoreResult.score);
            }
        }

        msg.ack();
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
    } catch { /* non-critical */ }
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
    } catch { /* non-critical */ }
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
                const data = await getDailyReportData(env.DB);
                const report = formatDailyReport(data);
                if (request.method === 'POST') {
                    const result = await sendDailyReport(env.DB, env);
                    return jsonResponse({ status: 'ok', sent: result.sent, channels: result.channels, report });
                }
                return new Response(report, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
            } catch (err) {
                return jsonResponse({ status: 'error', message: err.message }, 500);
            }
        }

        if (url.pathname === '/trigger' && request.method === 'POST') {
            const config = loadConfig();
            let count = 0;
            const allSources = buildSourceList(config);
            for (const source of allSources) {
                await env.FEED_QUEUE.send(source);
                count++;
            }
            return jsonResponse({ status: 'ok', msg: `Triggered ${count} source messages to queue.` });
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
        } catch { /* D1 not ready yet */ }

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

        for (const source of sourcesToCrawl) {
            await env.FEED_QUEUE.send(source);
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
            } catch (err) {
                logger.warn(`[SearchExpander] Search expansion failed: ${err.message}`);
            }
        }

        try {
            await cleanupStaleJobs(env.DB, 30);
        } catch { /* non-critical */ }

        // ── Daily Metrics: track cycle ─────────────────────────────────────
        try {
            await incrementDailyMetrics(env.DB, { cycles_completed: 1, worker_invocations: 1 });
        } catch { /* non-critical */ }

        // ── Daily Intelligence Report (trigger at midnight UTC cycle) ──────
        const hourUTC = new Date().getUTCHours();
        const minuteUTC = new Date().getUTCMinutes();
        if (hourUTC === 0 && minuteUTC < 15) {
            try {
                const result = await sendDailyReport(env.DB, env);
                logger.info(`[DailyReport] Sent to: ${result.channels.join(', ') || 'none'}`);
            } catch (err) {
                logger.warn(`[DailyReport] Failed: ${err.message}`);
            }
        }

        logger.info(`[Producer] Cycle #${cycleNumber} dispatch complete.`);
    },

    async queue(batch, env, ctx) {
        ctx.waitUntil(queueHandler(batch, env));
    }
};
