-- The durable recovery record for a funding that crossed the broadcast
-- boundary (APE-770, SOLA9-484).
--
-- `funding_tx` is written straight AFTER the broadcast, so a claim sits with
-- `funding_tx IS NULL` for the whole window in which its signed transaction may
-- already be on the wire — and that null is ambiguous: it means both "never
-- broadcast" (safe to sweep past the last valid height) and "broadcast, receipt
-- write still owed" (never safe to sweep, because the transfer may land and the
-- row is the only durable record of who funded the leg). `releaseExpired` could
-- not tell the two apart, so a persistence failure or a sweep racing the
-- post-broadcast `recordFundingTx` deleted the row and lost the receipt: the
-- chain movement stayed valid, the `unified_transactions` projection row
-- vanished, and the late UPDATE matched nothing.
--
-- `broadcast_signature` removes the ambiguity. It is written in the SAME
-- statement that attaches the sponsored signature, BEFORE the broadcast (the
-- sponsorship lifecycle persists the signed transaction first), so from that
-- moment the row says: this signed transaction was handed to the broadcaster.
-- The expiry sweep must then leave the row alone — resolving it is the
-- reconciler's chain lookup, which restores the receipt when the transfer
-- landed and releases the row only when the chain says it moved nothing.
--
-- Nullable, no backfill: every pre-existing row predates the marker and keeps
-- its old meaning. Old rows with `funding_tx` set are receipts either way, and
-- old null-receipt rows sweep exactly as before until new code rebinds them.

ALTER TABLE dvp_leg_funding_claims
    ADD COLUMN IF NOT EXISTS broadcast_signature TEXT;
