-- Freeze/unfreeze rows confirmed before lifecycle replay protection already
-- completed their database mirror write in the old handler order. Mark them
-- applied so a historical idempotent replay cannot overwrite newer chain state.
UPDATE issuance_transactions
SET lifecycle_bookkeeping_applied_at = updated_at
WHERE type IN ('freeze', 'unfreeze')
  AND status = 'confirmed'
  AND lifecycle_bookkeeping_applied_at IS NULL;
