-- Each sponsorship reservation keeps an upper bound on the last valid block
-- height of the transaction it sponsors (HOO-2232).
--
-- Reconciliation releases a reservation whose transaction never landed. It can
-- prove that only once the finalized block height is past the transaction's
-- last valid block height, and a compiled message carries only the blockhash,
-- so the height is stored on the reservation when admission prices it.
--
-- Every new reservation writes the column. It stays nullable while the
-- previous revision, which does not write it, still serves traffic. Once this
-- code is in production, a later breaking migration deletes the NULL rows and
-- sets NOT NULL.

ALTER TABLE sponsorship_budget_reservations
    ADD COLUMN IF NOT EXISTS last_valid_block_height sdp_u64;
