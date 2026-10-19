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
  settlement JSONB
);
