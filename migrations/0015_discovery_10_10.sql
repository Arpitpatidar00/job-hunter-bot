-- Migration 0015: Discovery engine 10/10 upgrade
-- Adds missing fields for full source lifecycle, domain registry enrichment,
-- and discovery metrics tracking.

-- ── Source Registry: Add explicit lifecycle state management ──────────────
-- States: active, cooldown, low_yield, blocked, dead
ALTER TABLE source_registry ADD COLUMN state TEXT DEFAULT 'active';
ALTER TABLE source_registry ADD COLUMN state_reason TEXT;
ALTER TABLE source_registry ADD COLUMN state_updated_at DATETIME;
ALTER TABLE source_registry ADD COLUMN ats_platform TEXT;
ALTER TABLE source_registry ADD COLUMN last_success_at DATETIME;
ALTER TABLE source_registry ADD COLUMN last_failure_at DATETIME;

-- Index for state-based queries
CREATE INDEX IF NOT EXISTS idx_source_registry_state
    ON source_registry(state, enabled);

-- ── Domain Registry: Add discovery vector tracking ───────────────────────
ALTER TABLE domain_registry ADD COLUMN discovery_vector TEXT;
ALTER TABLE domain_registry ADD COLUMN ats_detected TEXT;
ALTER TABLE domain_registry ADD COLUMN probe_count INTEGER DEFAULT 0;
ALTER TABLE domain_registry ADD COLUMN last_discovery_at DATETIME;

-- Index for vector-based analysis
CREATE INDEX IF NOT EXISTS idx_domain_registry_vector
    ON domain_registry(discovery_vector, status);

-- ── Discovery Metrics Table ──────────────────────────────────────────────
-- Tracks per-vector performance metrics for tuning and monitoring
CREATE TABLE IF NOT EXISTS discovery_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_date TEXT NOT NULL DEFAULT (date('now')),
    vector TEXT NOT NULL,
    domains_found INTEGER DEFAULT 0,
    sources_registered INTEGER DEFAULT 0,
    probes_attempted INTEGER DEFAULT 0,
    probes_successful INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_discovery_metrics_date
    ON discovery_metrics(metric_date, vector);

-- ── Raise source cap tracking ────────────────────────────────────────────
-- Source cap increased from 2000 to 10000 to support 3000-10000 target sources
-- (Implemented in code, not schema — but document the intent here)

-- ── Discovery Queue State ────────────────────────────────────────────────
-- Tracks queued discovery tasks for the new discovery_queue
CREATE TABLE IF NOT EXISTS discovery_queue_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vector TEXT NOT NULL,
    payload TEXT,
    status TEXT DEFAULT 'pending',  -- 'pending' | 'processing' | 'completed' | 'failed'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_discovery_queue_status
    ON discovery_queue_state(status, created_at);
