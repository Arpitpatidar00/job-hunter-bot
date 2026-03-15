-- Migration 0016: Discovery 10/10 metric columns
-- Adds per-vector discovery metric columns to daily_metrics table.
-- These columns were being buffered by worker.js but silently dropped
-- by dailyReport.js because they didn't exist in the schema.

-- Per-vector discovery counters
ALTER TABLE daily_metrics ADD COLUMN new_sources_infra INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_metrics ADD COLUMN new_sources_ecosystem INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_metrics ADD COLUMN new_sources_job_board INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_metrics ADD COLUMN new_sources_api INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_metrics ADD COLUMN new_sources_dataset INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_metrics ADD COLUMN new_sources_web_mining INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_metrics ADD COLUMN new_sources_financial INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_metrics ADD COLUMN financial_signals_detected INTEGER NOT NULL DEFAULT 0;

-- Add jobs_evaluated column if not already present (was in KNOWN_METRIC_COLUMNS but not schema)
ALTER TABLE daily_metrics ADD COLUMN jobs_evaluated INTEGER NOT NULL DEFAULT 0;

-- Domain registry: add next_scan_at and score for scheduling
ALTER TABLE domain_registry ADD COLUMN next_scan_at DATETIME;
ALTER TABLE domain_registry ADD COLUMN score REAL DEFAULT 0;

-- Index for domain re-scan scheduling
CREATE INDEX IF NOT EXISTS idx_domain_registry_next_scan
    ON domain_registry(next_scan_at)
    WHERE status IN ('pending', 'dead');
