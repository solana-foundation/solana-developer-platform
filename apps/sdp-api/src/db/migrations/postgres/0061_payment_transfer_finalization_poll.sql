-- Finalization-poll bookkeeping for confirmed payment transfers.
--
-- finalization_last_polled_at orders the confirmed poll queue
-- (least-recently-polled first; NULL = never polled, served first) so the
-- reconciler can rotate fairly without repurposing updated_at, which is a
-- public API field ("Last update timestamp", a sort option, and a dashboard
-- column). confirmed_at anchors the finalization-eligibility window on when
-- the transfer actually reached confirmed, so an outage longer than the
-- window can no longer strand rows that confirmed late.

ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS finalization_last_polled_at TEXT;
ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS confirmed_at TEXT;

UPDATE payment_transfers
   SET confirmed_at = updated_at
 WHERE confirmed_at IS NULL
   AND status IN ('confirmed', 'finalized');

CREATE INDEX IF NOT EXISTS idx_payment_transfers_finalization_poll
    ON payment_transfers (finalization_last_polled_at ASC NULLS FIRST, id ASC)
 WHERE status = 'confirmed';
