-- Migration 0017: Performance indexes for optimization fixes
-- Fix 3 prerequisite: B-tree index on jobs.fetched_at enables O(log N) range scans
-- instead of O(N) full table scans for daily report ground-truth queries.

-- Fix 3: Index on jobs.fetched_at for ISO range queries (replaces date() full scans)
CREATE INDEX IF NOT EXISTS idx_jobs_fetched_at ON jobs(fetched_at);

-- Fix 3: Partial index on company for distinct-company queries (smaller index, same benefit)
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company) WHERE company != '';

-- Solution 30: Discovery indexes for source selection and hiring surge detection
CREATE INDEX IF NOT EXISTS idx_source_registry_tier ON source_registry(enabled, crawl_tier, next_crawl_at);
CREATE INDEX IF NOT EXISTS idx_source_registry_discovered ON source_registry(enabled, discovered_at);
