-- ==========================================================================
-- Helius Rings: what the default money flows need on top of 0057.
--
-- 0057 described a simulated integration. This adds the four things a live
-- one needs: a durable link to the custody wallet that signs, a failure code
-- for misconfiguration, a guard against two concurrent private spends, and
-- the exact-byte submission outbox that makes a lost RPC response
-- recoverable.
-- ==========================================================================


-- --------------------------------------------------------------------------
-- The custody wallet that signs for this identity
-- --------------------------------------------------------------------------
-- sdp_wallet_id is the provider's id for the wallet and can be reissued;
-- custody_wallets.id is the immutable row a signer resolves from. Signing the
-- wrong wallet's transaction is not a recoverable mistake, so the row id is
-- recorded at provisioning and used from then on.
--
-- Nullable because rows provisioned before this migration were simulated and
-- have no custody wallet behind them. New live provisioning always writes it.
ALTER TABLE helius_rings_wallets
    ADD COLUMN IF NOT EXISTS custody_wallet_id TEXT
        REFERENCES custody_wallets(id) ON DELETE RESTRICT;


-- --------------------------------------------------------------------------
-- The owner address the identity is published under
-- --------------------------------------------------------------------------
-- shielded_address is derived from this key, so the two are one fact and are
-- stored together. Every later call re-derives the identity and checks it
-- against the stored one, which is only meaningful if the owner it derives
-- from is pinned here rather than re-read from a custody provider that could
-- answer differently.
--
-- Null exactly when shielded_address is null: an identity without its owner
-- cannot be verified, and an owner without an identity has nothing to verify.
ALTER TABLE helius_rings_wallets
    ADD COLUMN IF NOT EXISTS owner_address TEXT;

-- NOT VALID, because every wallet provisioned under 0057 already breaks this:
-- those rows carry a simulated shielded_address and no owner, so validating
-- them would abort the migration on exactly the deployments that have been
-- running longest. They are not backfillable either — a simulated identity was
-- never derived from a real owner, so there is no correct value to write.
--
-- The constraint still governs every insert and update from here on, which is
-- what the invariant is for. It is deliberately never validated afterwards:
-- the legacy rows stay non-conforming until a live provision overwrites them.
ALTER TABLE helius_rings_wallets
    ADD CONSTRAINT helius_rings_wallets_owner_identity_pair_check
        CHECK ((owner_address IS NULL) = (shielded_address IS NULL)) NOT VALID;


-- --------------------------------------------------------------------------
-- config_error
-- --------------------------------------------------------------------------
-- The gateway already produces this: a deployment that selects the TypeScript
-- adapter without the endpoints or the derivation seed fails every operation.
-- Until now it had to be recorded as `gateway_unavailable`, which reads as
-- transient and offers a retry that cannot succeed — the operator needs to be
-- sent to the environment, not to the retry button.
ALTER TABLE helius_rings_operations
    DROP CONSTRAINT IF EXISTS helius_rings_operations_failure_code_check;

ALTER TABLE helius_rings_operations
    ADD CONSTRAINT helius_rings_operations_failure_code_check
        CHECK (
            failure_code IS NULL
            OR failure_code IN (
                'policy_denied',
                'approval_rejected',
                'proof_failed',
                'signer_failed',
                'submit_failed',
                'indexing_timeout',
                'gateway_unavailable',
                'config_error',
                'invalid_input',
                'insufficient_balance'
            )
        );


-- --------------------------------------------------------------------------
-- One private spend at a time, per wallet
-- --------------------------------------------------------------------------
-- A transfer, withdrawal and merge all consume notes, and neither the TS SDK
-- nor the Rust one lets a caller pin which notes a transfer will select. Two
-- in flight together can therefore choose overlapping inputs, and whichever
-- lands second is rejected for a spent nullifier after the money has already
-- moved once. Serialising them in the database is what makes that impossible
-- rather than merely unlikely; a shield has no such constraint because it
-- creates notes instead of consuming them.
--
-- Scoped to the states that have actually selected notes. Selection happens
-- when the outer transaction is built, on entry to `proving`; everything
-- earlier is a row describing an intent. Including `draft` or
-- `approval_required` here would mean one transfer awaiting a human approver
-- froze the whole wallet, and would block a second operation from even being
-- prepared — a restriction with no note-collision behind it to justify it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_helius_rings_operations_active_spend
    ON helius_rings_operations(wallet_id)
    WHERE op_type IN ('transfer_registered', 'withdraw', 'merge')
      AND state IN ('proving', 'ready_to_sign', 'submitted', 'indexing');


-- --------------------------------------------------------------------------
-- Exact-byte submission outbox
-- --------------------------------------------------------------------------
-- Mirrors 0066_payment_transfer_submission_outbox.sql, for the same reason and
-- with the same ordering: persist the signed bytes and their expiry, mark the
-- submission durably started, then broadcast. Rebuilding after a lost response
-- is not an option here — a rebuilt transfer may select different notes and
-- land alongside the original, paying the recipient twice — so recovery
-- resubmits these exact bytes or escalates.
ALTER TABLE helius_rings_operations
    ADD COLUMN IF NOT EXISTS signed_transaction TEXT,
    ADD COLUMN IF NOT EXISTS last_valid_block_height NUMERIC,
    ADD COLUMN IF NOT EXISTS submission_started_at TEXT;

ALTER TABLE helius_rings_operations
    -- Signed bytes without an expiry cannot be retired, and an expiry without
    -- bytes cannot be acted on; neither half is useful alone.
    ADD CONSTRAINT helius_rings_operations_signed_outbox_pair_check
        CHECK ((signed_transaction IS NULL) = (last_valid_block_height IS NULL)),
    -- The signature is derived locally from the signed bytes before submission,
    -- so it is what a recovery reconciles against and must already be recorded.
    ADD CONSTRAINT helius_rings_operations_signed_outbox_signature_check
        CHECK (signed_transaction IS NULL OR outer_tx_signature IS NOT NULL),
    ADD CONSTRAINT helius_rings_operations_submission_started_check
        CHECK (submission_started_at IS NULL OR signed_transaction IS NOT NULL),
    ADD CONSTRAINT helius_rings_operations_last_valid_block_height_check
        CHECK (
            last_valid_block_height IS NULL
            OR (
                SCALE(last_valid_block_height) = 0
                AND last_valid_block_height BETWEEN 0 AND 18446744073709551615
            )
        );
