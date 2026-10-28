-- HOO-2343: one row per retry of a transfer batch's failed recipients, written
-- in the claim's transaction before anything is signed. It is the retry's
-- recovery point under its Idempotency-Key (ADR 0009): a rerun after a 5xx or
-- a takeover is answered from it instead of claiming again, and it records
-- which recipients each retry resent.
CREATE TABLE payment_transfer_batch_retries (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES payment_transfer_batches(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    idempotency_fingerprint TEXT NOT NULL,
    initiated_by_key_id TEXT,
    recipient_ids JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL DEFAULT sdp_iso_now()
);

CREATE UNIQUE INDEX payment_transfer_batch_retries_org_project_key
    ON payment_transfer_batch_retries (organization_id, project_id, idempotency_key);

ALTER TABLE payment_transfer_batch_retries ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transfer_batch_retries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON payment_transfer_batch_retries;
CREATE POLICY sdp_tenant_isolation ON payment_transfer_batch_retries
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
