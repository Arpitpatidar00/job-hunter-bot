/**
 * @module storage
 * @description Map-based seen-jobs storage with atomic saves, backups, and graceful error handling.
 */

import fs from 'fs';
import path from 'path';
import logger from './logger.js';

/**
 * Load seen jobs from a JSON file into a Map<string, number> (jobId → timestamp).
 * @param {string} filePath - Path to the seen_jobs.json file.
 * @returns {Map<string, number>} Map of job IDs to timestamps.
 */
export function loadSeenJobs(filePath) {
    const resolved = path.resolve(filePath);
    try {
        if (!fs.existsSync(resolved)) {
            logger.info(`No existing seen jobs file at "${resolved}", starting fresh.`);
            return new Map();
        }

        const raw = fs.readFileSync(resolved, 'utf8');
        const data = JSON.parse(raw);

        // Support legacy format (plain array of IDs) and new format (object { id: timestamp })
        if (Array.isArray(data)) {
            logger.info(`Migrating legacy seen jobs array (${data.length} entries) to Map format.`);
            const map = new Map();
            for (const id of data) {
                map.set(id, Date.now());
            }
            return map;
        }

        if (typeof data === 'object' && data !== null) {
            const map = new Map(Object.entries(data));
            logger.info(`Loaded ${map.size} previously seen jobs.`);
            return map;
        }

        logger.warn(`Unexpected data format in "${resolved}", starting fresh.`);
        return new Map();
    } catch (err) {
        logger.error(`Failed to load seen jobs from "${resolved}": ${err.message}`);
        return new Map();
    }
}

/**
 * Save seen jobs Map to a JSON file with atomic write and backup.
 * @param {string} filePath - Path to the seen_jobs.json file.
 * @param {Map<string, number>} seenJobs - Map of job IDs to timestamps.
 */
export function saveSeenJobs(filePath, seenJobs) {
    const resolved = path.resolve(filePath);
    const tmpPath = `${resolved}.tmp`;
    const backupPath = `${resolved}.bak`;

    try {
        const data = Object.fromEntries(seenJobs);
        const json = JSON.stringify(data, null, 2);

        // Write to temp file first (atomic)
        fs.writeFileSync(tmpPath, json, 'utf8');

        // Create backup of existing file
        if (fs.existsSync(resolved)) {
            fs.copyFileSync(resolved, backupPath);
        }

        // Rename temp → actual (atomic on most OS)
        fs.renameSync(tmpPath, resolved);

        // Silent save — summary logged by index.js
    } catch (err) {
        logger.error(`Failed to save seen jobs to "${resolved}": ${err.message}`);
        // Clean up temp file if it exists
        try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch { /* ignore cleanup errors */ }
    }
}

/**
 * Mark a job as seen.
 * @param {Map<string, number>} seenJobs - The seen jobs map.
 * @param {string} id - Job identifier (guid or link).
 */
export function markSeen(seenJobs, id) {
    seenJobs.set(id, Date.now());
}

/**
 * Check if a job has been seen before.
 * @param {Map<string, number>} seenJobs - The seen jobs map.
 * @param {string} id - Job identifier (guid or link).
 * @returns {boolean}
 */
export function hasSeen(seenJobs, id) {
    return seenJobs.has(id);
}
