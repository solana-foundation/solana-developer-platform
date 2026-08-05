-- Make post-settlement burn supply bookkeeping safe to retry. The marker and
-- cached-supply delta are committed in one transaction by TokenService.
ALTER TABLE issuance_transactions
  ADD COLUMN IF NOT EXISTS supply_bookkeeping_applied_at TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_bookkeeping_applied_at TEXT;

-- Confirmed pause/unpause rows predate the retry marker and already completed
-- their mirror write in the old handler order. Mark them applied so replaying a
-- historical pause cannot overwrite a newer unpause (or vice versa).
UPDATE issuance_transactions
SET lifecycle_bookkeeping_applied_at = updated_at
WHERE type IN ('pause', 'unpause')
  AND status = 'confirmed'
  AND lifecycle_bookkeeping_applied_at IS NULL;
