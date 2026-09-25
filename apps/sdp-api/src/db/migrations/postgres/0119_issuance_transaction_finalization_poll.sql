-- Finality-poll bookkeeping for confirmed issuance transactions.
--
-- The unified ledger reports Solana `confirmed` issuance rows as provisional
-- (never terminal), so a finality-aware reconciler must be able to advance
-- them to `finalized` once the cluster reports finality.
-- finalization_last_polled_at records the last poll stamp, while
-- finalization_poll_attempts counts consecutive non-finalizing polls and
-- finalization_next_poll_at defers the next one (NULL = due now; never-polled
-- rows stay NULL and are served first). The backoff keeps a signature that
-- will never finalize — one lost to a fork — from consuming an RPC history
-- lookup every tick, while the row still returns to the queue eventually, so
-- the recovery path for rows confirmed before this reconciler deployed or
-- stranded by an outage stays intact. finalization_next_poll_at is what
-- orders the queue; its partial index is built concurrently by migration
-- 0120 so a sizeable live issuance table is never write-locked for the
-- build.

ALTER TABLE issuance_transactions ADD COLUMN IF NOT EXISTS finalization_last_polled_at TEXT;
ALTER TABLE issuance_transactions ADD COLUMN IF NOT EXISTS finalization_poll_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE issuance_transactions ADD COLUMN IF NOT EXISTS finalization_next_poll_at TEXT;
