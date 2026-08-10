-- When a KYC status change fires a workflow rule, the execution's idempotency key has to
-- identify the transition itself, so a re-delivered provider webhook is a no-op. That key
-- fell back to `updated_at` for a rejection (which has no `verified_at`), and `updated_at`
-- moves on ANY write to the row — enrolling the holder for a second asset re-upserts it,
-- for instance. A redelivery after such a write therefore minted a fresh key and enqueued
-- the same rule twice.
--
-- This column moves only when kyc_status actually changes, so it identifies the transition
-- rather than the last time anything touched the row.
ALTER TABLE kyc_wallets ADD COLUMN IF NOT EXISTS status_changed_at TEXT;

-- Existing rows: the closest available approximation of when the status last changed.
UPDATE kyc_wallets
   SET status_changed_at = COALESCE(verified_at, updated_at)
 WHERE status_changed_at IS NULL;

ALTER TABLE kyc_wallets ALTER COLUMN status_changed_at SET DEFAULT sdp_iso_now();
ALTER TABLE kyc_wallets ALTER COLUMN status_changed_at SET NOT NULL;
