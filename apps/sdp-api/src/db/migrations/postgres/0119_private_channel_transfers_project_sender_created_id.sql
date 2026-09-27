-- sdp:migration-mode: non-transactional
--
-- Selected-scope API keys read transfer history with a sender_wallet_id
-- filter on top of the project scope (SOLA9-518). The existing
-- project-created index is sender-agnostic, so a wallet with few transfers
-- in a large project forces a scan of the project's history to fill a
-- limited page. Keep the project-and-sender access path explicit, matching
-- the payment_transfers wallet index (0029).
--
-- CONCURRENTLY avoids blocking transfers while Postgres builds the index
-- over the live table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_private_channel_transfers_project_sender_created_id
    ON private_channel_transfers(project_id, sender_wallet_id, created_at DESC, id DESC);
