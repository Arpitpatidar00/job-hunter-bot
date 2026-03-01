-- Job Hunter Bot v5 D1 Schema (Phase 2 - Intelligence)

-- Global IDF tracking table for Task 6
-- 'term' is the lowercase skill or keyword (e.g. 'react', 'senior')
-- 'document_count' is how many unique jobs have contained this term
CREATE TABLE IF NOT EXISTS term_frequency (
    term TEXT PRIMARY KEY,
    document_count INTEGER DEFAULT 1,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Meta table to track total processed documents (to compute IDF denominator)
CREATE TABLE IF NOT EXISTS scoring_meta (
    key TEXT PRIMARY KEY,
    value INTEGER DEFAULT 0
);

INSERT OR IGNORE INTO scoring_meta (key, value) VALUES ('total_documents', 0);
