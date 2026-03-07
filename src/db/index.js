/**
 * @module db
 * @description Barrel export — re-exports all DAL functions for backward compatibility.
 */

export {
  insertJobIfNotExists,
  batchInsertJobs,
  cleanupStaleJobs,
} from "./jobs.js";
export {
  getActiveProfiles,
  hasSentAlert,
  markAlertSent,
  getSentAlertsForJobs,
  batchMarkAlertSent,
  saveProfileConfigVersion,
  getActiveProfileConfig,
} from "./profiles.js";
export {
  registerDiscoveredSource,
  batchRegisterDiscoveredSources,
  getEnabledSources,
  updateSourceStats,
  disableUnreliableSource,
  getSourceMetrics,
} from "./sources.js";
export { recordTermFrequencies, getGlobalTermFrequencies } from "./terms.js";
