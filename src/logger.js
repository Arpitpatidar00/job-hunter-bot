/**
 * @module logger
 * @description Structured, minimal logging via Winston.
 * Produces clean [INFO], [SKIPPED], [NOTIFIED] lines — no raw JSON, no debug spam.
 */

import winston from 'winston';
import path from 'path';
import fs from 'fs';

const LOG_DIR = path.resolve('logs');

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Console format: clean, single-line, human-readable.
 * Strips the default "service" meta so it doesn't clutter output.
 */
const cleanConsoleFormat = winston.format.printf(({ timestamp, level, message }) => {
    return `${timestamp} [${level}]: ${message}`;
});

/**
 * File format: JSON for structured parsing by external tools.
 */
const jsonFileFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true })
    ),
    defaultMeta: { service: 'job-hunter-bot' },
    transports: [
        // JSON file transport
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'app.log'),
            format: jsonFileFormat,
            maxsize: 5 * 1024 * 1024, // 5 MB
            maxFiles: 3,
        }),
        // Clean console transport
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                cleanConsoleFormat
            ),
        }),
    ],
});

// ────────────────────────────────────────────────────────────────────────────
// Structured log helpers — all output follows the master prompt formats.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Log a job evaluation result.
 * Format:
 *   [INFO] Evaluated: <title> @ <company>
 *   Match Score: <score> (<label>)
 *   Reason: <top reasons>
 *
 * @param {{ title: string, creator?: string }} job
 * @param {{ score: number, label: string, reasons: string[] }} scoreResult
 */
logger.evaluated = function (job, scoreResult) {
    const company = job.creator || 'Unknown';
    const topReasons = scoreResult.reasons.slice(0, 4).join(' + ');
    this.info(
        `Evaluated: ${job.title || 'Untitled'} @ ${company}\n` +
        `  Match Score: ${scoreResult.score} (${scoreResult.label})\n` +
        `  Reason: ${topReasons || 'No strong signals'}`
    );
};

/**
 * Log a skipped job.
 * Format:
 *   [SKIPPED] <title> @ <company>
 *   Reason: <reason>
 *
 * @param {{ title: string, creator?: string }} job
 * @param {string} reason
 */
logger.skipped = function (job, reason) {
    const company = job.creator || 'Unknown';
    this.info(
        `[SKIPPED] ${job.title || 'Untitled'} @ ${company}\n` +
        `  Reason: ${reason}`
    );
};

/**
 * Log a notification sent event.
 * Format:
 *   [NOTIFIED] <label> sent to <channels>
 *
 * @param {string} label - e.g. "Strong Match"
 * @param {string[]} channels - e.g. ["Telegram", "Discord"]
 */
logger.notified = function (label, channels) {
    this.info(`[NOTIFIED] ${label} sent to ${channels.join(' & ')}`);
};

export default logger;
