-- Solana Earn (SDP Markets V1): stablecoin deposit facility.
--
-- earn_strategies is the platform-level strategy catalogue, synced from
-- vault-infra providers (Veda, Upshift, Perena, Ground). It is intentionally
-- NOT org/project scoped — the catalogue is shared across tenants, so, unlike
-- every tenant-scoped table, it carries an explicit environment column
-- (sandbox|production) instead of deriving environment from the project.
--
-- provider, source_kind, underlying_source, apy_type and liquidity_term are
-- open TEXT (no CHECK) per the ADR 0001 asset-profiles pattern: allowed values
-- live in code registries in @sdp/types (EARN_PROVIDERS,
-- EARN_STRATEGY_SOURCE_KINDS, ...) and are validated with Zod at the app
-- layer, so onboarding a new provider or RWA never needs a migration.
--
-- Amounts (share_amount, amount, cost_basis) are TEXT base-unit integers;
-- share_price/apy/tvl are TEXT decimal strings — no numeric columns for money.

CREATE TABLE IF NOT EXISTS earn_strategies (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_reference TEXT NOT NULL,
    name TEXT NOT NULL,

    -- Catalogue coordinates (validated in the application layer).
    source_kind TEXT NOT NULL,
    underlying_source TEXT,

    -- Stablecoin mints accepted for deposit (JSONB array of mint addresses).
    deposit_mints JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Mint of the yield-bearing share/receipt token, when one is issued.
    share_mint TEXT,

    apy_type TEXT NOT NULL,
    -- Latest observed APY as a decimal string (e.g. '0.062' = 6.2%).
    current_apy TEXT,

    liquidity_term TEXT NOT NULL,
    redemption_delay_days INTEGER,

    -- Curator / risk-framework metadata (open shape; well-known fields in @sdp/types).
    risk_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    status TEXT NOT NULL DEFAULT 'active',
    environment TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    CONSTRAINT earn_strategies_deposit_mints_is_array CHECK (jsonb_typeof(deposit_mints) = 'array'),
    CONSTRAINT earn_strategies_risk_metadata_is_object CHECK (jsonb_typeof(risk_metadata) = 'object'),
    CONSTRAINT earn_strategies_status_check CHECK (status IN ('active', 'paused', 'deprecated')),
    CONSTRAINT earn_strategies_environment_check CHECK (environment IN ('sandbox', 'production'))
);

-- Catalogue sync upsert key: one row per provider-side strategy per environment.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_strategies_provider_reference
    ON earn_strategies(provider, provider_reference, environment);

-- Default catalogue listing: by environment, newest first, active rows.
-- id joins created_at in every list index/ORDER BY as the deterministic
-- pagination tiebreaker (bulk-synced rows share one sdp_iso_now() value;
-- same lesson as payment_transfers migrations 0028-0031).
CREATE INDEX IF NOT EXISTS idx_earn_strategies_environment_created
    ON earn_strategies(environment, created_at DESC, id DESC)
    WHERE status = 'active';

CREATE TABLE IF NOT EXISTS earn_positions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    wallet_id TEXT NOT NULL,

    -- Share balance in base units of the share mint.
    share_amount TEXT NOT NULL DEFAULT '0',
    -- Net stablecoin deposited in base units (deposits minus withdrawals).
    cost_basis TEXT,

    status TEXT NOT NULL DEFAULT 'active',
    provider_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (strategy_id) REFERENCES earn_strategies(id),

    CONSTRAINT earn_positions_provider_data_is_object CHECK (jsonb_typeof(provider_data) = 'object'),
    CONSTRAINT earn_positions_status_check CHECK (status IN ('active', 'closed')),
    -- Lets child tables FK on (position_id, organization_id, project_id) so a
    -- movement can never point at a position in a different org/project.
    CONSTRAINT earn_positions_id_org_project_key UNIQUE (id, organization_id, project_id)
);

-- One active position per strategy+wallet within a project; a closed position
-- can coexist with a new active one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_positions_active_unique
    ON earn_positions(organization_id, project_id, strategy_id, wallet_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_earn_positions_org_project_created
    ON earn_positions(organization_id, project_id, created_at DESC, id DESC)
    WHERE status = 'active';

-- Deposits AND withdrawals live in one movements ledger, discriminated by
-- direction — mirrors how payment transfers model both legs.
CREATE TABLE IF NOT EXISTS earn_movements (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    position_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,

    direction TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    -- Stablecoin amount in base units.
    amount TEXT NOT NULL,
    -- Shares minted/burned in base units, once known.
    share_amount TEXT,

    status TEXT NOT NULL DEFAULT 'pending',
    transaction_signature TEXT,

    provider TEXT,
    provider_reference TEXT,
    provider_data JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Caller-supplied idempotency handle for the public API.
    external_id TEXT,
    -- For delayed redemptions: when funds become claimable.
    redemption_available_at TEXT,

    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (position_id, organization_id, project_id)
        REFERENCES earn_positions(id, organization_id, project_id)
        ON DELETE CASCADE,
    FOREIGN KEY (strategy_id) REFERENCES earn_strategies(id),

    CONSTRAINT earn_movements_provider_data_is_object CHECK (jsonb_typeof(provider_data) = 'object'),
    CONSTRAINT earn_movements_direction_check CHECK (direction IN ('deposit', 'withdrawal')),
    CONSTRAINT earn_movements_status_check
        CHECK (status IN ('pending', 'submitted', 'settled', 'failed', 'cancelled'))
);

-- Webhook idempotency: a provider settlement event maps to exactly one movement
-- (mirrors the 0008 ramp attributes pattern).
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_movements_provider_reference
    ON earn_movements(provider, provider_reference)
    WHERE provider IS NOT NULL AND provider_reference IS NOT NULL;

-- Public-API idempotency for caller-supplied ids.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_movements_external_id
    ON earn_movements(organization_id, project_id, external_id)
    WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_earn_movements_org_project_created
    ON earn_movements(organization_id, project_id, created_at DESC, id DESC);

-- NAV time series snapshotted by cron per strategy.
CREATE TABLE IF NOT EXISTS earn_nav_snapshots (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL,

    -- Price of one share in deposit-asset base units, as a decimal string.
    share_price TEXT NOT NULL,
    apy TEXT,
    tvl TEXT,

    as_of TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (strategy_id) REFERENCES earn_strategies(id) ON DELETE CASCADE,

    CONSTRAINT earn_nav_snapshots_strategy_as_of_key UNIQUE (strategy_id, as_of)
);

CREATE INDEX IF NOT EXISTS idx_earn_nav_snapshots_strategy_as_of
    ON earn_nav_snapshots(strategy_id, as_of DESC);
