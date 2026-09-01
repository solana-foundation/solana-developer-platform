-- ==========================================================================
-- Helius Rings: what the default money flows need on top of 0057.
--
-- 0057 described a simulated integration: wallets and operations existed, but
-- nothing built, signed or submitted a real transaction. This adds what a live
-- one needs, and most of it is about recovery rather than about the happy path:
--
--   * a durable link to the custody wallet that signs, and the owner address
--     the shielded identity is published under
--   * two failure codes the pipeline can now actually produce, and a terminal
--     `voided` state so a signed failure can be settled rather than freezing a
--     wallet forever
--   * a guard against two concurrent private spends on one wallet, and against
--     a duplicate of a deposit that may already have landed
--   * the exact-byte submission outbox that makes a lost RPC response
--     recoverable, plus the notes a spend committed to
--   * the indexer position a read must catch up to before it is trusted
-- ==========================================================================


-- --------------------------------------------------------------------------
-- The custody wallet that signs for this identity
-- --------------------------------------------------------------------------
-- sdp_wallet_id is the provider's id for the wallet and can be reissued;
-- custody_wallets.id is the immutable row a signer resolves from. Signing the
-- wrong wallet's transaction is not a recoverable mistake, so the row id is
-- recorded at provisioning and used from then on.
--
-- Nullable because the column is written by provisioning, and a row exists from
-- the moment the intent is reserved. Every live provision sets it.
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

-- Dropped first, like every other constraint in this file. The whole migration
-- has to be re-runnable: it was iterated on before it shipped, and a bare
-- `ADD CONSTRAINT` against a name that already exists aborts the file after the
-- index drops further down have already been planned.
ALTER TABLE helius_rings_wallets
    DROP CONSTRAINT IF EXISTS helius_rings_wallets_owner_identity_pair_check;

-- 0057 persisted the shielded address without the owner it was derived from,
-- and without the custody_wallets row a signer resolves. Local (and any other)
-- environments that provisioned before this file ran still have those rows;
-- adding the pair check against them fails with a CHECK violation. Pin both
-- from the custody wallet the identity was published under, then validate.
UPDATE helius_rings_wallets w
SET custody_wallet_id = matched.id
FROM (
    SELECT DISTINCT ON (cw.wallet_id, cc.organization_id)
        cw.id,
        cw.wallet_id,
        cc.organization_id
    FROM custody_wallets cw
    JOIN custody_configs cc ON cc.id = cw.custody_config_id
    ORDER BY
        cw.wallet_id,
        cc.organization_id,
        (cw.status = 'active') DESC,
        cw.created_at,
        cw.id
) matched
WHERE w.sdp_wallet_id = matched.wallet_id
  AND w.organization_id = matched.organization_id
  AND w.custody_wallet_id IS NULL;

UPDATE helius_rings_wallets w
SET owner_address = cw.public_key
FROM custody_wallets cw
WHERE w.custody_wallet_id = cw.id
  AND w.shielded_address IS NOT NULL
  AND w.owner_address IS NULL;

ALTER TABLE helius_rings_wallets
    ADD CONSTRAINT helius_rings_wallets_owner_identity_pair_check
        CHECK ((owner_address IS NULL) = (shielded_address IS NULL));


-- --------------------------------------------------------------------------
-- How far the indexer must have caught up
-- --------------------------------------------------------------------------
-- Photon is a separate service reading the chain, so it always trails it. Ask
-- it about a wallet immediately after a transaction lands and it will answer
-- completely and truthfully about a moment before that transaction existed —
-- no error, just the past.
--
-- That is how a spend picks a note another operation already consumed: the
-- selection reads a view in which it was still unspent, and the chain then
-- rejects the transaction for a spent nullifier. Recording the last slot known
-- to have touched this wallet lets the next read wait for the indexer to reach
-- it before trusting the answer.
--
-- NUMERIC because a slot is a uint64, which JS `number` cannot hold across its
-- whole range; it is read and written as a string.
ALTER TABLE helius_rings_wallets
    ADD COLUMN IF NOT EXISTS last_indexed_slot NUMERIC;

ALTER TABLE helius_rings_wallets
    DROP CONSTRAINT IF EXISTS helius_rings_wallets_last_indexed_slot_check;

ALTER TABLE helius_rings_wallets
    ADD CONSTRAINT helius_rings_wallets_last_indexed_slot_check
        CHECK (
            last_indexed_slot IS NULL
            OR (
                SCALE(last_indexed_slot) = 0
                AND last_indexed_slot BETWEEN 0 AND 18446744073709551615
            )
        );


