-- Job Hunter Bot — Migration 0009
-- Adds structured enrichment columns to the jobs table.
-- These are populated by src/intelligence/enrichment.js during job-queue processing.

ALTER TABLE jobs ADD COLUMN tech_stack       TEXT    DEFAULT '[]';    -- JSON array of detected tech names
ALTER TABLE jobs ADD COLUMN seniority        TEXT;                    -- 'junior' | 'mid' | 'senior' | 'lead' | 'unknown'
ALTER TABLE jobs ADD COLUMN remote_type      TEXT    DEFAULT 'unknown'; -- 'remote' | 'hybrid' | 'onsite' | 'unknown'
ALTER TABLE jobs ADD COLUMN visa_sponsorship INTEGER DEFAULT 0;       -- 1 = offers sponsorship
ALTER TABLE jobs ADD COLUMN industry_cluster TEXT;                    -- 'fintech' | 'ai_ml' | 'saas' | etc.
ALTER TABLE jobs ADD COLUMN hiring_urgency   REAL    DEFAULT 0;       -- 0–100 urgency score
ALTER TABLE jobs ADD COLUMN similarity_hash  TEXT;                    -- Loose company+title hash for cross-source dedup
