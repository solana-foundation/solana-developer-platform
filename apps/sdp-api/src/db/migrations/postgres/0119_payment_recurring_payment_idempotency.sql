ALTER TABLE payment_recurring_payments
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN idempotency_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_recurring_payments_org_project_idempotency_key
  ON payment_recurring_payments(organization_id, project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
