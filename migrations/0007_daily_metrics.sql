-- Daily Intelligence Report Metrics
-- Tracks cumulative counters per day for the daily report.

CREATE TABLE IF NOT EXISTS daily_metrics (
    date TEXT NOT NULL DEFAULT (date('now')),
    -- Crawl performance
    sources_scanned INTEGER NOT NULL DEFAULT 0,
    crawl_successes INTEGER NOT NULL DEFAULT 0,
    crawl_failures INTEGER NOT NULL DEFAULT 0,
    raw_jobs_found INTEGER NOT NULL DEFAULT 0,
    unique_jobs_stored INTEGER NOT NULL DEFAULT 0,
    duplicates_filtered INTEGER NOT NULL DEFAULT 0,
    -- Alert quality
    alerts_sent INTEGER NOT NULL DEFAULT 0,
    alert_failures INTEGER NOT NULL DEFAULT 0,
    score_sum REAL NOT NULL DEFAULT 0,
    score_max INTEGER NOT NULL DEFAULT 0,
    -- Discovery
    new_sources_ats INTEGER NOT NULL DEFAULT 0,
    new_sources_career INTEGER NOT NULL DEFAULT 0,
    new_sources_search INTEGER NOT NULL DEFAULT 0,
    new_domains_queued INTEGER NOT NULL DEFAULT 0,
    -- Market signals
    skill_counts TEXT NOT NULL DEFAULT '{}',  -- JSON: { "react": 42, "node.js": 38 }
    remote_jobs INTEGER NOT NULL DEFAULT 0,
    hybrid_jobs INTEGER NOT NULL DEFAULT 0,
    onsite_jobs INTEGER NOT NULL DEFAULT 0,
    salary_sum REAL NOT NULL DEFAULT 0,
    salary_count INTEGER NOT NULL DEFAULT 0,
    -- Resource usage
    worker_invocations INTEGER NOT NULL DEFAULT 0,
    d1_writes INTEGER NOT NULL DEFAULT 0,
    queue_messages INTEGER NOT NULL DEFAULT 0,
    ai_calls INTEGER NOT NULL DEFAULT 0,
    -- Metadata
    cycles_completed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date)
);
