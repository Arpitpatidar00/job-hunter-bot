-- Fix 12: Per-source alert quality metrics
-- Adds alert_rate and avg_score columns to source_registry
-- These enable data-driven source quality ranking and auto-disable decisions.

ALTER TABLE source_registry ADD COLUMN avg_score REAL DEFAULT 0;
ALTER TABLE source_registry ADD COLUMN alert_rate REAL DEFAULT 0;
