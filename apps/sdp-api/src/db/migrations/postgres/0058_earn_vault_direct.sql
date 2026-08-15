-- Solana Earn: non-custodial ("vault_direct") positions and the movements SDP
-- initiates into them — the execution era arriving for the second provider
-- shape (PRO-1634, ADR 0002).
--
-- ── Why this is not earn_provider_wallets ──────────────────────────────────
-- That table models a CUSTODIAL program: SDP asks a provider to provision an
-- omnibus wallet, the customer funds its address, and one provider wallet is
-- claimable by exactly one org platform-wide (0056's global unique on
-- (provider, provider_wallet_ref)).
--
-- A K-Vault is the opposite. It is a public, permissionless on-chain vault: it
-- has no address SDP can hand out (stablecoins sent to the vault's program
-- account are DESTROYED), SDP custodies nothing, and money moves only when a
-- wallet SDP can sign for submits an instruction. Crucially, MANY orgs and many
-- wallets legitimately hold the same vault at the same time — so reusing 0056's
-- global unique would lock a public vault to whichever org deposited first.
-- That single constraint difference is why these are separate tables rather
-- than a nullable column on the existing one.
--
-- Conventions inherited from 0055 (earn_program_withdrawals):
-- * provider is open TEXT (ADR 0001/0002 drift rule) — a row can outlive its
--   provider's registry entry; allowed values live in code registries.
-- * Money is decimal strings. No numeric columns anywhere.
-- * project_id / created_by / initiated_by_key_id are forensic attribution on a
--   money table even where no wire surface reads them.
-- * created_at/updated_at are TEXT ISO via sdp_iso_now().

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The claim set: which custody wallet holds which vault.
--
-- NOT a balance. Balances and share counts are read LIVE from chain on every
-- request (ADR 0002: positions are provider truth, and for a non-custodial
-- vault the chain IS the provider). This table only records that an org opened
-- a position, so the reads know which (wallet, vault) pairs to hydrate and the
-- dashboard can list them without scanning every vault on the shelf.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS earn_vault_positions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,

    provider TEXT NOT NULL,
    -- The vault's own on-chain address (the catalogue's provider_reference).
    provider_reference TEXT NOT NULL,
    -- The SDP custody wallet that signs for this position and holds the shares.
    custody_wallet_id TEXT NOT NULL,

    -- Denormalised from the vault at open time so a position still renders when
    -- the catalogue row is delisted. Never used to build an instruction — the
    -- builder always re-reads vault state from chain.
    share_mint TEXT,
    token_mint TEXT,
    label TEXT,

    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    -- Set when the position is fully exited. Kept rather than deleted: the
    -- movement history below references it, and a re-entry reuses the row.
    closed_at TEXT,

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    -- Deliberately NO cascade: a wallet holding vault shares must not be
    -- deletable out from under them (same fail-loud rule as 0055's wallet FK).
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id),
    FOREIGN KEY (created_by) REFERENCES users(id),

    CONSTRAINT earn_vault_positions_environment_check
        CHECK (environment IN ('sandbox', 'production'))
);

-- One row per (org, environment, provider, vault, wallet).
--
-- Scoped to the ORG and the WALLET — emphatically NOT global on
-- (provider, provider_reference) the way 0056 scopes a custodial wallet. The
-- registry is permissionless and public: two orgs holding "Steakhouse USDC" is
-- normal, and so is one org holding it from two different wallets. A global
-- unique here would refuse the second org's deposit outright.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_vault_positions_claim
    ON earn_vault_positions(organization_id, environment, provider, provider_reference, custody_wallet_id);

-- List path: id joins created_at as the deterministic pagination tiebreaker
-- (same lesson as 0055 and the payment_transfers migrations).
CREATE INDEX IF NOT EXISTS idx_earn_vault_positions_org_created
    ON earn_vault_positions(organization_id, environment, created_at DESC, id DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The movement ledger: money SDP itself moved.
--
-- ADR 0002's rule is "SDP ledgers what SDP INITIATES; SDP reads live what the
-- provider observes". Ground deposits are unledgered because the customer sends
-- funds and SDP has no intent moment. Here SDP builds, signs and submits BOTH
-- directions — so both get a row, written at intent and advanced by guarded CAS
-- on every observation. Without it, a crash between signing and confirmation is
-- unrecoverable: the transaction is on chain and SDP has no record it exists.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS earn_vault_movements (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    position_id TEXT NOT NULL,

    provider TEXT NOT NULL,
    provider_reference TEXT NOT NULL,
    custody_wallet_id TEXT NOT NULL,

    direction TEXT NOT NULL,
    -- 'pending' is SDP-only intent (row exists, nothing signed yet); 'submitted'
    -- means a signature exists and the transaction is on the wire. Both terminal
    -- states are chain-observed.
    status TEXT NOT NULL DEFAULT 'pending',

    -- Decimal strings in the vault token's own units. amount is what was asked
    -- for; shares is what the chain actually minted or burned, so the two are
    -- deliberately separate and shares stays NULL until confirmation.
    amount TEXT,
    shares TEXT,

    -- Base58 transaction signature, set at submit. A row without one never
    -- reached the chain and is a terminal failure — no funds moved.
    signature TEXT,
    failure_reason TEXT,

    -- Caller idempotency key, REQUIRED. A retried deposit without a stable key
    -- double-spends, and unlike the custodial create there is no provider-side
    -- dedupe to fall back on: the chain will happily accept the same transfer
    -- twice.
    request_id TEXT NOT NULL,

    created_by TEXT,
    initiated_by_key_id TEXT,

    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    confirmed_at TEXT,

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    -- No cascade: money history outlives the position row.
    FOREIGN KEY (position_id) REFERENCES earn_vault_positions(id),
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id),
    FOREIGN KEY (created_by) REFERENCES users(id),

    CONSTRAINT earn_vault_movements_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT earn_vault_movements_direction_check
        CHECK (direction IN ('deposit', 'withdraw')),
    CONSTRAINT earn_vault_movements_status_check
        CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed'))
);

-- SDP-side idempotency lock: one movement per caller key per organization.
-- Org-scoped rather than position-scoped on purpose — a retry that resolves to
-- a DIFFERENT position (e.g. the caller corrected the vault) is a different
-- request and must not silently reuse the key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_vault_movements_request
    ON earn_vault_movements(organization_id, request_id);

-- Chain correlation for the confirmation sweep. Partial, because a pending row
-- legitimately has no signature yet.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_vault_movements_signature
    ON earn_vault_movements(signature)
    WHERE signature IS NOT NULL;

-- History for one position, newest first, with the id tiebreaker.
CREATE INDEX IF NOT EXISTS idx_earn_vault_movements_position_created
    ON earn_vault_movements(position_id, created_at DESC, id DESC);

-- The sweep's work queue: rows that reached the chain but have no outcome yet.
CREATE INDEX IF NOT EXISTS idx_earn_vault_movements_unsettled
    ON earn_vault_movements(status, created_at)
    WHERE status = 'submitted';
