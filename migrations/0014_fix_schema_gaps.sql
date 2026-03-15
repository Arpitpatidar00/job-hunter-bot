-- Migration 0014: Fix Schema Gaps
-- Apply missing schema updates that were skipped during initial deployments.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Feed Health Records (recreation to fix missing primary key / columns)
-- ═══════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS feed_health;

CREATE TABLE feed_health (
    url_hash TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    consecutive_failures INTEGER DEFAULT 0,
    total_latency_ms INTEGER DEFAULT 0,
    sample_count INTEGER DEFAULT 0,
    last_seen TEXT,
    last_error TEXT DEFAULT '',
    etag TEXT,
    last_modified TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feed_health_url ON feed_health(url);
CREATE INDEX IF NOT EXISTS idx_feed_health_failures ON feed_health(consecutive_failures DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Threshold State
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS threshold_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Score Histogram
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS score_histogram (
    date TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    count INTEGER DEFAULT 0,
    PRIMARY KEY (date, bucket)
);

CREATE INDEX IF NOT EXISTS idx_score_histogram_date ON score_histogram(date);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Daily Metrics
-- ═══════════════════════════════════════════════════════════════════════════
-- The previous ALTER TABLE failed across migrations if it wasn't there.
-- Let's ensure 'jobs_evaluated' is added to daily_metrics.
ALTER TABLE daily_metrics ADD COLUMN jobs_evaluated INTEGER NOT NULL DEFAULT 0;
