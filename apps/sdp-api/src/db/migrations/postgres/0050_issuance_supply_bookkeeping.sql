-- Make post-settlement burn supply bookkeeping safe to retry. The marker and
-- cached-supply delta are committed in one transaction by TokenService.
ALTER TABLE issuance_transactions
  ADD COLUMN IF NOT EXISTS supply_bookkeeping_applied_at TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_bookkeeping_applied_at TEXT,
  ADD COLUMN IF NOT EXISTS authority_bookkeeping_applied_at TEXT;

-- Confirmed burn/force-burn rows predate the retry marker and already applied
-- their cached-supply delta in the old handler order. Mark them applied before
-- replay recovery can call the new exactly-once bookkeeping path.
UPDATE issuance_transactions
SET supply_bookkeeping_applied_at = updated_at
WHERE type IN ('burn', 'force_burn')
  AND status = 'confirmed'
  AND supply_bookkeeping_applied_at IS NULL;

-- Confirmed pause/unpause rows predate the retry marker and already completed
-- their mirror write in the old handler order. Mark them applied so replaying a
-- historical pause cannot overwrite a newer unpause (or vice versa).
UPDATE issuance_transactions
SET lifecycle_bookkeeping_applied_at = updated_at
WHERE type IN ('pause', 'unpause')
  AND status = 'confirmed'
  AND lifecycle_bookkeeping_applied_at IS NULL;

-- Historical authority changes already ran their mirror write in the old
-- handler order. Mark them applied so they are never replayed over newer
-- on-chain authority changes after this migration.
UPDATE issuance_transactions
SET authority_bookkeeping_applied_at = updated_at
WHERE type = 'update_authority'
  AND status = 'confirmed'
  AND authority_bookkeeping_applied_at IS NULL;
