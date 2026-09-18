-- Solana Earn: let the ledger record an OBSERVED solver fulfillment.
--
-- A queued withdrawal request (0113) settles through the provider's solver:
-- the closing transaction is signed by Veda's solve authority, not by SDP, so
-- SDP can hold its signature and every accounting fact but never its signed
-- outbox bytes or a blockhash lease. 0062/0070's vault_direct shape required
-- both, which is exactly why fulfilled queue payouts were projected at read
-- time instead of being persisted — and the projection was only visible to the
-- repository methods that remembered to union earn_vault_withdrawal_requests.
-- The unified /v1/transactions feed never saw them, breaking the single-ledger
-- contract ("ONE row per real-world money movement", 0062).
--
-- This admits the third vault_direct shape: an observed fulfillment carries
-- the closing signature and no signed bytes. Custody and external wallets
-- alike can hold the position, so custody_wallet_id / owner_address keep
-- their request-row values; the exactly-one-of signer rule only ever governed
-- transactions SDP signed, which this arm excludes by signed_transaction IS
-- NULL. The initiated arm is unchanged, and the custodial arm is unchanged.
--
-- No backfill: the queued-withdrawal feature ships with this constraint, so
-- every fulfillment that can exist lands through the new writer.
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
                -- Observed solver fulfillment: SDP's ledger row for a payout
                -- the provider's solver executed. The signature is the closing
                -- transaction (unique per fulfillment via
                -- idx_earn_movements_signature); no outbox exists to rebroadcast.
                -- The signer pair stays exactly-one-of (0070): a custody
                -- fulfillment must not claim an owner, and an external one must
                -- not claim a custody wallet, or the external-wallet claim FK
                -- would resolve against a position row that cannot match.
                execution_model = 'vault_direct'
                AND vault_address IS NOT NULL
                AND signature IS NOT NULL
                AND signed_transaction IS NULL
                AND last_valid_block_height IS NULL
                AND payout_token IS NULL
                AND fee_amount IS NULL
                AND min_shares_out IS NULL
                AND shares_out IS NULL
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
