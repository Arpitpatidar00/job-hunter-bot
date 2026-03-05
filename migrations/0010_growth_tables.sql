-- Job Hunter Bot — Migration 0010
-- Creates trend_clusters and company_momentum tables for the Growth Engine (Layer 5).
-- Populated by src/intelligence/growthEngine.js during analysis cycles.

-- ── Skill trend clusters ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trend_clusters (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    skill       TEXT    NOT NULL,       -- Skill name (e.g. 'TypeScript')
    week_start  TEXT    NOT NULL,       -- ISO date of week start (Sunday)
    job_count   INTEGER DEFAULT 0,      -- Total jobs mentioning this skill this week
    growth_pct  REAL    DEFAULT 0,      -- Week-over-week growth percentage
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(skill, week_start)           -- One row per skill per week
);

CREATE INDEX IF NOT EXISTS idx_trend_clusters_week   ON trend_clusters(week_start);
CREATE INDEX IF NOT EXISTS idx_trend_clusters_skill  ON trend_clusters(skill);
CREATE INDEX IF NOT EXISTS idx_trend_clusters_growth ON trend_clusters(growth_pct DESC);

-- ── Company momentum (hiring surge tracking) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS company_momentum (
    company        TEXT    PRIMARY KEY,   -- Normalized company name
    posting_count  INTEGER DEFAULT 0,     -- Jobs posted in last 7 days
    last_post_at   DATETIME,              -- Timestamp of most recent job post
    momentum_score REAL    DEFAULT 0,     -- 0–100 composite momentum score
    is_surging     INTEGER DEFAULT 0,     -- 1 = currently in Expansion Mode
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_company_momentum_score   ON company_momentum(momentum_score DESC);
CREATE INDEX IF NOT EXISTS idx_company_momentum_surging ON company_momentum(is_surging, updated_at);
