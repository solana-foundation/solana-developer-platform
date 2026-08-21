-- Solana Earn: move the share-ATA rent claim onto the MOVEMENT that makes it, and
-- make the position's funder a projection of those claims (PRO-1736).
--
-- ── What 0066 got wrong ───────────────────────────────────────────────────
-- 0066 put the funder on the position and wrote it from the intent transaction,
-- which commits BEFORE the transaction is broadcast. Nothing ever repaired it.
-- A movement that observed the share account missing, recorded itself as the
-- funder, and then never landed (blockhash expiry, or an on-chain failure that
-- reverts every effect) left the position permanently naming a party that paid
-- no rent. The exit that eventually closes the account reads exactly that value
-- as its CloseAccount destination, so 2,039,280 lamports went to the wrong
-- party, and the window was not the seconds between build and broadcast that
-- 0066's header claimed: it was forever.
--
-- ── The shape that fixes it ───────────────────────────────────────────────
-- The claim belongs on the movement, because the movement is the thing that
-- either pays or does not. `earn_positions.share_ata_rent_funder` becomes a
-- PROJECTION of those claims: the funder named by the most recent movement that
-- claimed creation and has not failed. Two consequences worth stating, because
-- they are the point rather than side effects:
--
--   * a movement that fails DROPS OUT of the projection, so the attribution
--     repairs itself the moment reconciliation reaches a verdict, and falls back
--     to the previous surviving claimant rather than to a guess;
--   * a movement that never won its idempotency insert has no row at all, so it
--     cannot contribute. The "only the winner may attribute rent" rule stops
--     being a thing callers have to remember.
--
-- The projection is maintained, not computed on read: it is written when a
-- vault intent wins its insert and again when a movement fails, both under the
-- position row lock those paths already take. Reads stay a plain column so the
-- exit path is one query.
--
-- Nothing to backfill. 0066 ships in this same change and has never populated a
-- deployed database, so there is no pre-projection value to preserve.
--
-- KNOWN RESIDUAL, unchanged and still the honest bound: creation is OBSERVED at
-- build time, so the claim itself can be wrong in either direction if chain
-- state moves before the transaction lands. One shape of that deserves naming:
-- a claimant that reached `confirmed` and was then dropped by a fork cannot be
-- failed (the transition matrix forbids confirmed -> failed rather than guess),
-- so its claim stays projected. It is not a new reachable loss: the dropped
-- create never landed, an exit only reads the projection when the account
-- exists at its build, and whoever re-created the account either wrote a newer
-- superseding claim (any SDP movement) or was external, which is this same
-- residual. Confirming the funder from the LANDED transaction is the real fix
-- and is still not attempted here. What this migration removes is the separate,
-- larger failure of never revisiting a claim whose transaction did not land at
-- all.

ALTER TABLE earn_movements
    ADD COLUMN IF NOT EXISTS creates_share_account BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS share_ata_rent_funder TEXT;

COMMENT ON COLUMN earn_movements.creates_share_account IS
    'Whether this movement''s instructions were OBSERVED to create the owner''s share token account, and so charge its rent. Observed against chain state at build time, never inferred from the instruction list: creation is idempotent.';

COMMENT ON COLUMN earn_movements.share_ata_rent_funder IS
    'Address this movement charged the share-ATA rent to. NULL with creates_share_account true means the custody wallet paid.';

-- A funder is only meaningful on a movement that created the account. Without
-- this, a caller could record a refund destination for rent it never charged.
ALTER TABLE earn_movements
    DROP CONSTRAINT IF EXISTS earn_movements_share_ata_rent_funder_shape;
ALTER TABLE earn_movements
    ADD CONSTRAINT earn_movements_share_ata_rent_funder_shape
    CHECK (share_ata_rent_funder IS NULL OR creates_share_account);

-- The projection's only lookup: newest surviving claimant for one position.
-- Partial, because claimants are a small minority of movements.
CREATE INDEX IF NOT EXISTS idx_earn_movements_share_account_claims
    ON earn_movements (position_id, created_at DESC, id DESC)
    WHERE creates_share_account;

COMMENT ON COLUMN earn_positions.share_ata_rent_funder IS
    'Projection of earn_movements: the funder named by the newest movement that claimed to create this position''s share ATA and has not failed. Refunded when the exit closes that account; NULL means the custody wallet funded it.';
