-- Migration for Job Hunter Bot v4: Hybrid RAG Pipeline

-- 1. Table for storing RAG text chunks and their embeddings
CREATE TABLE IF NOT EXISTS job_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_hash TEXT NOT NULL,
    chunk_text TEXT NOT NULL,
    vec_json TEXT NOT NULL, -- Stored as a JSON array of floats `[0.1, -0.2, ...]`
    remote_type TEXT DEFAULT 'unknown',
    location TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_job_chunks_hash ON job_chunks(job_hash);
CREATE INDEX IF NOT EXISTS idx_job_chunks_remote ON job_chunks(remote_type);

-- 2. Table for storing user feedback (thumbs up/down) to calibrate the 16-layer scoring engine
CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_hash TEXT NOT NULL,
    score_given REAL NOT NULL,
    thumbs INTEGER NOT NULL, -- 1 for up, -1 for down
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feedback_hash ON feedback(job_hash);
