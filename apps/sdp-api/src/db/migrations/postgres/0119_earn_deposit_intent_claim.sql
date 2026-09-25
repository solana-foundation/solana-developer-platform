-- Solana Earn: a server-backed claim for the unchanged vault-deposit intent.
--
-- The caller's Idempotency-Key is client-minted per browser tab (the dashboard
-- keys live in per-tab sessionStorage), so the same unchanged deposit intent
-- can arrive under two different keys. The (organization_id, request_id)
-- replay anchor cannot see them — every fresh key looks new — and without a
-- claim keyed on the intent itself, a second sign/record/broadcast path
-- started for money that was already moving (SOLA9-496). Each custody vault
-- deposit therefore stamps the intent it claims: organization, project,
-- environment, provider, vault, custody wallet, resolved asset identity,
-- amount, and swap source. A different key submitting that unchanged intent while the prior movement is
-- still non-terminal is answered with the movement that already counts.
--
-- Deliberately NOT part of the fingerprint: minSharesOut. The floor is derived
-- from a live quote and moves with the rate — the client's own intent
-- fingerprint carries the user's tolerance instead, for the same reason — so
-- keying the claim on the floor would re-open the two-tab hole whenever two
-- tabs quoted at different moments. The caller-supplied swapSlippageBps IS
-- part of the intent for swap-funded deposits (a chosen economic term, not a
-- quote derivation): a caller who tightens it must get a fresh swap built, not
-- a replay of the earlier, looser one. The funding mint is included because it
-- changes what leaves the wallet. Swap-funded fingerprints recorded before the
-- tolerance joined the formula are transient — reconciliation drives them
-- terminal within one blockhash window — so the formula change cannot strand a
-- live claim.
--
-- Historical rows keep NULL. The ledger cannot re-derive the caller's funding
-- amount for swap-funded rows (their amount_requested is the quote-derived
-- deposit floor, not the source amount), so a SQL backfill would mint keys the
-- service will never match. Rows already in flight at deploy time were driven
-- terminal by the reconciliation sweep within one blockhash window, which is
-- the ambiguity window this claim exists to close.

ALTER TABLE earn_movements
    ADD COLUMN IF NOT EXISTS deposit_intent_fingerprint TEXT;

COMMENT ON COLUMN earn_movements.deposit_intent_fingerprint IS
    'Stable identity of the logical custody deposit intent (organization, project, environment, provider, vault, custody wallet, resolved asset identity, amount, swap source, swap tolerance), excluding the quote-derived minSharesOut floor. Backs the cross-key claim: a different idempotency key submitting the same unchanged intent is answered with the still-open movement instead of starting a second sign/record/broadcast path.';

CREATE INDEX IF NOT EXISTS idx_earn_movements_deposit_intent_claim
    ON earn_movements (organization_id, deposit_intent_fingerprint)
    WHERE direction = 'deposit'
      AND execution_model = 'vault_direct'
      AND custody_wallet_id IS NOT NULL
      AND deposit_intent_fingerprint IS NOT NULL;
