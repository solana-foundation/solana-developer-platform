-- Solana Earn: how a legacy row becomes a unified row — defined ONCE, in the
-- database, for both consumers (PRO-1705).
--
-- ── Why these are views and not SQL repeated in two places ─────────────────
-- The unification has two writers of the same projection:
--
--   * the BULK backfill (0064), which projects all existing history, and
--   * the application's DUAL-WRITE, which projects one row at a time as it is
--     written, so the new tables stay current until reads switch.
--
-- Spelled twice, those two would drift — and the parts that would drift are
-- exactly the parts that matter: which legacy status maps to which unified one,
-- which join supplies the denomination, whether a settled amount is recorded
-- yet. A silent disagreement between "history" and "new rows" in a money ledger
-- is the worst outcome this migration could produce.
--
-- So each projection is a VIEW. The backfill selects from it unfiltered; the
-- application selects from it by id. Neither can hold an opinion the other does
-- not, because there is only one expression to hold an opinion in.
--
-- ── These are transitional by design ──────────────────────────────────────
-- Every view reads a table the contract phase drops, so all four are dropped in
-- that same migration, alongside `earn_program_withdrawals` and
-- `earn_vault_movements`. They exist for exactly as long as two shapes do.
--
-- Column NAMES are still spelled at each INSERT (Postgres has no way to say
-- "insert these columns positionally and safely"), but the expressions — the
-- part with the judgement in it — live here alone.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Vault holdings (0059) → earn_positions.
--
-- `provider_reference` becomes `vault_address`: on 0059's positions that column
-- meant the INSTRUMENT, while on 0059's movements the same name meant the
-- provider's id for the movement. One name per meaning is what lets the merged
-- tables carry both.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW earn_projected_position_from_vault_position AS
SELECT
    legacy.id                  AS id,
    legacy.organization_id     AS organization_id,
    legacy.project_id          AS project_id,
    legacy.environment         AS environment,
    legacy.provider            AS provider,
    'vault_direct'::TEXT       AS kind,
    legacy.custody_wallet_id   AS custody_wallet_id,
    legacy.provider_reference  AS vault_address,
    legacy.share_mint          AS share_mint,
    legacy.token_mint          AS token_mint,
    legacy.label               AS label,
    legacy.created_by          AS created_by,
    legacy.created_at          AS created_at,
    legacy.updated_at          AS updated_at,
    legacy.activated_at        AS activated_at,
    legacy.closed_at           AS closed_at
FROM earn_vault_positions legacy;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Program wallets (0049/0056) → earn_positions.
--
-- A custodial position is a LINK row: the ACCOUNT stays in
-- earn_provider_wallets, which remains its source of truth, and every column
-- here is copied from it so the two cannot disagree.
--
-- `activated_at` is the wallet's own creation time — a custodial holding is
-- live from the moment its program exists, unlike a vault claim, which is only
-- activated by a durably recorded signed transaction.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW earn_projected_position_from_provider_wallet AS
SELECT
    wallet.id                                            AS provider_wallet_id,
    wallet.organization_id                               AS organization_id,
    wallet.project_id                                    AS project_id,
    wallet.environment                                   AS environment,
    wallet.provider                                      AS provider,
    'custodial'::TEXT                                    AS kind,
    -- earn_provider_wallets.label is nullable; earn_positions.label is not. The
    -- provider wallet ref is the honest fallback — it is what the provider
    -- console shows for an unlabelled program.
    COALESCE(wallet.label, wallet.provider_wallet_ref)    AS label,
    wallet.created_by                                    AS created_by,
    wallet.created_at                                    AS created_at,
    wallet.updated_at                                    AS updated_at,
    wallet.created_at                                    AS activated_at
