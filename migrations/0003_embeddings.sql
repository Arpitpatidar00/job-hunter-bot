-- Job Hunter Bot v5 D1 Schema (Phase 2 - Embeddings)

-- Store embeddings for fast cosine similarity instead of re-generating on each cron
CREATE TABLE IF NOT EXISTS job_embeddings (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS profile_embeddings (
    profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
