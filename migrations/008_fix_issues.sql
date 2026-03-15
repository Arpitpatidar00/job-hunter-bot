-- Migration 008: Add missing columns required by the production fix plan
-- Run with: wrangler d1 execute JOB_HUNTER_DB --file=migrations/008_fix_issues.sql
--
-- NOTE: D1 does not support "IF NOT EXISTS" on ALTER TABLE.
-- Columns already present from prior migrations are commented out.

-- source_registry: these columns already exist from 0005 + 0006:
--   last_new_job_at (0006), consecutive_failures (0005),
--   failure_count (0005), discovery_origin (0005)
-- Only last_error is new:
-- ALTER TABLE source_registry ADD COLUMN last_error TEXT DEFAULT '';

-- jobs: track score and score breakdown for distribution reporting
ALTER TABLE jobs ADD COLUMN score REAL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN score_breakdown TEXT DEFAULT '{}';

-- Performance indexes for report queries
CREATE INDEX IF NOT EXISTS idx_jobs_fetched_score   ON jobs(fetched_at, score);
CREATE INDEX IF NOT EXISTS idx_sources_consec_fail  ON source_registry(consecutive_failures DESC);
CREATE INDEX IF NOT EXISTS idx_sources_priority     ON source_registry(priority_score DESC);
