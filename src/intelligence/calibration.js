/**
 * @module calibration
 * @description Periodic feedback loop that calibrates V4 hybrid scoring
 * thresholds and weights using regression proxies.
 */

import logger from "../core/logger.js";

/**
 * Fetch recent user thumbs feedback from D1 and adjust the global
 * fallback semantic scoring threshold in KV.
 *
 * @param {import('@cloudflare/workers-types').D1Database} dbBinding
 * @param {import('@cloudflare/workers-types').KVNamespace} kvBinding
 */
export async function retrainThresholds(dbBinding, kvBinding) {
  try {
    const { results } = await dbBinding
      .prepare(
        'SELECT score_given, thumbs FROM feedback WHERE created_at > datetime("now", "-7 days")',
      )
      .all();

    if (!results || results.length === 0) {
      logger.info("[Calibration] No recent feedback to calibrate on.");
      return;
    }

    const upvotes = results.filter((r) => r.thumbs === 1);

    let newSemanticThreshold = 0.55; // Default v4 entry

    // Simple proxy regression: threshold = avg(score | thumbs_up) - offset
    if (upvotes.length >= 5) {
      const avgUpvoteScore =
        upvotes.reduce((acc, v) => acc + (v.score_given || 50), 0) /
        upvotes.length;
      newSemanticThreshold = Math.max(0.4, avgUpvoteScore / 100 - 0.15);
    }

    if (kvBinding) {
      await kvBinding.put(
        "scoring:thresholds:v4",
        JSON.stringify({ semantic: newSemanticThreshold }),
      );
      logger.info(
        `[Calibration] Retrained threshold to ${newSemanticThreshold.toFixed(2)} based on ${results.length} total votes.`,
      );
    }
  } catch (e) {
    logger.error(`[Calibration] Failed to retrain threshold: ${e.message}`);
  }
}
