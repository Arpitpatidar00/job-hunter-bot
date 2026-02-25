/**
 * @module config
 * @description Loads configuration from config.json, validates with Joi, and merges CLI overrides via yargs.
 */

import fs from 'fs';
import path from 'path';
import Joi from 'joi';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { parseInterval } from './utils.js';

/**
 * Joi schema for validating the merged configuration.
 */
const configSchema = Joi.object({
    feeds: Joi.array().items(Joi.string().uri()).min(1).required(),
    profileKeywords: Joi.array().items(Joi.string()).min(1).required(),
    locationKeywords: Joi.array().items(Joi.string()).min(1).required(),
    regexKeywords: Joi.array().items(Joi.string()).default([]),
    pollIntervalMs: Joi.number().integer().positive().min(10000).required(),
    timeWindowHours: Joi.number().positive().required(),
    fuzzyThreshold: Joi.number().min(0).max(1).required(),
    maxConcurrentFeeds: Joi.number().integer().positive().max(20).required(),
    maxRetries: Joi.number().integer().positive().max(10).required(),
    seenJobsFile: Joi.string().required(),
    dryRun: Joi.boolean().default(false),
}).options({ stripUnknown: true });

/**
 * Parse CLI arguments using yargs.
 * @returns {object} Parsed CLI arguments.
 */
function parseCLI() {
    return yargs(hideBin(process.argv))
        .usage('Usage: node index.js [options]')
        .option('interval', {
            alias: 'i',
            type: 'string',
            description: 'Poll interval (e.g. "30m", "1h")',
        })
        .option('keywords', {
            alias: 'k',
            type: 'string',
            description: 'Comma-separated profile keywords override',
        })
        .option('dry-run', {
            alias: 'd',
            type: 'boolean',
            description: 'Log alerts without actually sending them',
            default: false,
        })
        .option('config', {
            alias: 'c',
            type: 'string',
            description: 'Path to a custom config.json file',
            default: 'config.json',
        })
        .help()
        .alias('help', 'h')
        .version(false)
        .parseSync();
}

/**
 * Load, merge, and validate configuration.
 * Priority: CLI args > config.json > defaults.
 * @returns {Readonly<object>} Frozen, validated config object.
 */
export function loadConfig() {
    const cli = parseCLI();

    // Load config file
    const configPath = path.resolve(cli.config);
    let fileConfig = {};
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        fileConfig = JSON.parse(raw);
    } catch (err) {
        if (cli.config !== 'config.json') {
            // User explicitly specified a config file that doesn't exist
            throw new Error(`Failed to load config file "${configPath}": ${err.message}`);
        }
        // Default config.json missing — proceed with defaults
        console.warn(`Warning: config.json not found, using defaults.`);
    }

    // Merge CLI overrides
    const merged = { ...fileConfig };

    if (cli.interval) {
        merged.pollIntervalMs = parseInterval(cli.interval);
    }

    if (cli.keywords) {
        merged.profileKeywords = cli.keywords.split(',').map((k) => k.trim().toLowerCase());
    }

    merged.dryRun = cli.dryRun || cli['dry-run'] || false;

    // Validate
    const { error, value } = configSchema.validate(merged);
    if (error) {
        throw new Error(`Config validation error: ${error.details.map((d) => d.message).join(', ')}`);
    }

    return Object.freeze(value);
}
