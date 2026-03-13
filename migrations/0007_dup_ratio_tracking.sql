-- Fix 3: Add dup_ratio tracking columns to source_registry
-- Tracks per-source duplicate ratio and consecutive high-dup streaks
-- to enable automatic throttling of low-value sources.

ALTER TABLE source_registry ADD COLUMN dup_ratio REAL DEFAULT 0;
ALTER TABLE source_registry ADD COLUMN high_dup_streak INTEGER DEFAULT 0;
