-- Idempotency for acting on one DvP leg: funding it or reclaiming it.
--
-- Both move tokens with a transaction the API broadcasts, and a client that
-- retries after an ambiguous failure (a 5xx, a timeout) would otherwise send the
-- action again. The leg lock (`dvp_leg_funding_claims`) stops two sends
-- overlapping; it cannot tell a retry from a genuinely new request made later,
-- after a reclaim confirmed and somebody deposited again. A key can.
--
-- One row per (project, key). `pending` is taken before anything is signed;
-- `sent` records what the first request returned, and a retry with the same key
-- and the same request is answered from it without touching the chain.

CREATE TABLE IF NOT EXISTS dvp_leg_action_requests (
    id TEXT PRIMARY KEY,
    -- The caller's tenant, not the trade author's: a party funding another
    -- organization's trade keeps its key on a row of its own.
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    -- Hash of the action, trade, side and resolved custody wallet. A key reused
    -- for a different request is refused, never replayed.
    fingerprint TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('fund', 'reclaim')),
    trade_id TEXT NOT NULL REFERENCES dvp_trades(id) ON DELETE CASCADE,
    side TEXT NOT NULL CHECK (side IN ('a', 'b')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent')),
    -- Set together when the action is on the wire; the response a replay returns.
    signature TEXT,
    amount TEXT,
    created_at TEXT NOT NULL DEFAULT (sdp_iso_now()),
    updated_at TEXT NOT NULL DEFAULT (sdp_iso_now()),
    CHECK ((status = 'sent') = (signature IS NOT NULL AND amount IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS dvp_leg_action_requests_key_idx
    ON dvp_leg_action_requests(project_id, idempotency_key);

ALTER TABLE dvp_leg_action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dvp_leg_action_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON dvp_leg_action_requests;
CREATE POLICY sdp_tenant_isolation ON dvp_leg_action_requests
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
