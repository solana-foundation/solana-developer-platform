-- Solana Earn: drop the mechanism-split movement tables (PRO-1705).
--
-- The last step of expand → backfill → switch → contract. Nothing reads or writes
-- `earn_program_withdrawals`, `earn_vault_movements` or `earn_vault_positions` any
-- more: their history was projected into `earn_movements` / `earn_positions` with
-- ids preserved (0064, swept again by 0065), reads moved over, and the previous
-- release removed the code that served them.
--
-- ── Why this is alone in its own release ──────────────────────────────────
-- This is the ONE irreversible step in the whole sequence. Every other deploy can
-- be walked back by re-serving the previous revision; once these tables are gone
-- their original bytes are gone with them.
--
-- So it ships by itself, AFTER the revision that stopped writing them is live. A
-- deploy that both stopped the writes and dropped the tables would leave a
-- rollback landing on a revision that writes into tables which no longer exist —
-- every deposit and every withdrawal failing.
--
-- ── Before applying ──────────────────────────────────────────────────────
-- 1. Confirm the revision that retired the legacy writers is deployed and has
--    soaked for at least one release.
-- 2. Run the read-only parity check: row counts and a per-row projection diff
--    between each legacy table and `earn_movements`, expecting zero differences.
-- 3. `pg_dump` these three tables to the archived-artifact bucket. They are money
--    history feeding an audit and, later, tax and accounting records; database
--    backups age out on a retention window and audit questions do not. Restoring
--    a table-scoped dump into a scratch database is one command, and the volume
--    is small.
--
-- ── What goes, and what deliberately stays ───────────────────────────────
-- The four `earn_projected_*` views go WITH the tables: each one reads a table
-- being dropped, and they existed for exactly as long as two shapes did.
--
-- `earn_provider_wallets` STAYS. It models an ACCOUNT at a provider — the
-- custodial twin of `custody_wallets` — and an account is not a holding. Every
-- custodial movement reaches its program through the `earn_positions` link row,
-- and `earn_positions.provider_wallet_id` references this table, so dropping it
-- would take the ledger's own tenancy with it.
--
-- 0055 and 0059 stay as applied history; these drops are forward-only.

DROP VIEW IF EXISTS earn_projected_movement_from_vault_movement;
DROP VIEW IF EXISTS earn_projected_movement_from_withdrawal;
DROP VIEW IF EXISTS earn_projected_position_from_vault_position;
DROP VIEW IF EXISTS earn_projected_position_from_provider_wallet;

-- Movements before holdings: earn_vault_movements carries the six-column
-- composite foreign key into earn_vault_positions.
DROP TABLE IF EXISTS earn_vault_movements;
DROP TABLE IF EXISTS earn_vault_positions;
DROP TABLE IF EXISTS earn_program_withdrawals;
