-- One record per keyed request (HOO-1918), shared by every route that takes an
-- Idempotency-Key through `middleware/idempotency.ts`.
--
-- A key is unique within one organization, one project and one operation (the
-- HTTP method plus the Hono route pattern). Every keyed route runs under
-- project context, so `project_id` is required like every project-scoped table.
--
-- `in_progress` is claimed before the handler runs and carries a lease
-- (`locked_until`), renewed while the request runs, plus the claim token of the
-- request that holds it, so a request that lost the key can never overwrite the
-- request that took over. A crashed request (or a 5xx on a route that opts to
-- re-run) leaves the row `in_progress` with an ended lease: the next request
-- with the same key and fingerprint takes it over, and a different fingerprint
-- is refused. `released` marks a lease its request ended on purpose (a re-run
-- 5xx, a refused takeover) rather than one that lapsed, so only lapsed leases
-- are alerted on when the row is pruned or replaced. `completed` holds the response every later request replays;
-- `response_body` is null for a bodyless status or a body too large to keep.
--
-- Rows are kept for 24 hours (`expires_at`) and pruned by the idempotency-key
-- sweep. Money-moving resources keep the key on their own row behind a unique
-- index as well, so a retry after the 24 hours still cannot move money twice.
--
-- The lease and expiry are TIMESTAMPTZ rather than the usual ISO text because
-- every read compares them with now().
--
-- sdp:migration-locks: blocking
-- This file creates `idempotency_keys`. IF NOT EXISTS is only there so the file
-- re-runs where an earlier name already applied it; the table is new and empty
-- when its index is built, so the build blocks no traffic.

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
    -- The credential (API key id or user id) that first used the key. Another
    -- credential reusing it is refused like a different request.
    principal TEXT NOT NULL,
    -- SHA-256 hex of the canonical operation, path parameters, query and
    -- body.
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
    claim_token TEXT,
    locked_until TIMESTAMPTZ,
    -- When the current request claimed (or took over) the key. A lapsed lease
    -- may only mean its renewals are failing, so the claim counts as live
    -- until claimed_at + the renewal cap + the lease.
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    released BOOLEAN NOT NULL DEFAULT false,
    response_status INTEGER,
    response_headers JSONB,
    response_body TEXT,
    created_at TEXT NOT NULL DEFAULT (sdp_iso_now()),
    updated_at TEXT NOT NULL DEFAULT (sdp_iso_now()),
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (
      (status = 'in_progress' AND response_status IS NULL AND claim_token IS NOT NULL)
      OR (status = 'completed' AND response_status IS NOT NULL AND response_headers IS NOT NULL
          AND claim_token IS NULL AND locked_until IS NULL)
    ),
    CONSTRAINT idempotency_keys_scope_key
      UNIQUE (organization_id, project_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx
    ON idempotency_keys(expires_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON idempotency_keys;
CREATE POLICY sdp_tenant_isolation ON idempotency_keys
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
