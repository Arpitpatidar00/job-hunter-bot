-- Migration 0012: Add missing indexes + data cleanup retention
-- Addresses: Full table scans on jobs.company, daily_metrics.date
-- Adds: job_chunks and sent_alerts cleanup retention support

-- Index for detectHiringSurge: GROUP BY company WHERE fetched_at >= ...
CREATE INDEX IF NOT EXISTS idx_jobs_company_created ON jobs(company, fetched_at);

-- Index for daily_metrics date-range queries (detectSkillSpikes)
CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(date);

-- Index for job_chunks cleanup by creation date
CREATE INDEX IF NOT EXISTS idx_job_chunks_created ON job_chunks(created_at);

-- Drop unused feed_health D1 table (feed health is tracked in KV, not D1)
DROP TABLE IF EXISTS feed_health;
