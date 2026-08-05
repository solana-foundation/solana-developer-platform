-- Make post-settlement burn supply bookkeeping safe to retry. The marker and
-- cached-supply delta are committed in one transaction by TokenService.
ALTER TABLE issuance_transactions
  ADD COLUMN IF NOT EXISTS supply_bookkeeping_applied_at TEXT;
