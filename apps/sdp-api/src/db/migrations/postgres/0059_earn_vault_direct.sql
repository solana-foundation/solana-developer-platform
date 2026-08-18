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
-- * Money is decimal strings. The only NUMERIC column is the unsigned protocol
--   block height, so exact fund amounts round-trip without DB coercion.
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
    -- Forensic attribution, not ownership. Organization fallback wallets may
    -- hold one claim for movements initiated by multiple projects.
    project_id TEXT,
    environment TEXT NOT NULL,

    provider TEXT NOT NULL,
    -- The vault's own on-chain address (the catalogue's provider_reference).
    provider_reference TEXT NOT NULL,
    -- The SDP custody wallet that signs for this position and holds the shares.
    custody_wallet_id TEXT NOT NULL,

    -- Denormalised from the vault at open time so a position still renders when
    -- the catalogue row is delisted. Never used to build an instruction — the
    -- builder always re-reads vault state from chain.
    share_mint TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    label TEXT NOT NULL,

    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    -- A claim is activated only in the transaction that durably records the
    -- signed transaction that can create the holding. Failed preflight and
    -- idempotency losers create no position; rolled-back claims never render.
    activated_at TEXT,
    -- Set when the position is fully exited. Kept rather than deleted: the
    -- movement history below references it, and a re-entry reuses the row.
    closed_at TEXT,

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    -- Deliberately NO cascade: a wallet holding vault shares must not be
    -- deletable out from under them (same fail-loud rule as 0055's wallet FK).
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id),
    FOREIGN KEY (created_by) REFERENCES users(id),

    CONSTRAINT earn_vault_positions_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT earn_vault_positions_movement_identity_key
        UNIQUE (
            id,
            organization_id,
            environment,
            provider,
            provider_reference,
            custody_wallet_id
        )
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

-- Project-scoped list path. Every read supplies the current project's custody
-- wallet row ids (plus organization fallbacks), pages by (created_at, id), and
-- excludes provisional claims that never reached the signed boundary.
CREATE INDEX IF NOT EXISTS idx_earn_vault_positions_wallet_created
    ON earn_vault_positions(
        organization_id,
        environment,
        custody_wallet_id,
        created_at DESC,
        id DESC
    )
    WHERE activated_at IS NOT NULL AND closed_at IS NULL;

-- Complement the narrow-wallet index above for pages spanning many custody
-- rows: ORDER BY can stream globally before applying the wallet-array filter.
CREATE INDEX IF NOT EXISTS idx_earn_vault_positions_created_wallet
    ON earn_vault_positions(
        organization_id,
        environment,
        created_at DESC,
        id DESC,
        custody_wallet_id
    )
    WHERE activated_at IS NOT NULL AND closed_at IS NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The movement ledger: money SDP itself moved.
