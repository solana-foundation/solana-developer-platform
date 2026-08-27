-- Solana Earn: external-wallet (caller-signed) vault positions and movements
-- (PRO-1722, ADR 0002 addendum 2026-08-26 "External wallets: caller-signed
-- vault movements").
--
-- ── The problem this closes ────────────────────────────────────────────────
-- The B2B2C motion rests on an EXTERNAL WALLET: a non-custodial wallet the
-- partner's platform connects, whose owner is not an SDP tenant. Every vault
-- money path so far resolves an exact
-- custody wallet and signs from it, so SDP could only move money it custodies;
-- no such concept existed anywhere in the schema. The mechanism is named for
-- the wallet: EXTERNAL, one SDP holds no key for. The contract decided for
-- PRO-1722: SDP builds and returns an UNSIGNED transaction for the external
-- wallet to sign, and records the movement when the signed transaction is
-- submitted back, before SDP broadcasts it.
--
-- ── Why NOT a third execution model ────────────────────────────────────────
-- An external-wallet movement executes exactly the way a custody-signed vault
-- movement does: one signed transaction, recorded durably with its signature,
-- wire bytes and blockhash window BEFORE broadcast, then driven terminal by
-- the same reconciliation sweep (query the recorded signature, rebroadcast the
-- recorded bytes while the blockhash lives, expire what never landed). The
-- execution model names HOW money moves on chain, not whose key signed, so
-- these rows stay `vault_direct` and inherit the whole outbox machinery: the
-- transition matrix, the unsettled index, the (organization_id, request_id)
-- idempotency anchor and the signature unique. A third model would have
-- duplicated all of it for an identical lifecycle.
--
-- The signer distinction is a column pair instead: exactly ONE of
-- `custody_wallet_id` (SDP signs) and `owner_address` (the external wallet signs) is
-- set, enforced by the reshaped constraints below. Every existing treasury
-- read scopes by custody wallet, so external-wallet rows are structurally invisible
-- to those surfaces rather than filtered out by convention.
--
-- ── Scoping ────────────────────────────────────────────────────────────────
-- The external wallet is modeled as an owner ADDRESS scoped to the partner org and
-- project, never a key SDP holds. The claim key for an external-wallet position
-- therefore includes `project_id`, unlike the custody claim where the project
-- is forensic attribution only: a partner's sibling project is a different
-- integration surface and must not see (or exit) another project's
-- external-wallet positions. `project_id` still nulls on project deletion (ON DELETE SET
-- NULL), which makes a deleted project's rows unaddressable rather than
-- shared, the same posture as movement reads.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Holdings: an external-wallet position is a vault claim held by an owner address.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE earn_positions
    ADD COLUMN IF NOT EXISTS owner_address TEXT;

ALTER TABLE earn_positions
    ADD CONSTRAINT earn_positions_owner_address_format_check
        CHECK (owner_address IS NULL OR LENGTH(owner_address) BETWEEN 32 AND 44);

-- Reshaped, not relaxed: the vault arm still pins every instrument column, and
-- the two signer columns are EXACTLY-ONE-OF ((a IS NOT NULL) <> (b IS NOT
-- NULL)), so an unowned or doubly-owned vault claim stays unrepresentable.
-- Existing rows satisfy the new shape by construction (custody set, owner
-- null), so this validates in place.
ALTER TABLE earn_positions
    DROP CONSTRAINT IF EXISTS earn_positions_kind_shape_check;
ALTER TABLE earn_positions
    ADD CONSTRAINT earn_positions_kind_shape_check
        CHECK (
            (
                kind = 'vault_direct'
                AND vault_address IS NOT NULL
                AND share_mint IS NOT NULL
                AND token_mint IS NOT NULL
                AND provider_wallet_id IS NULL
                AND ((custody_wallet_id IS NOT NULL) <> (owner_address IS NOT NULL))
            )
            OR (
                kind = 'custodial'
                AND provider_wallet_id IS NOT NULL
                AND custody_wallet_id IS NULL
                AND owner_address IS NULL
                AND vault_address IS NULL
                AND share_mint IS NULL
                AND token_mint IS NULL
            )
        );

-- One external-wallet position per (org, PROJECT, environment, provider, vault,
-- owner). Project is in the key on purpose (see the header); the custody claim
-- (idx_earn_positions_vault_claim) deliberately is not touched. Postgres
-- treats NULLs as distinct, so custody rows (owner NULL) never collide here
-- and the predicate keeps the index small anyway.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_positions_external_wallet_claim
    ON earn_positions(
        organization_id,
        project_id,
        environment,
        provider,
        vault_address,
        owner_address
    )
    WHERE kind = 'vault_direct' AND owner_address IS NOT NULL;

-- FK target for the external-wallet exact-claim constraint on movements below, the
-- mirror of earn_positions_movement_identity_key with the owner in place of
-- the custody wallet.
ALTER TABLE earn_positions
    ADD CONSTRAINT earn_positions_external_wallet_movement_identity_key
        UNIQUE (
            id,
            organization_id,
            project_id,
            environment,
            provider,
            vault_address,
            owner_address
        );

-- The per-wallet read path PRO-1724 serves: "what does this external wallet
-- hold in this project". Partial, so the treasury indexes stay untouched.
CREATE INDEX IF NOT EXISTS idx_earn_positions_external_wallet_owner
    ON earn_positions(
        organization_id,
        project_id,
        environment,
        owner_address,
        created_at DESC,
        id DESC
    )
    WHERE owner_address IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Movements: a vault movement signed by the external wallet, not by SDP.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE earn_movements
    ADD COLUMN IF NOT EXISTS owner_address TEXT;

ALTER TABLE earn_movements
    ADD CONSTRAINT earn_movements_owner_address_format_check
        CHECK (owner_address IS NULL OR LENGTH(owner_address) BETWEEN 32 AND 44);

-- Same reshape as the positions constraint: the signed-outbox columns stay
-- NOT NULL for every vault row (record-before-broadcast remains enforceable,
-- 0062's whole point), and the signer pair is exactly-one-of.
ALTER TABLE earn_movements
    DROP CONSTRAINT IF EXISTS earn_movements_model_shape_check;
ALTER TABLE earn_movements
    ADD CONSTRAINT earn_movements_model_shape_check
        CHECK (
            (
                execution_model = 'vault_direct'
                AND vault_address IS NOT NULL
                AND signature IS NOT NULL
                AND signed_transaction IS NOT NULL
                AND last_valid_block_height IS NOT NULL
                AND payout_token IS NULL
                AND fee_amount IS NULL
                AND ((custody_wallet_id IS NOT NULL) <> (owner_address IS NOT NULL))
            )
            OR (
                execution_model = 'custodial'
                AND custody_wallet_id IS NULL
                AND owner_address IS NULL
                AND vault_address IS NULL
                AND signature IS NULL
                AND signed_transaction IS NULL
                AND last_valid_block_height IS NULL
                AND min_shares_out IS NULL
                AND shares_out IS NULL
            )
        );

-- 0059's exact-claim guarantee for the external-wallet shape: an external-wallet movement is
-- pinned to the position that carries its exact (project, vault, owner) claim. MATCH
-- SIMPLE skips the constraint while any column is NULL, which is every custody
-- vault row (owner NULL) and every custodial row (vault NULL), so this binds
-- exactly the new shape and nothing else, the same trick the custody claim FK
-- already plays in reverse.
ALTER TABLE earn_movements
    ADD CONSTRAINT earn_movements_external_wallet_claim_fkey
        FOREIGN KEY (
            position_id,
            organization_id,
            project_id,
            environment,
            provider,
            vault_address,
            owner_address
        )
        REFERENCES earn_positions(
            id,
            organization_id,
            project_id,
            environment,
            provider,
            vault_address,
            owner_address
        );

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Built transactions: what SDP handed out to be signed.
--
-- The submit step has to prove the signed bytes it receives are a transaction
-- SDP built, gate-checked and simulated, byte for byte, with only signatures
-- added. Nothing client-supplied can prove that, so the build persists the
-- unsigned transaction and every resolved fact the movement insert will need;
-- the submit compares message bytes against THIS row and takes nothing but the
-- signatures from the wire.
--
-- NOT a movement and never money: an unconsumed row records that SDP built a
-- transaction nobody ever signed, which expires with its blockhash. One row is
-- consumable at most once (movement_id, guarded under a row lock at submit),
-- and one movement can consume at most one build (the unique movement_id),
-- because one built transaction can land on chain at most once; the ledger's
-- unique signature index backstops the same fact.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS earn_external_wallet_transactions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    -- The partner project the transaction was built for. Exact-matched at
    -- submit; SET NULL on deletion makes an orphaned row unsubmittable.
    project_id TEXT,
    environment TEXT NOT NULL,
    provider TEXT NOT NULL,
    direction TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    vault_address TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    share_mint TEXT NOT NULL,
    -- Display label the deposit's position claim will carry (the catalogue
    -- strategy name at build time); a withdrawal copies its position's.
    label TEXT NOT NULL,
    -- Withdrawals name the existing holding; a deposit's position may not
    -- exist until the submit claims it.
    position_id TEXT,
    -- Deposit: the token mint and a token amount. Withdrawal: the share mint
    -- and a share quantity. Same denomination discipline as the ledger.
    denomination TEXT NOT NULL,
    amount_requested TEXT NOT NULL,
    min_shares_out TEXT,
    -- Observed by the builder against chain state (the plan's own claim); the
    -- movement insert copies it for the 0067 rent-funder projection.
    creates_share_account BOOLEAN NOT NULL DEFAULT FALSE,
    -- Base64 wire bytes with empty signature slots, exactly as returned to the
    -- partner. The submit decodes both sides and compares MESSAGE bytes, so a
    -- partner cannot smuggle a different fee payer, blockhash or instruction
    -- list past the gates that admitted this build.
    unsigned_transaction TEXT NOT NULL,
    last_valid_block_height NUMERIC NOT NULL,
    -- Set when a submit consumed this transaction into a ledger movement.
    movement_id TEXT,
    consumed_at TEXT,
    created_by TEXT,
    initiated_by_key_id TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    FOREIGN KEY (direction) REFERENCES earn_movement_directions(id),
    FOREIGN KEY (position_id) REFERENCES earn_positions(id),
    FOREIGN KEY (movement_id) REFERENCES earn_movements(id),
    FOREIGN KEY (created_by) REFERENCES users(id),

    CONSTRAINT earn_external_wallet_transactions_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT earn_external_wallet_transactions_owner_address_format_check
        CHECK (LENGTH(owner_address) BETWEEN 32 AND 44),
    CONSTRAINT earn_external_wallet_transactions_amount_format_check
        CHECK (
            LENGTH(amount_requested) BETWEEN 1 AND 128
            AND amount_requested ~ '^\d+(\.\d+)?$'
            AND amount_requested ~ '[1-9]'
        ),
    CONSTRAINT earn_external_wallet_transactions_min_shares_out_format_check
        CHECK (
            min_shares_out IS NULL
            OR (
                LENGTH(min_shares_out) BETWEEN 1 AND 128
                AND min_shares_out ~ '^\d+(\.\d+)?$'
                AND min_shares_out ~ '[1-9]'
            )
        ),
    CONSTRAINT earn_external_wallet_transactions_denomination_check
        CHECK (LENGTH(BTRIM(denomination)) BETWEEN 1 AND 128),
    CONSTRAINT earn_external_wallet_transactions_last_valid_block_height_check
        CHECK (
            last_valid_block_height = TRUNC(last_valid_block_height)
            AND last_valid_block_height BETWEEN 0 AND 18446744073709551615
        ),
    -- Consumption is one fact with two columns; half-consumed is a lie.
    CONSTRAINT earn_external_wallet_transactions_consumed_shape_check
        CHECK ((movement_id IS NULL) = (consumed_at IS NULL)),
    CONSTRAINT earn_external_wallet_transactions_movement_id_key
        UNIQUE (movement_id)
);
