/**
 * @module db/profiles
 * @description Multi-tenant profile management, alert dedup, and config versioning.
 */

import logger from "../core/logger.js";

/**
 * Fetch all active user profiles.
 *
 * @param {D1Database} db
 * @returns {Promise<Array>}
 */
export async function getActiveProfiles(db) {
  try {
    const result = await db
      .prepare(
        `SELECT p.id, p.user_id, p.name, p.notification_threshold, u.plan
             FROM profiles p
             JOIN users u ON p.user_id = u.id`,
      )
      .all();
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
    const result = await db
      .prepare(`SELECT 1 FROM sent_alerts WHERE job_id = ? AND profile_id = ?`)
      .bind(jobId, profileId)
      .first();
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
/**
 * Record an alert was sent to a profile.
 * Issue 2 fix: Verify the job exists in the DB first to avoid
 * D1_ERROR: FOREIGN KEY constraint failed, which causes duplicate alert risk.
 *
 * @param {D1Database} db
 * @param {string} jobId
 * @param {string} profileId
 */
export async function markAlertSent(db, jobId, profileId) {
  try {
    // Guard: only insert if the job row still exists (prevents FK violation)
    const jobExists = await db
      .prepare(`SELECT 1 FROM jobs WHERE id = ? LIMIT 1`)
      .bind(jobId)
      .first();

    if (!jobExists) {
      logger.warn(
        `[D1] markAlertSent skipped: job ${jobId} not found in jobs table (FK guard)`,
      );
      return;
    }

    await db
      .prepare(
        `INSERT OR IGNORE INTO sent_alerts (job_id, profile_id) VALUES (?, ?)`,
      )
      .bind(jobId, profileId)
      .run();
  } catch (err) {
    logger.error(`[D1] Failed to mark alert sent: ${err.message}`);
  }
}

/**
 * Fetch all sent alerts for a given set of job IDs in one query to avoid N+1 reads.
 *
 * @param {D1Database} db
 * @param {string[]} jobIds
 * @returns {Promise<Set<string>>} Set of "jobId:profileId" pairs
 */
export async function getSentAlertsForJobs(db, jobIds) {
  if (!jobIds || jobIds.length === 0) return new Set();

  try {
    const placeholders = jobIds.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT job_id, profile_id FROM sent_alerts WHERE job_id IN (${placeholders})`,
      )
      .bind(...jobIds)
      .all();

    const sentPairs = new Set();
    if (result.success && result.results) {
      for (const row of result.results) {
        sentPairs.add(`${row.job_id}:${row.profile_id}`);
      }
    }
    return sentPairs;
  } catch (err) {
    logger.error(`[D1] Failed to batch fetch sent alerts: ${err.message}`);
    return new Set(); // Fail closed
  }
}

/**
 * Batch insert multiple alert sent records to avoid N+1 writes.
 *
 * @param {D1Database} db
 * @param {Array<{jobId: string, profileId: string}>} alertPairs
 */
export async function batchMarkAlertSent(db, alertPairs) {
  if (!alertPairs || alertPairs.length === 0) return;

  try {
    // Collect all jobIds to check FK constraints in bulk
    const jobIds = [...new Set(alertPairs.map((a) => a.jobId))];
    const placeholders = jobIds.map(() => "?").join(",");
    const existingJobsResult = await db
      .prepare(`SELECT id FROM jobs WHERE id IN (${placeholders})`)
      .bind(...jobIds)
      .all();

    const existingJobs = new Set(
      (existingJobsResult.results || []).map((r) => r.id),
    );

    // Filter valid pairs and create statements
    const validPairs = alertPairs.filter((p) => existingJobs.has(p.jobId));
    if (validPairs.length === 0) return;

    const stmts = validPairs.map((pair) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO sent_alerts (job_id, profile_id) VALUES (?, ?)`,
        )
        .bind(pair.jobId, pair.profileId),
    );

    // Execute in batches of 40 (inside D1 batch limits)
    for (let i = 0; i < stmts.length; i += 40) {
      await db.batch(stmts.slice(i, i + 40));
    }
  } catch (err) {
    logger.error(`[D1] Failed to batch mark alerts sent: ${err.message}`);
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
export async function saveProfileConfigVersion(
  db,
  profileId,
  newConfigObj,
  userId,
  reason,
) {
  const revisionId = crypto.randomUUID();
  const configStr = JSON.stringify(newConfigObj);

  try {
    await db.batch([
      db
        .prepare(
          `UPDATE profile_config_history SET is_active = 0 WHERE profile_id = ?`,
        )
        .bind(profileId),
      db
        .prepare(
          `
                INSERT INTO profile_config_history (id, profile_id, config_json, changed_by_user_id, change_reason, is_active)
                VALUES (?, ?, ?, ?, ?, 1)
            `,
        )
        .bind(revisionId, profileId, configStr, userId, reason),
    ]);
    logger.info(`[D1] Profile config versioned for ${profileId} (${reason})`);
  } catch (err) {
    logger.error(
      `[D1] Failed to save config version for ${profileId}: ${err.message}`,
    );
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
    const result = await db
      .prepare(
        `SELECT config_json FROM profile_config_history WHERE profile_id = ? AND is_active = 1`,
      )
      .bind(profileId)
      .first();
    return result ? JSON.parse(result.config_json) : null;
  } catch (err) {
    logger.error(
      `[D1] Failed to get active config for ${profileId}: ${err.message}`,
    );
    return null;
  }
}
