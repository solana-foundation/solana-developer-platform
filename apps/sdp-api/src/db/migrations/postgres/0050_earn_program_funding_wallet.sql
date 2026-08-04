-- Solana Earn: record which SDP wallet funds the shared program.
--
-- The provider custodies the program's own wallet and issues its Solana deposit
-- address, so this column is NOT where the money lives. It records the org's own
-- custody wallet that stablecoins are sent FROM — and therefore the address a
-- withdrawal naturally returns to. Before this column the choice existed only in
-- the deposit flow's client state and was lost on reload.
--
-- NULLABLE on purpose, three ways:
--   * programs created before this migration have no recorded funding wallet;
--   * API callers may legitimately omit it (funding a provider address needs no
--     SDP wallet at all);
--   * ON DELETE SET NULL keeps a funded program intact when its funding wallet
--     is removed. Deleting a wallet must never cascade into an earn program, and
--     a program whose funding wallet vanished still holds real balances.
--
-- References custody_wallets(id) — the SDP row id, not the provider-side
-- wallet_id, which is only unique per custody config. Org ownership is NOT
-- expressible as a constraint here (custody_wallets scopes to an org through
-- custody_configs), so writes validate it in the repository.

ALTER TABLE earn_provider_wallets
    ADD COLUMN IF NOT EXISTS funding_wallet_id TEXT
        REFERENCES custody_wallets(id) ON DELETE SET NULL;

-- Supports the reverse lookup ("which programs fund from this wallet?") that
-- wallet-deletion checks and support queries need.
CREATE INDEX IF NOT EXISTS idx_earn_provider_wallets_funding_wallet
    ON earn_provider_wallets(funding_wallet_id)
    WHERE funding_wallet_id IS NOT NULL;
