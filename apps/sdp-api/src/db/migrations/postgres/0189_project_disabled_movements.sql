-- HOO-2334: operator-controlled per-project start-movement stop. Existing
-- revisions ignore these columns while the new admission read rolls out.
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS disabled_movements TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS movement_control_version INTEGER NOT NULL DEFAULT 0;
