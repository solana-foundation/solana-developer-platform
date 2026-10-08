-- One record per keyed request (HOO-1918), shared by every route that takes an
-- Idempotency-Key through `middleware/idempotency.ts`.
--
-- A key is unique within one organization, one project and one operation (the
-- HTTP method plus the Hono route pattern). `project_id` is null only for a
-- route that runs without project context; NULLS NOT DISTINCT keeps those keys
-- unique too.
--
-- `in_progress` is claimed before the handler runs and carries a lease
-- (`locked_until`) plus the claim token of the request that holds it, so a
-- request that outlived its lease can never overwrite the request that took
-- over. A crashed or failed (5xx) request leaves the row `in_progress` with an
-- expired lease: the next request with the same key and fingerprint takes it
-- over, and a different fingerprint is refused. `completed` holds the response
-- that every later request with the key replays.
--
-- Rows are kept for 24 hours (`expires_at`) and pruned by the idempotency-key
-- sweep. Money-moving resources keep the key on their own row behind a unique
-- index as well, so a retry after the 24 hours still cannot move money twice.
--
-- The lease and expiry are TIMESTAMPTZ rather than the usual ISO text because
-- every read compares them with now().

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
    -- SHA-256 hex of the canonical operation, path parameters and body.
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
    claim_token TEXT,
    locked_until TIMESTAMPTZ,
    response_status INTEGER,
    response_headers JSONB,
    response_body TEXT,
    created_at TEXT NOT NULL DEFAULT (sdp_iso_now()),
    updated_at TEXT NOT NULL DEFAULT (sdp_iso_now()),
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (
      (status = 'in_progress' AND response_status IS NULL AND claim_token IS NOT NULL)
      OR (status = 'completed' AND response_status IS NOT NULL AND claim_token IS NULL
          AND locked_until IS NULL)
    ),
    CONSTRAINT idempotency_keys_scope_key
      UNIQUE NULLS NOT DISTINCT (organization_id, project_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx
    ON idempotency_keys(expires_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON idempotency_keys;
CREATE POLICY sdp_tenant_isolation ON idempotency_keys
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
