/**
 * @module config
 * @description Loads configuration from config.json, validates with Joi, and merges CLI overrides via yargs.
 * Supports the full weighted-scoring config schema (searchRules, weights, synonyms, etc.).
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

    // ── Scoring search rules ────────────────────────────────────────────
    searchRules: Joi.object({
        mustMatch: Joi.array().items(Joi.string()).default([]),
        shouldMatch: Joi.array().items(Joi.string()).default([]),
        niceToHave: Joi.array().items(Joi.string()).default([]),
        exclude: Joi.array().items(Joi.string()).default([]),
    }).default({ mustMatch: [], shouldMatch: [], niceToHave: [], exclude: [] }),

    targetRoles: Joi.array().items(Joi.string()).default([]),
    experienceLevel: Joi.array().items(Joi.string()).default([]),

    synonyms: Joi.object().pattern(Joi.string(), Joi.array().items(Joi.string())).default({}),

    // ── Weighted scoring ────────────────────────────────────────────────
    weights: Joi.object({
        titleMatch: Joi.number().min(0).max(100).default(30),
        skillsMatch: Joi.number().min(0).max(100).default(30),
        techStackMatch: Joi.number().min(0).max(100).default(20),
        locationMatch: Joi.number().min(0).max(100).default(10),
        salaryMatch: Joi.number().min(0).max(100).default(10),
    }).default(),

    scoringBonuses: Joi.object({
        nextjsAndTypescript: Joi.number().default(8),
        nodeAndMongodb: Joi.number().default(6),
        awsPresent: Joi.number().default(4),
        fullMernStack: Joi.number().default(10),
        remoteIndia: Joi.number().default(5),
    }).default(),

    scoringPenalties: Joi.object({
        nonJsStack: Joi.number().max(0).default(-15),
        frontendOnlyNoBackend: Joi.number().max(0).default(-5),
        differentPrimaryLanguage: Joi.number().max(0).default(-10),
    }).default(),

    notificationThreshold: Joi.number().integer().min(0).max(100).default(65),

    // ── Filters ─────────────────────────────────────────────────────────
    filters: Joi.object({
        workPreference: Joi.array().items(Joi.string()).default(['remote']),
        locations: Joi.array().items(Joi.string()).default([]),
        minSalaryUSD: Joi.number().min(0).default(0),
        minPrimaryMatches: Joi.number().integer().min(0).default(3),
    }).default(),

    locationKeywords: Joi.array().items(Joi.string()).min(1).default(['remote']),
    regexKeywords: Joi.array().items(Joi.string()).default([]),

    // ── Operational ─────────────────────────────────────────────────────
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
