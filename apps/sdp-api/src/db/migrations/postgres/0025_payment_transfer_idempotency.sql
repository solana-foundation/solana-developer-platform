ALTER TABLE payment_transfers
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN idempotency_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_transfers_org_project_idempotency_key
  ON payment_transfers(organization_id, COALESCE(project_id, ''), idempotency_key)
  WHERE idempotency_key IS NOT NULL;
