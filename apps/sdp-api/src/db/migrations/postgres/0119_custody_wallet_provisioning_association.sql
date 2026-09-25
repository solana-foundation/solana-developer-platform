-- Durable provenance for custody wallets provisioned for API keys.
--
-- Retry reuse previously identified candidate wallets by parsing audit-ledger
-- JSON metadata: every provisioning request scanned the organization's audit
-- ledger with unindexable metadata extractions (and one malformed metadata row
-- could abort the whole lookup). The provenance columns below turn candidate
-- selection into a single indexed lookup over `custody_wallets` and scope it
-- to the actor whose request provisioned the wallet.
--
-- Once a provisioned wallet is actually bound to an API key, its provenance is
-- cleared in the same transaction as the binding, so the wallet of a completed
-- attempt is never re-adopted later (for example after that key is deleted).
ALTER TABLE custody_wallets ADD COLUMN IF NOT EXISTS creation_reason TEXT;
ALTER TABLE custody_wallets ADD COLUMN IF NOT EXISTS provisioned_by_api_key_id TEXT;
ALTER TABLE custody_wallets ADD COLUMN IF NOT EXISTS provisioned_by_user_id TEXT;

-- Retry-candidate lookup: config + creation reason + recency, restricted to
-- rows that still carry unclaimed API-key provisioning provenance.
CREATE INDEX IF NOT EXISTS idx_custody_wallets_provisioning_reuse
    ON custody_wallets(custody_config_id, created_at)
    WHERE creation_reason = 'api_key';

-- Marks bindings created by the API-key provisioning flow. A provisioned
-- wallet is exclusive to the key it was provisioned for: the partial unique
-- index turns the concurrent-adoption race (two requests adopting the same
-- still-unbound wallet and binding it to different keys) into a clean
-- constraint violation inside the losing transaction instead of two API keys
-- silently sharing a signing wallet. Explicit, operator-driven bindings are
-- not flagged and may still share a wallet.
ALTER TABLE api_key_wallet_permissions
    ADD COLUMN IF NOT EXISTS provisioned_binding BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_key_wallet_permissions_provisioned_wallet
    ON api_key_wallet_permissions(wallet_id)
    WHERE provisioned_binding;
