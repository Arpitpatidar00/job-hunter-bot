-- Migration 0013: Architecture Fixes
-- Moves high-frequency mutable state from KV to D1 to stay within
-- Cloudflare KV free tier limits (~1000 writes/day).
--
-- Before: ~4876 KV writes/day (dominated by feed:health writes)
-- After:  ~120-180 KV writes/day (only cursors, circuit breakers, embeddings)

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Feed Health Records (moved from KV key: feed:health:{urlHash})
--    Previously: ~3840 KV writes/day (40 sources × 96 cron cycles)
--    Now: D1 batch writes (0 KV writes)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS feed_health (
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
-- 2. Threshold State (moved from KV keys: thresh:window, thresh:effective)
--    Previously: ~96 KV writes/day per key
--    Now: D1 upserts (0 KV writes)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS threshold_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Score Histogram (moved from KV key: metrics:score_histogram)
--    Previously: ~96 KV read-modify-writes/day
--    Now: D1 upserts per bucket (0 KV writes)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS score_histogram (
    date TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    count INTEGER DEFAULT 0,
    PRIMARY KEY (date, bucket)
);

CREATE INDEX IF NOT EXISTS idx_score_histogram_date ON score_histogram(date);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Metrics Buffer State (supports in-memory buffer flush)
--    Used to track queue depth for backlog monitoring (Fix 7)
-- ═══════════════════════════════════════════════════════════════════════════

-- Add queue_depth_estimate column to daily_metrics for monitoring
-- (Will fail silently if column already exists in some environments)
ALTER TABLE daily_metrics ADD COLUMN queue_depth_estimate INTEGER DEFAULT 0;
