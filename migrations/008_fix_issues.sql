-- Migration 008: Add missing columns required by the production fix plan
-- Run with: wrangler d1 execute JOB_HUNTER_DB --file=migrations/008_fix_issues.sql
--
-- NOTE: D1 does not support "IF NOT EXISTS" on ALTER TABLE.
-- If a column already exists, skip that statement and continue.

-- source_registry: track consecutive failures and last error
ALTER TABLE source_registry ADD COLUMN last_new_job_at TEXT;
ALTER TABLE source_registry ADD COLUMN consecutive_failures INTEGER DEFAULT 0;
ALTER TABLE source_registry ADD COLUMN last_error TEXT DEFAULT '';
ALTER TABLE source_registry ADD COLUMN failure_count INTEGER DEFAULT 0;
ALTER TABLE source_registry ADD COLUMN discovery_origin TEXT DEFAULT 'config';

-- jobs: track score and score breakdown for distribution reporting
ALTER TABLE jobs ADD COLUMN score REAL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN score_breakdown TEXT DEFAULT '{}';

-- Performance indexes for report queries
CREATE INDEX IF NOT EXISTS idx_jobs_fetched_score   ON jobs(fetched_at, score);
CREATE INDEX IF NOT EXISTS idx_sources_consec_fail  ON source_registry(consecutive_failures DESC);
CREATE INDEX IF NOT EXISTS idx_sources_priority     ON source_registry(priority_score DESC);
