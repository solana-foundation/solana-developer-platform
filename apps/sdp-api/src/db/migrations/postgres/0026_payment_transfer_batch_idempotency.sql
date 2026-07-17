ALTER TABLE payment_transfer_batches
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN idempotency_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_transfer_batches_org_project_idempotency_key
  ON payment_transfer_batches(organization_id, project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
