-- Job Hunter Bot v5 D1 Schema

-- 1. Users Table (for Multi-tenant)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    plan TEXT DEFAULT 'free',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Profiles Table (Global config -> Per Profile config)
CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    notification_threshold INTEGER DEFAULT 50,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 3. Strictly Consistent Jobs Table (Replaces KV Deduplication)
-- UNIQUE(url) handles aggregators publishing exact same link twice
-- UNIQUE(content_hash) handles cross-aggregator identical jobs
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    url TEXT UNIQUE NOT NULL,
    content_hash TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    company TEXT,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. Feed Health Table (Replaces KV circuit breaker)
CREATE TABLE IF NOT EXISTS feed_health (
    url TEXT PRIMARY KEY,
    failure_count INTEGER DEFAULT 0,
    last_success_at DATETIME,
    disabled_until DATETIME
);

-- 5. Sent Alerts Table (Prevents duplicate sends if queue retries after successful send)
CREATE TABLE IF NOT EXISTS sent_alerts (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (job_id, profile_id)
);
