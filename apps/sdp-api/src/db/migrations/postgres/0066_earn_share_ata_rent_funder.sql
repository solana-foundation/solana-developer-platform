-- Solana Earn: remember who funded a position's share-ATA rent, so it can be
-- given back when the account is closed (PRO-1736).
--
-- ── The leak this exists to close ─────────────────────────────────────────
-- A first deposit into a K-Vault must create the owner's share token account,
-- which costs 2,039,280 lamports of rent-exemption. Nobody was ever getting it
-- back: SDP builds its exit through klend's `withdrawIxs`, whose `WithdrawIxs`
-- shape carries no cleanup instructions, so the share ATA is never closed and
-- its rent stays locked in an account holding zero shares. That was already
-- true when the custody wallet paid it. Sponsorship only changes WHO strands
-- the lamports, so the exit now closes the account and returns them.
--
-- ── Why a column and not a re-derivation ──────────────────────────────────
-- Closing an account credits its lamports to whatever destination the close
-- instruction names, and the right destination is whoever actually paid. That
-- is a fact about the DEPOSIT, while the close happens on the EXIT, possibly
-- months later. Nothing on chain records who funded rent, and the sponsorship
-- flag may have flipped in between, so re-deriving it at exit would sooner or
-- later refund the wrong party. Refunding a sponsor for rent the customer paid
-- is taking the customer's lamports, which is why this is stored rather than
-- inferred.
--
-- NULL means the owner funded it, which is both the historical default and the
-- unsponsored one, and it makes the close destination fall back to the custody
-- wallet with no special case. Only a deposit that OBSERVED the account missing
-- and created it writes an address here.
--
-- Set on the position rather than the movement because the account is per
-- (wallet, share mint): one position, many deposits, and only the first one
-- pays. It is cleared when the account is closed, so a re-entry that pays rent
-- again records its own funder rather than inheriting a stale one.

ALTER TABLE earn_positions
    ADD COLUMN IF NOT EXISTS share_ata_rent_funder TEXT;

COMMENT ON COLUMN earn_positions.share_ata_rent_funder IS
    'Address that funded this position''s share-ATA rent, refunded when the exit closes that account. NULL means the custody wallet funded it.';
