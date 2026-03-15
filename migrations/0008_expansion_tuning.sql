-- Job Hunter Bot v5 D1 Schema (Phase 8 - Expansion Tuning)
-- Adds discovery timestamp for exploration bonus.
-- NOTE: dup_ratio already added in 0007_dup_ratio_tracking.sql

ALTER TABLE source_registry ADD COLUMN discovered_at DATETIME DEFAULT NULL;

-- Backfill existing sources with current timestamp
UPDATE source_registry SET discovered_at = CURRENT_TIMESTAMP WHERE discovered_at IS NULL;

-- Index for exploration bonus: find recently discovered sources quickly
CREATE INDEX IF NOT EXISTS idx_source_discovered ON source_registry(discovered_at, enabled);