--
-- ADR 0002's rule is "SDP ledgers what SDP INITIATES; SDP reads live what the
-- provider observes". Ground deposits are unledgered because the customer sends
-- funds and SDP has no intent moment. Here SDP builds, signs and submits BOTH
-- directions — so both get a row, written with the signed bytes before broadcast
-- and advanced by guarded CAS on every observation. Without it, a crash between
-- signing and confirmation is unrecoverable: the transaction may be on chain
-- while SDP has no record it exists.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS earn_vault_movements (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    -- Initiating project attribution; history survives project deletion.
    project_id TEXT,
    environment TEXT NOT NULL,
    position_id TEXT NOT NULL,

    provider TEXT NOT NULL,
    provider_reference TEXT NOT NULL,
    custody_wallet_id TEXT NOT NULL,

    direction TEXT NOT NULL,
    -- 'pending' means a signed transaction is durably recorded but is not yet
    -- known to be on the wire; 'submitted' means broadcast returned. Both remain
    -- nonterminal until a chain observer establishes the outcome.
    status TEXT NOT NULL DEFAULT 'pending',

    -- Decimal strings in each mint's own units. Keep the caller's text for the
    -- audit trail, but ledger `amount` / `min_shares_out` from the provider plan:
    -- those are canonical to mint precision and are what the signed instruction
    -- actually encodes.
    requested_amount TEXT NOT NULL,
    amount TEXT NOT NULL,
    requested_min_shares_out TEXT,
    min_shares_out TEXT,
    -- Shares is what the chain actually minted or burned and stays NULL until
    -- confirmation.
    shares TEXT,

    -- Signed outbox payload, recorded atomically with the movement and position
    -- activation before the bytes can reach the network. This is enough for a
    -- reconciler to query the exact signature and, while its blockhash remains
    -- valid, rebroadcast the exact same transaction without re-signing.
    signature TEXT NOT NULL,
    signed_transaction TEXT NOT NULL,
    last_valid_block_height NUMERIC NOT NULL,
    failure_reason TEXT,

    -- Caller idempotency key, REQUIRED. A retried deposit without a stable key
    -- double-spends, and unlike the custodial create there is no provider-side
    -- dedupe to fall back on: the chain will happily accept the same transfer
    -- twice.
    request_id TEXT NOT NULL,
    -- Canonical fingerprint of the request that wrote this row.
    --
    -- The key alone is not enough, and the gap is not hypothetical. Matching on
    -- `request_id` only cannot distinguish a genuine RETRY from a DIFFERENT
    -- request wearing the same key: reusing a key with another vault, wallet or
    -- amount would return 200 carrying the ORIGINAL movement's signature. And
    -- because the position is claimed as part of the same call, such a request
    -- would also open a real position row for the new vault and then answer
    -- with the old vault's transaction — a response that is not merely stale
    -- but self-contradictory.
    --
    -- Storing the fingerprint lets the replay path compare INTENT, not just the
    -- key, and answer 409 on mismatch. NOT NULL follows 0055's earn convention
    -- rather than the nullable payments one, because the caller key is required
    -- on this route: a NULL fingerprint would read as "unclaimed" to
    -- `resolveIdempotencyReplay` and turn the replay backstop into an
    -- unrecoverable unique-violation instead of a clean 409.
    -- Built by `buildEarnVaultDepositFingerprint` (src/lib/idempotency.ts).
    idempotency_fingerprint TEXT NOT NULL,

    created_by TEXT,
    initiated_by_key_id TEXT,

    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    confirmed_at TEXT,

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    -- No cascade, and the duplicated movement identity must describe the exact
    -- parent claim rather than merely point at any position id.
    FOREIGN KEY (
        position_id,
        organization_id,
        environment,
        provider,
        provider_reference,
        custody_wallet_id
    ) REFERENCES earn_vault_positions(
        id,
        organization_id,
        environment,
        provider,
        provider_reference,
        custody_wallet_id
    ),
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id),
    FOREIGN KEY (created_by) REFERENCES users(id),

    CONSTRAINT earn_vault_movements_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT earn_vault_movements_direction_check
        CHECK (direction IN ('deposit', 'withdraw')),
    CONSTRAINT earn_vault_movements_status_check
        CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed')),
    CONSTRAINT earn_vault_movements_confirmation_metadata_check
        CHECK (
            (status = 'confirmed') =
            (NULLIF(BTRIM(confirmed_at), '') IS NOT NULL)
        ),
    CONSTRAINT earn_vault_movements_failure_metadata_check
        CHECK (
            (status = 'failed') =
            (NULLIF(BTRIM(failure_reason), '') IS NOT NULL)
        ),
    CONSTRAINT earn_vault_movements_amount_format_check
        CHECK (
            LENGTH(requested_amount) BETWEEN 1 AND 128
            AND LENGTH(amount) BETWEEN 1 AND 128
            AND requested_amount ~ '^\d+(\.\d+)?$'
            AND amount ~ '^\d+(\.\d+)?$'
            AND requested_amount ~ '[1-9]'
            AND amount ~ '[1-9]'
        ),
    CONSTRAINT earn_vault_movements_shares_format_check
        CHECK (
            shares IS NULL
            OR (
                status = 'confirmed'
                AND LENGTH(shares) BETWEEN 1 AND 128
                AND shares ~ '^\d+(\.\d+)?$'
                AND shares ~ '[1-9]'
            )
        ),
    CONSTRAINT earn_vault_movements_amount_identity_check
        CHECK (
            CASE
                WHEN LENGTH(requested_amount) BETWEEN 1 AND 128
                 AND LENGTH(amount) BETWEEN 1 AND 128
                 AND requested_amount ~ '^\d+(\.\d+)?$'
                 AND amount ~ '^\d+(\.\d+)?$'
                THEN requested_amount::NUMERIC = amount::NUMERIC
                ELSE FALSE
            END
        ),
    CONSTRAINT earn_vault_movements_floor_pair_check
        CHECK ((requested_min_shares_out IS NULL) = (min_shares_out IS NULL)),
    CONSTRAINT earn_vault_movements_floor_identity_check
        CHECK (
            CASE
                WHEN requested_min_shares_out IS NULL AND min_shares_out IS NULL
                THEN TRUE
                WHEN requested_min_shares_out IS NOT NULL
                 AND min_shares_out IS NOT NULL
                 AND LENGTH(requested_min_shares_out) BETWEEN 1 AND 128
                 AND LENGTH(min_shares_out) BETWEEN 1 AND 128
                 AND requested_min_shares_out ~ '^\d+(\.\d+)?$'
                 AND min_shares_out ~ '^\d+(\.\d+)?$'
                 AND requested_min_shares_out ~ '[1-9]'
                 AND min_shares_out ~ '[1-9]'
                THEN requested_min_shares_out::NUMERIC = min_shares_out::NUMERIC
                ELSE FALSE
            END
        ),
    CONSTRAINT earn_vault_movements_last_valid_block_height_check
        CHECK (
            last_valid_block_height = TRUNC(last_valid_block_height)
            AND last_valid_block_height BETWEEN 0 AND 18446744073709551615
        )
);

-- SDP-side idempotency lock: one movement per caller key per organization.
-- Org-scoped rather than position-scoped on purpose — a retry that resolves to
-- a DIFFERENT position (e.g. the caller corrected the vault) is a different
-- request and must not silently reuse the key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_vault_movements_request
    ON earn_vault_movements(organization_id, request_id);

-- Chain correlation for the confirmation sweep.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_vault_movements_signature
    ON earn_vault_movements(signature);

-- History for one position, newest first, with the id tiebreaker.
CREATE INDEX IF NOT EXISTS idx_earn_vault_movements_position_created
    ON earn_vault_movements(position_id, created_at DESC, id DESC);

-- Hot existence probe for active-list defense and failed-attempt cleanup.
CREATE INDEX IF NOT EXISTS idx_earn_vault_movements_position_live_evidence
    ON earn_vault_movements(position_id)
    WHERE status IN ('pending', 'submitted', 'confirmed');

-- The sweep's work queue: every signed row without a chain outcome. A broadcast
-- timeout or crash leaves `pending` WITH a signature, so indexing only
-- `submitted` would omit precisely the ambiguous rows reconciliation is for.
CREATE INDEX IF NOT EXISTS idx_earn_vault_movements_unsettled
    ON earn_vault_movements(created_at ASC, id ASC)
    WHERE status IN ('pending', 'submitted');
