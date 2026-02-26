#!/usr/bin/env node

/**
 * @module index
 * @description Entry point for Job Hunter Bot — polls RSS feeds for relevant remote jobs,
 * scores them 0–100, and sends color-coded alerts to Discord/Telegram.
 */

import 'dotenv/config';
import { loadConfig } from './src/config.js';
import logger from './src/logger.js';
import { loadSeenJobs, saveSeenJobs, markSeen, hasSeen } from './src/storage.js';
import { fetchAllFeeds } from './src/feeds.js';
import { scoreJob, isNewJob } from './src/relevance.js';
import { sendAlert } from './src/notifications.js';

/** @type {Map<string, number>} */
let seenJobs;

/** @type {Readonly<object>} */
let config;

/** @type {NodeJS.Timeout|null} */
let pollTimer = null;

/**
 * Run a single poll cycle: fetch feeds, score jobs, send alerts for high-quality matches.
 */
async function checkFeeds() {
    logger.info(`Checking feeds at ${new Date().toISOString()}...`);

    const stats = { totalItems: 0, evaluated: 0, notified: 0, skipped: 0, excluded: 0, alertsFailed: 0, feedErrors: 0 };
    const threshold = config.notificationThreshold ?? 50;

    try {
        const feedResults = await fetchAllFeeds(config.feeds, config);

        for (const result of feedResults) {
            if (result.error) {
                stats.feedErrors++;
                continue;
            }

            for (const item of result.items) {
                stats.totalItems++;
                const id = item.guid || item.link;
                if (!id) continue;

                if (hasSeen(seenJobs, id)) continue;

                // Always mark as seen to avoid re-processing
                markSeen(seenJobs, id);

                // Time window check
                if (!isNewJob(item, config.timeWindowHours)) continue;

                // Score the job
                const scoreResult = scoreJob(item, config);
                stats.evaluated++;

                // Excluded jobs — silent skip
                if (scoreResult.excluded) {
                    stats.excluded++;
                    continue;
                }

                // Below threshold — silent skip
                if (scoreResult.score < threshold) {
                    stats.skipped++;
                    continue;
                }

                // Log only jobs that pass the threshold
                logger.evaluated(item, scoreResult);

                // Send alert with score data
                const alertStats = await sendAlert(item, scoreResult, {
                    dryRun: config.dryRun,
                    config,
                });
                stats.notified += alertStats.sent;
                stats.alertsFailed += alertStats.failed;
            }
        }

        // Save seen jobs after processing
        saveSeenJobs(config.seenJobsFile, seenJobs);

        // Clean summary — one line, everything you need
        logger.info(
            `Poll complete | Feeds: ${config.feeds.length} (${stats.feedErrors} failed) | ` +
            `Items: ${stats.totalItems} | Evaluated: ${stats.evaluated} | ` +
            `Matched: ${stats.notified} | Excluded: ${stats.excluded} | Skipped: ${stats.skipped}`
        );
    } catch (err) {
        logger.error(`Fatal error during feed check: ${err.message}`, { stack: err.stack });
        try { saveSeenJobs(config.seenJobsFile, seenJobs); } catch { /* last resort */ }
    }
}

/**
 * Graceful shutdown handler — save state and exit.
 * @param {string} signal - The signal that triggered shutdown.
 */
function gracefulShutdown(signal) {
    logger.info(`Received ${signal}. Saving seen jobs and shutting down...`);
    if (pollTimer) clearInterval(pollTimer);
    try {
        saveSeenJobs(config.seenJobsFile, seenJobs);
    } catch (err) {
        logger.error(`Failed to save during shutdown: ${err.message}`);
    }
    logger.info('Job Hunter Bot stopped.');
    process.exit(0);
}

/**
 * Main entry point.
 */
async function main() {
    try {
        // Load configuration (config.json + CLI args)
        config = loadConfig();
        logger.info('Configuration loaded successfully.');
        logger.info(
            `Feeds: ${config.feeds.length} | Threshold: ${config.notificationThreshold} | ` +
            `Interval: ${config.pollIntervalMs / 1000}s | Time window: ${config.timeWindowHours}h`
        );
        if (config.dryRun) {
            logger.info('DRY RUN mode enabled — alerts will be logged but not sent.');
        }

        // Load seen jobs from storage
        seenJobs = loadSeenJobs(config.seenJobsFile);

        // Register graceful shutdown handlers
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

        // Catch unhandled errors to prevent crashes
        process.on('uncaughtException', (err) => {
            logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
            try { saveSeenJobs(config.seenJobsFile, seenJobs); } catch { /* last resort */ }
        });
        process.on('unhandledRejection', (reason) => {
            logger.error(`Unhandled rejection: ${reason}`);
        });

        // Start polling
        logger.info('Job Hunter Bot started.');
        await checkFeeds(); // Initial check

        pollTimer = setInterval(async () => {
            try {
                await checkFeeds();
            } catch (err) {
                logger.error(`Poll cycle error: ${err.message}`, { stack: err.stack });
            }
        }, config.pollIntervalMs);

    } catch (err) {
        // Config loading or startup failure
        console.error(`❌ Startup failed: ${err.message}`);
        process.exit(1);
    }
}

main();