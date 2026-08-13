-- Solana Earn: the withdrawal ledger, and the end of the empty ledgers
-- (PRO-1628, ADR 0002 addendum "Ledger vs live").
--
-- Decision: SDP ledgers what SDP initiates; SDP reads live what the provider
-- observes. Positions/balances are live provider snapshots (never persisted),
-- deposits are provider-observed (live), and portfolio withdrawals — the one
-- money movement SDP initiates — get the row every other money movement in the
-- platform already has (payment_transfers precedent).
--
-- Drops are safe by construction: no production code ever wrote
-- earn_positions, earn_movements, or earn_nav_snapshots (their writer was the
-- per-strategy execution path, which the portfolio-wallet model shipped
-- without), the dev seed never touched positions/movements, and nothing else
-- in the schema references them. 0048 stays as applied history; these drops
-- are forward-only.
--
-- earn_program_withdrawals conventions:
-- * provider is open TEXT (ADR 0001/0002 drift rule): a row can outlive its
--   provider's registry entry; allowed values live in code registries.
-- * Money is USD decimal strings (portfolio vocabulary) — no numeric columns.
-- * project_id / created_by / initiated_by_key_id are write-only forensic
--   columns (who/which key pulled money, which project provisioned the call):
--   money tables carry provisioning attribution even when no wire surface
--   reads it. initiated_by_key_id is bare TEXT with no FK, matching
--   payment_transfers / payment_transfer_batches / issuance_transactions.
-- * Scoping is the WALLET, not (org, project): the program wallet is unique
--   per (org, environment, provider) with project deliberately absent (0049),
--   and every project in an environment reaches the same wallet.

DROP TABLE IF EXISTS earn_movements;      -- FKs earn_positions; drop first
DROP TABLE IF EXISTS earn_positions;
DROP TABLE IF EXISTS earn_nav_snapshots;  -- no production writer; endpoint unreachable; getNav never implemented

CREATE TABLE IF NOT EXISTS earn_program_withdrawals (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    wallet_id TEXT NOT NULL,
    provider TEXT NOT NULL,

    -- 'requested' is SDP-only intent state (row exists, provider call not yet
    -- accepted); everything else is the canonical provider-observed vocabulary.
    status TEXT NOT NULL DEFAULT 'requested',

    -- USD decimal strings.
    amount_requested_usd TEXT NOT NULL,
    amount_paid_usd TEXT,
    fee_usd TEXT,
    token TEXT NOT NULL,
    destination_address TEXT NOT NULL,
    failure_reason TEXT,

    -- Derived provider request id (deriveProviderRequestId): the idempotency
    -- anchor, already tenant-unique because the derivation mixes in the
    -- (org, environment, provider)-unique wallet ref.
    request_id TEXT NOT NULL,
    -- NOT NULL on purpose: earn refuses keyless withdrawals, so the
    -- resolveIdempotencyReplay "null fingerprint = unclaimed" branch must be
    -- unrepresentable here (a null row would turn the unique-violation replay
    -- backstop into an unrecoverable 500).
    idempotency_fingerprint TEXT NOT NULL,
    -- Provider withdrawalRef, set when the provider accepts the create. A row
    -- without one is an unresolved intent: healed by a same-key create retry
    -- or the ledger sweep — never by fuzzy matching.
    provider_reference TEXT,
    provider_data JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_by TEXT,
    initiated_by_key_id TEXT,

    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    completed_at TEXT,

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    -- Deliberately NO cascade: a wallet with withdrawal history must not be
    -- deletable (same fail-loud philosophy as the catalogue FKs in 0048).
    FOREIGN KEY (wallet_id) REFERENCES earn_provider_wallets(id),
    FOREIGN KEY (created_by) REFERENCES users(id),

    CONSTRAINT earn_program_withdrawals_provider_data_is_object
        CHECK (jsonb_typeof(provider_data) = 'object'),
    CONSTRAINT earn_program_withdrawals_status_check
        CHECK (status IN ('requested', 'processing', 'pending_approval', 'completed',
                          'partially_completed', 'failed', 'cancelled'))
);

-- SDP-side idempotency lock: one intent row per derived request id per wallet.
-- Wallet-scoped, not (org, project): sibling projects in one environment share
-- the wallet and derive the SAME request id for the same caller key — a
-- narrower anchor would let the second project miss the replay row, insert a
-- duplicate intent, and strand it on the provider_reference unique below.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_program_withdrawals_wallet_request
    ON earn_program_withdrawals(wallet_id, request_id);

-- Settlement correlation for poll/sweep/webhook observation writes. Global
-- (not tenant-scoped) like the 0008 ramp-attributes index, so a system-scope
-- lookup needs no org/project; callers assert organization_id after the fetch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_program_withdrawals_provider_reference
    ON earn_program_withdrawals(provider, provider_reference)
    WHERE provider_reference IS NOT NULL;

-- List path: id joins created_at as the deterministic pagination tiebreaker
-- (same lesson as payment_transfers migrations 0028-0031 and 0048's indexes).
CREATE INDEX IF NOT EXISTS idx_earn_program_withdrawals_wallet_created
    ON earn_program_withdrawals(wallet_id, created_at DESC, id DESC);