-- --------------------------------------------------------------------------
-- The `voided` state
-- --------------------------------------------------------------------------
-- The unique indexes below hold a wallet slot for any comparable operation that
-- is in flight, or that failed after signing. That is the money-safety
-- backstop, and on its own it is also a freeze: nothing would take a row out of
-- those predicates except `completed`, and a failure cannot become that.
--
-- `voided` is the other way out — a signed failure an operator has confirmed
-- never landed. It releases the wallet purely by not being a state the
-- predicates name, exactly as `completed` does.
--
-- Deliberately a state rather than a column on `failed`. An
-- `operator_resolved_at` flag would become a third conjunct in both unique
-- indexes and in every future "is this wallet stuck" query, and one missed
-- `AND` either re-opens the double-pay hole or keeps the wallet frozen.
ALTER TABLE helius_rings_operations
    DROP CONSTRAINT IF EXISTS helius_rings_operations_state_check;

ALTER TABLE helius_rings_operations
    ADD CONSTRAINT helius_rings_operations_state_check
        CHECK (
            state IN (
                'draft',
                'preparing',
                'approval_required',
                'proving',
                'ready_to_sign',
                'submitted',
                'indexing',
                'completed',
                'failed',
                'voided'
            )
        );


-- --------------------------------------------------------------------------
-- The failure triple survives a void
-- --------------------------------------------------------------------------
-- 0057 tied the failure columns to `state = 'failed'` exactly. A voided row
-- keeps them, because they are why it was put in front of an operator at all;
-- clearing them would erase the reason for the reconciliation. Retry requires
-- `state = 'failed'`, so a voided row cannot be retried even where an older
-- `submit_failed` still reads `retryable`.
--
-- `completed` still cannot carry them, which is what forces the reconcile's
-- landed path to null all three in the same UPDATE as the state change.
ALTER TABLE helius_rings_operations
    DROP CONSTRAINT IF EXISTS helius_rings_operations_failure_check;

ALTER TABLE helius_rings_operations
    ADD CONSTRAINT helius_rings_operations_failure_check
        CHECK (
            (
                state IN ('failed', 'voided')
                AND failure_code IS NOT NULL
                AND failure_message IS NOT NULL
                AND retryable IS NOT NULL
            )
            OR (
                state NOT IN ('failed', 'voided')
                AND failure_code IS NULL
                AND failure_message IS NULL
                AND retryable IS NULL
            )
        );


-- --------------------------------------------------------------------------
-- Two failure codes the pipeline can now produce
-- --------------------------------------------------------------------------
-- `config_error`: a deployment that selects the TypeScript adapter without the
-- endpoints or the derivation seed fails every operation. Recording that as
-- `gateway_unavailable` reads as transient and offers a retry that cannot
-- succeed — the operator needs to be sent to the environment, not to the retry
-- button.
--
-- `manual_reconciliation_required`: signed bytes exist, their blockhash has
-- expired, and whether they landed is unknown. Every other code either invites
-- a retry or names something a retry cannot fix. This one says the opposite of
-- both — do not retry, and do not treat it as closed — because a fresh attempt
-- could double-pay and abandoning it could strand funds. An operator
-- reconciles the signature against the chain by hand.
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
                'insufficient_balance',
                'manual_reconciliation_required'
            )
        );


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
    DROP CONSTRAINT IF EXISTS helius_rings_operations_signed_outbox_pair_check,
    DROP CONSTRAINT IF EXISTS helius_rings_operations_signed_outbox_signature_check,
    DROP CONSTRAINT IF EXISTS helius_rings_operations_submission_started_check,
    DROP CONSTRAINT IF EXISTS helius_rings_operations_last_valid_block_height_check;

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


-- --------------------------------------------------------------------------
-- One private spend at a time, per wallet
-- --------------------------------------------------------------------------
-- A transfer, withdrawal and merge all consume notes, and two in flight
-- together can choose overlapping inputs. Whichever lands second is rejected
-- for a spent nullifier after the money has already moved once. Serialising
-- them in the database is what makes that impossible rather than merely
-- unlikely; a shield has no such constraint because it creates notes instead
-- of consuming them.
--
-- Scoped to the states that have actually selected notes. Selection happens
-- when the outer transaction is built, on entry to `proving`; everything
-- earlier is a row describing an intent. Including `draft` or
-- `approval_required` here would mean one transfer awaiting a human approver
-- froze the whole wallet, and would block a second operation from even being
-- prepared — a restriction with no note collision behind it to justify it.
--
-- A failed spend that got as far as signed bytes keeps the slot. Failing is not
-- the same as not having happened: `submit_failed` and `indexing_timeout` both
-- leave a transaction that may be sitting in the mempool or already settled.
-- Releasing the slot there is what would let a second spend be filed under a
-- fresh client nonce — past the retry guard, which only governs the retry
-- endpoint — and pay the recipient again. Held until an operator resolves it;
-- `completed`, and any failure from before signing, release it as they should.
-- Dropped first, not `IF NOT EXISTS`. This migration was iterated on before it
-- shipped, and the runner keys `schema_migrations` on the file name — so a
-- database that applied an earlier draft under its old name will run this file
-- as new, find the index already present, and silently keep the old predicate.
-- That is precisely the version without the failed-and-signed clause, so the
-- skip would leave the double-pay hole open on exactly the databases that have
-- been running longest.
--
-- `voided` is absent from the predicate, which is the whole mechanism: a
-- reconciled row releases the wallet without this index needing to know that
-- state exists.
DROP INDEX IF EXISTS idx_helius_rings_operations_active_spend;

