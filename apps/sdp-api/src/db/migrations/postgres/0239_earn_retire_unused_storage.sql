-- sdp:migration-compat: breaking
-- Prelaunch, deliberate data loss: retire storage with no core Earn readers
-- or writers. Deploy the Earn rewrite parent before this schema-only release.
-- This is forward-only: do not restore an image that uses the removed tables
-- or provider_wallet_id. No data is copied, adopted or recovered here.
--
-- Remove only retired provider-managed account positions and their custodial
-- movements. Live custody-wallet and owner-address flows use vault_direct;
-- their positions, signed ledger, canonical builds and queued exits remain.
-- A remaining dependency aborts the transaction instead of cascading away.

DROP TABLE earn_external_wallet_transactions;
DROP TABLE earn_external_wallet_withdrawal_request_transactions;
DROP TABLE earn_split_swap_advisories;
DROP TABLE earn_provider_actions;

-- Retired advisories and provider commands may reference the old ledger.
-- Drop them first, then delete children before their position parents.
DELETE FROM earn_movements WHERE execution_model = 'custodial';
DELETE FROM earn_positions WHERE kind = 'custodial';

ALTER TABLE earn_positions
    DROP CONSTRAINT earn_positions_kind_shape_check,
    ADD CONSTRAINT earn_positions_kind_shape_check CHECK (
        kind = 'vault_direct'
        AND vault_address IS NOT NULL
        AND share_mint IS NOT NULL
        AND token_mint IS NOT NULL
        AND ((custody_wallet_id IS NOT NULL) <> (owner_address IS NOT NULL))
    );

-- The column owns its provider-account FK and retired partial unique index.
-- Shared strategy-reference and operation-only trigger functions stay live.
ALTER TABLE earn_positions DROP COLUMN provider_wallet_id;
DROP TABLE earn_provider_wallets;
