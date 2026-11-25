-- Record pickup once per accepted attempt, across retries and worker replicas.
-- Previous revisions ignore this additive telemetry-only column.
ALTER TABLE operation_attempts ADD COLUMN first_execution_claimed_at TEXT;
