-- MoonPay updatedAt orders observations only within one transaction id.
ALTER TABLE payment_transfers
  ADD COLUMN IF NOT EXISTS provider_observed_at TEXT;

-- A failed attempt releases the transfer for checkout retry. Retain its id so
-- a late webhook cannot claim the transfer again after that release.
CREATE TABLE IF NOT EXISTS moonpay_failed_transactions (
  transaction_id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL,
  provider_observed_at TEXT NOT NULL,
  failure_reason TEXT,
  settlement JSONB,
  -- Archived records still block this transaction id from claiming again.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
);

-- Webhook retry bookkeeping is read and written in system scope. Keep
-- tenant requests from seeing another customer's retired transaction ids.
ALTER TABLE moonpay_failed_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE moonpay_failed_transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_moonpay_failed_transactions_system ON moonpay_failed_transactions;
CREATE POLICY sdp_moonpay_failed_transactions_system ON moonpay_failed_transactions
  USING (sdp_tenant_isolation_is_privileged())
  WITH CHECK (sdp_tenant_isolation_is_privileged());
