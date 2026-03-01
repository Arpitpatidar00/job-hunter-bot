/**
 * @module db/profiles
 * @description Multi-tenant profile management, alert dedup, and config versioning.
 */

import logger from '../core/logger.js';

/**
 * Fetch all active user profiles.
 *
 * @param {D1Database} db
 * @returns {Promise<Array>}
 */
export async function getActiveProfiles(db) {
    try {
        const result = await db.prepare(
            `SELECT p.id, p.user_id, p.name, p.notification_threshold, u.plan
             FROM profiles p
             JOIN users u ON p.user_id = u.id`
        ).all();
        return result.success ? result.results : [];
    } catch (err) {
        logger.error(`[D1] Failed to fetch profiles: ${err.message}`);
        return [];
    }
}

/**
 * Check if a profile has already been alerted about a job.
 *
 * @param {D1Database} db
 * @param {string} jobId
 * @param {string} profileId
 * @returns {Promise<boolean>}
 */
export async function hasSentAlert(db, jobId, profileId) {
    try {
        const result = await db.prepare(
            `SELECT 1 FROM sent_alerts WHERE job_id = ? AND profile_id = ?`
        ).bind(jobId, profileId).first();
        return !!result;
    } catch (err) {
        logger.error(`[D1] Failed sending dedup check: ${err.message}`);
        return true; // Fail closed (assume sent) to prevent spam
    }
}

/**
 * Record an alert was sent to a profile.
 *
 * @param {D1Database} db
 * @param {string} jobId
 * @param {string} profileId
 */
export async function markAlertSent(db, jobId, profileId) {
    try {
        await db.prepare(
            `INSERT OR IGNORE INTO sent_alerts (job_id, profile_id) VALUES (?, ?)`
        ).bind(jobId, profileId).run();
    } catch (err) {
        logger.error(`[D1] Failed to mark alert sent: ${err.message}`);
    }
}

/**
 * Save a new profile config immutably (versioned).
 *
 * @param {D1Database} db
 * @param {string} profileId
 * @param {object} newConfigObj
 * @param {string} userId
 * @param {string} reason
 */
export async function saveProfileConfigVersion(db, profileId, newConfigObj, userId, reason) {
    const revisionId = crypto.randomUUID();
    const configStr = JSON.stringify(newConfigObj);

    try {
        await db.batch([
            db.prepare(`UPDATE profile_config_history SET is_active = 0 WHERE profile_id = ?`).bind(profileId),
            db.prepare(`
                INSERT INTO profile_config_history (id, profile_id, config_json, changed_by_user_id, change_reason, is_active)
                VALUES (?, ?, ?, ?, ?, 1)
            `).bind(revisionId, profileId, configStr, userId, reason)
        ]);
        logger.info(`[D1] Profile config versioned for ${profileId} (${reason})`);
    } catch (err) {
        logger.error(`[D1] Failed to save config version for ${profileId}: ${err.message}`);
        throw err;
    }
}

/**
 * Load the active configuration for a profile.
 *
 * @param {D1Database} db
 * @param {string} profileId
 * @returns {Promise<object|null>}
 */
export async function getActiveProfileConfig(db, profileId) {
    try {
        const result = await db.prepare(
            `SELECT config_json FROM profile_config_history WHERE profile_id = ? AND is_active = 1`
        ).bind(profileId).first();
        return result ? JSON.parse(result.config_json) : null;
    } catch (err) {
        logger.error(`[D1] Failed to get active config for ${profileId}: ${err.message}`);
        return null;
    }
}
