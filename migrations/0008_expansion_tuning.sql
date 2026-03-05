-- Job Hunter Bot v5 D1 Schema (Phase 8 - Expansion Tuning)
-- Adds dedup ratio tracking and discovery timestamp for exploration bonus.

ALTER TABLE source_registry ADD COLUMN dup_ratio REAL DEFAULT 0;
ALTER TABLE source_registry ADD COLUMN discovered_at DATETIME DEFAULT NULL;

-- Backfill existing sources with current timestamp
UPDATE source_registry SET discovered_at = CURRENT_TIMESTAMP WHERE discovered_at IS NULL;

-- Index for exploration bonus: find recently discovered sources quickly
CREATE INDEX IF NOT EXISTS idx_source_discovered ON source_registry(discovered_at, enabled);
