ALTER TABLE wallet_operations
    ADD COLUMN IF NOT EXISTS execution_started_at TEXT,
    ADD COLUMN IF NOT EXISTS execution_completed_at TEXT,
    ADD COLUMN IF NOT EXISTS execution_error TEXT,
    ADD COLUMN IF NOT EXISTS execution_result JSONB,
    ADD COLUMN IF NOT EXISTS execution_attempt_id TEXT,
    ADD COLUMN IF NOT EXISTS execution_lease_expires_at TEXT,
    ADD COLUMN IF NOT EXISTS execution_effect_started_at TEXT,
    ADD COLUMN IF NOT EXISTS execution_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_wallet_operations_approved_execution
    ON wallet_operations(status, execution_lease_expires_at)
    WHERE status IN ('executing', 'failed');
