-- Job Hunter Bot v5 D1 Schema (Phase 5 - Source Registry)
-- Tracks all job sources for observability and reliability tracking.

CREATE TABLE IF NOT EXISTS source_registry (
    url TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'rss',
    name TEXT,
    enabled INTEGER DEFAULT 1,
    discovery_origin TEXT DEFAULT 'manual',  -- 'manual' | 'auto-detected'
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    consecutive_failures INTEGER DEFAULT 0,
    last_fetched_at DATETIME,
    last_job_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast filtering by type and enabled status
CREATE INDEX IF NOT EXISTS idx_source_registry_type
ON source_registry(type, enabled);
