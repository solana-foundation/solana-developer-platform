-- Private Channels: normalized event-to-wallet attribution.
--
-- Wallet-scoped API keys may read the activity feed only for the custody
-- wallets their bindings authorize. That authorization must not be inferred
-- from JSONB payload text — display fields are never an access-control source
-- — so each wallet-related event records the wallet id it belongs to at emit
-- time, copied from the authoritative movement row (transfer, deposit, or
-- withdrawal) or the verified wallet. Events without a wallet (lifecycle,
-- membership, diagnostics) and rows written before this column carry NULL and
-- stay invisible to wallet-scoped keys: deny by default. All-wallet keys,
-- dashboard sessions, and channel members keep the existing feed semantics,
-- which do not read this column.

ALTER TABLE private_channel_events
    ADD COLUMN IF NOT EXISTS wallet_id TEXT;

-- Wallet-scoped project feed: the same (occurred_at, id) DESC cursor as
-- idx_private_channel_events_project_occurred, with wallet_id after the project
-- test so a wallet-scoped key reads only its wallets' rows in index order
-- instead of scanning past every other wallet's events to fill a page.
CREATE INDEX IF NOT EXISTS idx_private_channel_events_project_wallet_occurred
    ON private_channel_events (project_id, wallet_id, occurred_at DESC, id DESC);
