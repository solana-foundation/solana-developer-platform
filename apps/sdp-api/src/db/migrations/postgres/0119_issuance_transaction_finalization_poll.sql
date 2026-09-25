-- Finality-poll bookkeeping for confirmed issuance transactions.
--
-- The unified ledger reports Solana `confirmed` issuance rows as provisional
-- (never terminal), so a finality-aware reconciler must be able to advance
-- them to `finalized` once the cluster reports finality.
-- finalization_last_polled_at orders the confirmed poll queue
-- (least-recently-polled first; NULL = never polled, served first) so the
-- reconciler can rotate fairly without repurposing updated_at, which is a
-- public API field. Its partial index is built concurrently by migration
-- 0120 so a sizeable live issuance table is never write-locked for the
-- build.

ALTER TABLE issuance_transactions ADD COLUMN IF NOT EXISTS finalization_last_polled_at TEXT;