FROM earn_provider_wallets wallet;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Withdrawal history (0055) → earn_movements.
--
-- * environment comes from the WALLET — 0055 has no environment column at all,
--   it was always derived through the program wallet.
-- * denomination is 'usd' because portfolio withdrawals are USD-denominated
--   (0055's vocabulary). `token` becomes `payout_token`: it names the payout
--   stablecoin, which is not the unit the amounts are in.
-- * status needs no mapping — 0055's vocabulary IS the custodial vocabulary.
-- * settled_at takes completed_at: provider completion is what "settled" means
--   on this side.
--
-- The join to earn_positions is INNER on purpose. A withdrawal whose program has
-- no position row must fail loudly rather than project a movement with no
-- holding: the position mint runs first, in the same migration and on the same
-- code path, so a miss is a bug and not a state to tolerate.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW earn_projected_movement_from_withdrawal AS
SELECT
    withdrawal.id                       AS id,
    withdrawal.organization_id          AS organization_id,
    withdrawal.project_id               AS project_id,
    wallet.environment                  AS environment,
    withdrawal.provider                 AS provider,
    'custodial'::TEXT                   AS execution_model,
    'withdrawal'::TEXT                  AS direction,
    position.id                         AS position_id,
    withdrawal.status                   AS status,
    withdrawal.failure_reason           AS failure_reason,
    withdrawal.completed_at             AS settled_at,
    'usd'::TEXT                         AS denomination,
    withdrawal.amount_requested_usd     AS amount_requested,
    withdrawal.amount_paid_usd          AS amount_settled,
    withdrawal.fee_usd                  AS fee_amount,
    withdrawal.token                    AS payout_token,
    withdrawal.destination_address       AS destination_address,
    withdrawal.provider_reference       AS provider_reference,
    withdrawal.request_id               AS request_id,
    withdrawal.idempotency_fingerprint  AS idempotency_fingerprint,
    withdrawal.provider_data            AS provider_data,
    withdrawal.created_by               AS created_by,
    withdrawal.initiated_by_key_id      AS initiated_by_key_id,
    withdrawal.created_at               AS created_at,
    withdrawal.updated_at               AS updated_at
FROM earn_program_withdrawals withdrawal
INNER JOIN earn_provider_wallets wallet
    ON wallet.id = withdrawal.wallet_id
INNER JOIN earn_positions position
    ON position.provider_wallet_id = wallet.id
   AND position.kind = 'custodial';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Vault movement history (0059) → earn_movements.
--
-- * status maps 'pending' → 'requested': the same meaning (a signed transaction
--   is durably recorded but is not known to be on the wire) under the one word
--   both execution models can share.
-- * denomination is the position's token_mint. A vault movement is denominated
--   in mint units, never USD — this is the join that keeps USD, mint units and
--   share counts from ever meeting in one column.
-- * amount_requested takes the caller's text and amount_settled the canonical
--   plan amount, and only once the chain has spoken. 0059 stored both and
--   DB-enforced them numerically equal, so collapsing them loses nothing while
--   each column now states WHICH of the two facts it holds. Same for the
--   slippage floor: the ENCODED value is the one that constrained the chain.
-- * settled_at stays NULL even for a confirmed row. Confirmation is not
--   finalization, and back-dating a settlement SDP never observed would be a
--   fabricated accounting fact; the finalization sweep sets it honestly.
-- * provider_reference stays NULL. A vault movement has no provider-side
--   movement id — the vault is the INSTRUMENT and lives in vault_address.
-- * source_address is the signing custody wallet and the vault is the
--   destination, so one movement feed can answer "where did this money come
--   from and where did it go" without branching on execution model.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW earn_projected_movement_from_vault_movement AS
SELECT
    legacy.id                       AS id,
    legacy.organization_id          AS organization_id,
    legacy.project_id               AS project_id,
    legacy.environment              AS environment,
    legacy.provider                 AS provider,
    'vault_direct'::TEXT            AS execution_model,
    CASE legacy.direction
        WHEN 'withdraw' THEN 'withdrawal'
        ELSE legacy.direction
    END                             AS direction,
    position.id                     AS position_id,
    CASE legacy.status
        WHEN 'pending' THEN 'requested'
        ELSE legacy.status
    END                             AS status,
    legacy.failure_reason           AS failure_reason,
    legacy.confirmed_at             AS confirmed_at,
    position.token_mint             AS denomination,
    legacy.requested_amount         AS amount_requested,
    CASE WHEN legacy.status = 'confirmed' THEN legacy.amount END AS amount_settled,
    legacy.min_shares_out           AS min_shares_out,
    legacy.shares                   AS shares_out,
    legacy.custody_wallet_id        AS custody_wallet_id,
    legacy.provider_reference       AS vault_address,
    wallet.public_key               AS source_address,
    legacy.provider_reference       AS destination_address,
    legacy.signature                AS signature,
    legacy.signed_transaction       AS signed_transaction,
    legacy.last_valid_block_height  AS last_valid_block_height,
    legacy.request_id               AS request_id,
    legacy.idempotency_fingerprint  AS idempotency_fingerprint,
    legacy.created_by               AS created_by,
    legacy.initiated_by_key_id      AS initiated_by_key_id,
    legacy.created_at               AS created_at,
    legacy.updated_at               AS updated_at
FROM earn_vault_movements legacy
INNER JOIN earn_positions position
    ON position.id = legacy.position_id
   AND position.kind = 'vault_direct'
INNER JOIN custody_wallets wallet
    ON wallet.id = legacy.custody_wallet_id;
