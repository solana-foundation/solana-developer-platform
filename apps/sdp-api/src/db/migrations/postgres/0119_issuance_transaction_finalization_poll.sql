-- Finality-poll bookkeeping for confirmed issuance transactions.
--
-- The unified ledger reports Solana `confirmed` issuance rows as provisional
-- (never terminal), so a finality-aware reconciler must be able to advance
-- them to `finalized` once the cluster reports finality.
-- finalization_last_polled_at orders the confirmed poll queue
-- (least-recently-polled first; NULL = never polled, served first) so the
-- reconciler can rotate fairly without repurposing updated_at, which is a
-- public API field. The status-history index keeps the confirmed-at lookup
-- (the finalization-eligibility window anchor) an index scan.

ALTER TABLE issuance_transactions ADD COLUMN IF NOT EXISTS finalization_last_polled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_issuance_tx_finalization_poll
    ON issuance_transactions (finalization_last_polled_at ASC NULLS FIRST, id ASC)
 WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_issuance_tx_statuses_transaction
    ON issuance_transaction_statuses (transaction_id, status);
