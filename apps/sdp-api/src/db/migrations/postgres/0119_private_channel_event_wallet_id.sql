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

-- The supporting index for wallet-scoped project feeds is built separately in
-- 0120 with CREATE INDEX CONCURRENTLY: a plain build here would hold locks on
-- this busy event table (and, in the same transaction, the column change)
-- while it runs, blocking live event reads and writes.
