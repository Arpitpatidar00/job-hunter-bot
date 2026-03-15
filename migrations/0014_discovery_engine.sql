-- Migration 0014: Discovery engine enhancements
-- Adds tracking columns for the new multi-vector discovery system:
--   - ATS enumeration tracking
--   - VC portfolio discovery tracking
--   - Source cap increase support (expanded from 500 to 2000)
--   - New source types: smartrecruiters, teamtailor, recruitee

-- Track discovery origin more granularly for analytics
-- ALTER TABLE source_registry ADD COLUMN discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Index for exploration slot queries (recently discovered sources)
CREATE INDEX IF NOT EXISTS idx_source_registry_discovered_at
    ON source_registry(discovered_at DESC)
    WHERE enabled = 1;

-- Index for source cap eviction queries
CREATE INDEX IF NOT EXISTS idx_source_registry_eviction
    ON source_registry(enabled, priority_score ASC, last_fetched_at ASC);

-- Discovery run log — tracks each discovery vector's performance per cycle
CREATE TABLE IF NOT EXISTS discovery_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date TEXT NOT NULL DEFAULT (date('now')),
    vector TEXT NOT NULL,  -- 'search', 'ats_enum', 'vc_portfolio', 'career_probe', 'redirect_mining'
    attempted INTEGER DEFAULT 0,
    discovered INTEGER DEFAULT 0,
    domains_queued INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_discovery_runs_date ON discovery_runs(run_date, vector);
