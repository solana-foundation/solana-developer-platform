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
-- wallet with no special case. Only a movement that OBSERVED the account missing
-- and created it writes an address here.
--
-- Read from the position because the account is per (wallet, share mint): one
-- position, many movements, and the exit needs one answer. HOW the column is
-- populated is 0067's contract: each movement that observes itself creating the
-- account records the claim on its OWN row, and this column is a projection of
-- the newest such claim that has not failed. See 0067's header for why the claim
-- lives on the movement (a claim must not outlive a transaction that never
-- landed) and for the write discipline.
--
-- Authoritative only while the account EXISTS, which is the only window anything
-- reads it. A value left from an already-refunded entry is unreachable, because
-- a position with no share account has no shares to exit.
--
-- KNOWN RESIDUAL: creation is observed before broadcast, so the observation can
-- be wrong in BOTH directions. Someone else creating the account first records a
-- funder that paid nothing; the account being CLOSED first makes an idempotent
-- create fire for real and records nobody. Concurrency does not rule this out:
-- the fee mode is per process, so a rolling deploy has both answers live.
-- Confirming the funder from the landed transaction at settlement is the real
-- fix and is not attempted here. What 0067's projection does close is the
-- adjacent, larger hole of a claim outliving a transaction that never landed.

ALTER TABLE earn_positions
    ADD COLUMN IF NOT EXISTS share_ata_rent_funder TEXT;

COMMENT ON COLUMN earn_positions.share_ata_rent_funder IS
    'Address that funded this position''s share-ATA rent, refunded when the exit closes that account. NULL means the custody wallet funded it.';
