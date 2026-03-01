-- Job Hunter Bot v5 D1 Schema (Phase 6 - Source Intelligence)
-- Adds priority scoring, adaptive crawl scheduling, and domain tracking.

ALTER TABLE source_registry ADD COLUMN priority_score REAL DEFAULT 50.0;
ALTER TABLE source_registry ADD COLUMN crawl_tier TEXT DEFAULT 'medium';
ALTER TABLE source_registry ADD COLUMN next_crawl_at DATETIME;
ALTER TABLE source_registry ADD COLUMN avg_job_count REAL DEFAULT 0;
ALTER TABLE source_registry ADD COLUMN posting_frequency REAL DEFAULT 0;
ALTER TABLE source_registry ADD COLUMN last_new_job_at DATETIME;
ALTER TABLE source_registry ADD COLUMN total_jobs_found INTEGER DEFAULT 0;
ALTER TABLE source_registry ADD COLUMN domain TEXT;

-- Domain registry for career page detection
CREATE TABLE IF NOT EXISTS domain_registry (
    domain TEXT PRIMARY KEY,
    status TEXT DEFAULT 'pending',        -- 'pending' | 'probed' | 'active' | 'dead'
    career_url TEXT,                       -- Discovered career page URL
    has_json_ld INTEGER DEFAULT 0,         -- Has JobPosting schema?
    has_job_links INTEGER DEFAULT 0,       -- Has parseable job links?
    job_count INTEGER DEFAULT 0,           -- Jobs found last probe
    last_probed_at DATETIME,
    source_job_url TEXT,                   -- The job URL that led to this domain
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_domain_status ON domain_registry(status);
CREATE INDEX IF NOT EXISTS idx_source_priority ON source_registry(crawl_tier, next_crawl_at);
