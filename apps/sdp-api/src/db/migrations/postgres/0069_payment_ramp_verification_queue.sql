-- Work queue for the ramp settlement verifier (#559).
--
-- Deliberately separate from the wallet finalization queue in 0061. That queue is
-- bound to status = 'confirmed', type IN (wallet types) and signature IS NOT NULL,
-- and advanceConfirmedTransfers writes status = 'finalized'. Ramps reach 'completed'
-- and never enter the wallet lifecycle, so widening that query would mean writing
-- wallet statuses onto ramp rows and merging two lifecycles the type union keeps
-- deliberately apart.

-- Ordering cursor, mirroring finalization_last_polled_at: least-recently-polled
-- first, never-polled first of all. Kept off updated_at, which is a public API
-- field and a sort option, so polling must not disturb it.
ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS verification_last_polled_at TEXT;

-- Attempt cap. A signature that never resolves (a provider reporting a hash that
-- does not exist, or an RPC that keeps failing for one row) would otherwise be
-- polled forever at a cost per attempt. After the cap the row stops being served
-- and stays reportable as unverified, which is the honest outcome.
ALTER TABLE payment_transfers
  ADD COLUMN IF NOT EXISTS verification_attempts INTEGER NOT NULL DEFAULT 0;

-- The queue: ramp rows carrying a provider-reported signature that has not yet been
-- proven. A row leaves the index the moment settlement_verified_at is written, so
-- the index stays proportional to outstanding work rather than to table size.
CREATE INDEX IF NOT EXISTS idx_payment_transfers_verification_queue
    ON payment_transfers (verification_last_polled_at ASC NULLS FIRST, id ASC)
 WHERE type IN ('onramp', 'offramp')
   AND settlement_signature IS NOT NULL
   AND settlement_verified_at IS NULL;
