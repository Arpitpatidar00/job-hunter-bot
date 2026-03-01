-- Job Hunter Bot v5 D1 Schema (Phase 4 - Operational Safety)

-- Config Versioning & Audit Log (Task 12)
-- Feedback weights and threshold overrides can permanently corrupt an account's scoring
-- if not versioned. This table enforces immutability.

CREATE TABLE IF NOT EXISTS profile_config_history (
    id TEXT PRIMARY KEY, -- ULID or UUID for this specific config revision
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    
    -- The actual config snapshot (weights, thresholds, search strings)
    config_json TEXT NOT NULL,
    
    -- Audit metadata
    changed_by_user_id TEXT,
    change_reason TEXT,
    is_active INTEGER DEFAULT 0, -- Only one revision per profile should be 1
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Ensure only one active config per profile
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_profile_config 
ON profile_config_history(profile_id) 
WHERE is_active = 1;
