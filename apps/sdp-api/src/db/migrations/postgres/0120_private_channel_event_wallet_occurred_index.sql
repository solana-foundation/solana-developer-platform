-- sdp:migration-mode: non-transactional
-- Wallet-scoped project feed: the same (occurred_at, id) DESC cursor as
-- idx_private_channel_events_project_occurred, with wallet_id after the project
-- test so a wallet-scoped key reads only its wallets' rows in index order
-- instead of scanning past every other wallet's events to fill a page.
-- Built concurrently (column added in 0119) so the busy event table stays
-- readable and writable while the index builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_private_channel_events_project_wallet_occurred
    ON private_channel_events (project_id, wallet_id, occurred_at DESC, id DESC);
