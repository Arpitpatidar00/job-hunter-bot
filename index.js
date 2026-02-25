#!/usr/bin/env node

/**
 * @module index
 * @description Entry point for Job Hunter Bot — polls RSS feeds for relevant remote jobs
 * and sends alerts to Discord/Telegram. Modular, configurable, production-ready.
 */

import 'dotenv/config';
import { loadConfig } from './src/config.js';
import logger from './src/logger.js';
import { loadSeenJobs, saveSeenJobs, markSeen, hasSeen } from './src/storage.js';
import { fetchAllFeeds } from './src/feeds.js';
import { isJobRelevant, isNewJob } from './src/relevance.js';
import { sendAlert } from './src/notifications.js';

/** @type {Map<string, number>} */
let seenJobs;

/** @type {Readonly<object>} */
let config;

/** @type {NodeJS.Timeout|null} */
let pollTimer = null;

/**
 * Run a single poll cycle: fetch feeds, check relevance, send alerts, save state.
 */
async function checkFeeds() {
    logger.info(`🔍 Checking feeds at ${new Date().toISOString()}...`);

    const stats = { totalItems: 0, newRelevant: 0, alertsSent: 0, alertsFailed: 0, feedErrors: 0 };

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

                if (isNewJob(item, config.timeWindowHours) && isJobRelevant(item, config)) {
                    markSeen(seenJobs, id);
                    stats.newRelevant++;

                    const alertStats = await sendAlert(item, { dryRun: config.dryRun, config });
                    stats.alertsSent += alertStats.sent;
                    stats.alertsFailed += alertStats.failed;
                } else {
                    // Mark non-relevant or old jobs as seen to avoid re-checking
                    markSeen(seenJobs, id);
                }
            }
        }

        // Save seen jobs after processing
        saveSeenJobs(config.seenJobsFile, seenJobs);

        // Health check log
        logger.info(
            `✅ Poll complete | Items: ${stats.totalItems} | New relevant: ${stats.newRelevant} | ` +
            `Alerts sent: ${stats.alertsSent} | Alerts failed: ${stats.alertsFailed} | ` +
            `Feed errors: ${stats.feedErrors}`
        );
    } catch (err) {
        logger.error(`Fatal error during feed check: ${err.message}`, { stack: err.stack });
        // Save what we have so far
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
    logger.info('👋 Job Hunter Bot stopped. Goodbye!');
    process.exit(0);
}

/**
 * Main entry point.
 */
async function main() {
    try {
        // Load configuration (config.json + CLI args)
        config = loadConfig();
        logger.info('📋 Configuration loaded successfully.');
        logger.info(`   Feeds: ${config.feeds.length} | Keywords: ${config.profileKeywords.length} | ` +
            `Interval: ${config.pollIntervalMs / 1000}s | Time window: ${config.timeWindowHours}h`);
        if (config.dryRun) {
            logger.info('🧪 DRY RUN mode enabled — alerts will be logged but not sent.');
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
        logger.info('🤖 Job Hunter Bot started!');
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