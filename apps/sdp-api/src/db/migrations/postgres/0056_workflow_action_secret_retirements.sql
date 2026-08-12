-- Secret versions that must be destroyed in the backend but whose destroy call failed.
--
-- Retiring a workflow action's signing secret is best effort at request time: it follows
-- a rotation or delete that has ALREADY committed, so a backend failure must not fail the
-- request. Until now that failure was only logged, which left the superseded credential
-- readable in Secret Manager with nothing pointing at it and nothing that would ever try
-- again. A row here is that retry, and it is the only durable record that the credential
-- is still alive.
--
-- Deliberately no foreign keys. The work must outlive the rule, the project and the
-- organization it came from — the point of a retirement is that nothing references the
-- credential any more, so a cascade would delete exactly the records that still matter.

CREATE TABLE IF NOT EXISTS workflow_action_secret_retirements (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    workflow_id TEXT,
    storage_backend TEXT NOT NULL,
    secret_ref TEXT,
    -- The version to destroy, and the natural key: re-recording the same failed
    -- retirement must not queue it twice.
    secret_version_ref TEXT NOT NULL UNIQUE,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now()
);

-- The sweeper's only query: due rows, oldest first.
CREATE INDEX IF NOT EXISTS idx_workflow_action_secret_retirements_due
    ON workflow_action_secret_retirements (next_attempt_at);
