-- Chain-verification evidence for ramp transfers (#559).
--
-- A ramp transfer reaches `completed` on a provider's word. Nothing today records
-- whether the money was ever verified on chain, and the two places that hold chain
-- evidence are provider-shaped: provider_data.moneygram.solanaTxSignature and
-- provider_data.settlement.txHash. A caller comparing providers at runtime cannot
-- read either without special-casing per provider.
--
-- These columns give that evidence one provider-neutral home.
--
-- settlement_signature is deliberately NOT globally unique. For an off-ramp the
-- crypto leg is its own wallet-transfer row and already holds the signature in
-- `signature`, which IS unique; copying it here would collide. The uniqueness that
-- matters is narrower and is enforced at the end of this migration.

ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS settlement_signature TEXT;
ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS settlement_verified_slot INTEGER;  -- matches payment_transfers.slot; BIGINT would arrive as a string
ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS settlement_verified_at TEXT;

-- How the settlement was established, recorded by whoever established it. `linked_crypto_leg` is a
-- transaction SDP submitted from the customer's own wallet, matched to this row by id and validated
-- field by field: settlement identity is proven. `provider_signature` is a hash the provider reported,
-- checked on chain for success, mint, wallet, direction, amount and timing, but not bound to this
-- particular order, because a hosted delivery carries nothing on chain referencing it.
--
-- Not derivable after the fact. A MoneyGram row backfilled below carries a signature but no proof, and
-- is proven later by the weaker path, so the provider does not tell you which was used.
ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS settlement_verification_method TEXT;

-- Verification lease. Stamping a polling cursor is not enough to stop two workers processing the
-- same row: the row lock releases when the claim statement commits, and the worker then spends
-- seconds in Solana RPC. A second replica would re-claim it and both would consume an attempt for
-- one real polling opportunity, exhausting the allowance and reporting a valid settlement as
-- unverified. The lease excludes a row until it expires; the token ties the eventual write back to
-- the worker that claimed it, so a stale worker finishing late cannot overwrite a newer claim.
ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS verification_claim_token TEXT;
ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS verification_claimed_until TEXT;

-- Backfill the evidence MoneyGram already proved but never surfaced. These rows were
-- verified with requireConfirmed at completion time, so the signature is trustworthy;
-- the slot and timestamp were not recorded then and stay NULL rather than being
-- invented from updated_at, which moves for unrelated reasons.
--
-- Runs BEFORE the unique index below so that a pre-existing duplicate fails at the
-- guard, naming the real problem, rather than partway through the backfill.
UPDATE payment_transfers
   SET settlement_signature = provider_data->'moneygram'->>'solanaTxSignature'
 WHERE type = 'offramp'
   AND provider = 'moneygram'
   AND settlement_signature IS NULL
   AND provider_data->'moneygram'->>'solanaTxSignature' IS NOT NULL;

-- Replay guard. Without this one real settlement could be claimed by many ramp rows,
-- marking all of them verified. Scoped to ramp rows so it cannot conflict with the
-- linked crypto leg described above, which lives in a different column on a
-- different row type.
--
-- If this fails, two ramp transfers already claim the same on-chain settlement. That
-- is a data-integrity finding worth stopping the deploy for, not something to skip.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_transfers_settlement_signature_ramp
    ON payment_transfers (settlement_signature)
 WHERE settlement_signature IS NOT NULL
   AND type IN ('onramp', 'offramp');
