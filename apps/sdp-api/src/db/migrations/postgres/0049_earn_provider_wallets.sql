-- Solana Earn: shared provider-side portfolio wallets.
--
-- One row links an organization to the single provider-managed wallet it
-- shares per environment (e.g. the org's Ground portfolio wallet). The
-- UNIQUE (organization_id, environment, provider) constraint enforces the
-- product model: choosing a curator re-weights the shared wallet's strategy,
-- it never provisions a second wallet.
--
-- provider is open TEXT (no CHECK) per the ADR 0001/0002 pattern mirrored in
-- 0048_earn.sql: allowed values live in code registries in @sdp/types and a
-- row can outlive its provider's registry entry.
--
-- project_id records which project provisioned the wallet (audit/context);
-- the wallet itself is org+environment scoped, so project_id is deliberately
-- absent from the unique key.

CREATE TABLE IF NOT EXISTS earn_provider_wallets (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,

    provider TEXT NOT NULL,
    -- Provider-side wallet identifier (e.g. Ground wallet UUID).
    provider_wallet_ref TEXT NOT NULL,
    label TEXT,

    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id),

    CONSTRAINT earn_provider_wallets_environment_check CHECK (environment IN ('sandbox', 'production')),
    -- ONE shared wallet per org+environment+provider; also serves the
    -- getProviderWallet(org, environment, provider) lookup path.
    CONSTRAINT earn_provider_wallets_org_environment_provider_key
        UNIQUE (organization_id, environment, provider)
);