CREATE UNIQUE INDEX idx_helius_rings_operations_active_spend
    ON helius_rings_operations(wallet_id)
    WHERE op_type IN ('transfer_registered', 'withdraw', 'merge')
      AND (
          state IN ('proving', 'ready_to_sign', 'submitted', 'indexing')
          OR (state = 'failed' AND signed_transaction IS NOT NULL)
      );


-- --------------------------------------------------------------------------
-- One unsettled deposit at a time, per wallet
-- --------------------------------------------------------------------------
-- A deposit that signed and then failed may still land, and re-filing it debits
-- the owner's public balance a second time. Not a double-spend of any note —
-- the owner asked to move one amount and moved two.
--
-- The same predicate as the spend index, for a reason worth stating: a partial
-- unique index can only conflict two rows that both match it, so covering only
-- the failed row would mean a new deposit never collided with it and the index
-- enforced nothing. Covering the in-flight states too is what makes the
-- duplicate collide with the row it duplicates.
--
-- The cost is that two simultaneous deposits on one wallet serialise rather
-- than running together. That is a real restriction and it is the deliberate
-- trade: two deposits at once is a convenience, and this is the only backstop
-- behind a service check that queries for the blocking row and could miss it.
DROP INDEX IF EXISTS idx_helius_rings_operations_unsettled_shield;

CREATE UNIQUE INDEX idx_helius_rings_operations_unsettled_shield
    ON helius_rings_operations(wallet_id)
    WHERE op_type = 'shield'
      AND (
          state IN ('proving', 'ready_to_sign', 'submitted', 'indexing')
          OR (state = 'failed' AND signed_transaction IS NOT NULL)
      );


-- --------------------------------------------------------------------------
-- The notes a spend committed to
-- --------------------------------------------------------------------------
-- A transfer and a withdrawal select their inputs at build time. Left to
-- reselect, a rebuild after a lost response can choose a disjoint set and land
-- alongside the original — the recipient paid twice. Recording the commitments
-- makes a rebuild spend the same notes, so the loser is rejected for a spent
-- nullifier instead of settling.
--
-- JSONB rather than TEXT[]: the value is written and read whole, never queried
-- element-wise, and jsonb gives the array a shape the CHECK below can verify.
--
-- Null for an operation that has not been built, and for a shield, which
-- creates notes rather than consuming them. Distinguishing "no inputs" from
-- "not yet built" is why this is nullable rather than defaulting to '[]'.
ALTER TABLE helius_rings_operations
    ADD COLUMN IF NOT EXISTS input_notes JSONB;

ALTER TABLE helius_rings_operations
    DROP CONSTRAINT IF EXISTS helius_rings_operations_input_notes_array_check;

ALTER TABLE helius_rings_operations
    -- An object or a bare string here would be a serialization bug, and it
    -- would only surface as a failed rebuild long after the write.
    ADD CONSTRAINT helius_rings_operations_input_notes_array_check
        CHECK (input_notes IS NULL OR jsonb_typeof(input_notes) = 'array');


-- --------------------------------------------------------------------------
-- Finding the operations that need reconciling
-- --------------------------------------------------------------------------
-- The sweep looks for submitted operations whose blockhash may have expired,
-- which means ordering by expiry among rows that have signed bytes. Without
-- this it is a full scan of every operation ever recorded, run every minute.
CREATE INDEX IF NOT EXISTS idx_helius_rings_operations_awaiting_reconciliation
    ON helius_rings_operations(last_valid_block_height)
    WHERE signed_transaction IS NOT NULL
      AND state IN ('submitted', 'indexing');


-- --------------------------------------------------------------------------
-- A note on helius_rings_key_refs
-- --------------------------------------------------------------------------
-- 0057 created that table to hold encrypted viewing and nullifier material,
-- and nothing writes it. The deployed key authority derives material from
-- HELIUS_RINGS_DETERMINISTIC_KA_SEED on every use and destroys it after, so
-- there is nothing at rest to store.
--
-- Recorded here rather than dropped because the table is the shape a real key
-- authority needs, and because the difference matters operationally: with the
-- deterministic authority every wallet's keys are reproducible from one
-- environment variable, which is a very different secret to hold than a table
-- of individually wrapped blobs.
COMMENT ON TABLE helius_rings_key_refs IS
    'Reserved. Unused under the hardcoded deterministic key authority, which derives material per use rather than storing it.';
