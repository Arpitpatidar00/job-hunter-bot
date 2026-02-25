/**
 * @module logger
 * @description Structured logging via Winston — console + file output.
 */

import winston from 'winston';
import path from 'path';
import fs from 'fs';

const LOG_DIR = path.resolve('logs');

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'job-hunter-bot' },
    transports: [
        // JSON file transport
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'app.log'),
            maxsize: 5 * 1024 * 1024, // 5 MB
            maxFiles: 3,
        }),
        // Colorized console transport
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    const metaStr = Object.keys(meta).length > 1 // > 1 because 'service' is always present
                        ? ` ${JSON.stringify(meta)}`
                        : '';
                    return `${timestamp} [${level}]: ${message}${metaStr}`;
                })
            ),
        }),
    ],
});

export default logger;
