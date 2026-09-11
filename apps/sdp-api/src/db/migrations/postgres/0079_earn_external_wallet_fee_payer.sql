-- Solana Earn: external-wallet builds learn a caller-provided fee payer
-- (the "implementor pays" half of PRO-1722's B2B2C surface).
--
-- ── What the two columns record ────────────────────────────────────────────
-- `fee_payer` is the partner wallet the BUILD compiled into the fee-payer seat
-- (slot zero, one extra required signature), or NULL when the owner pays. It
-- is a build-time commitment: the submit proves message equality against the
-- stored unsigned bytes, and the fee payer lives inside the message, so the
-- value here can never be swapped at submit — it exists so the submit can name
-- the right slot in its errors and so operators can attribute fee spend.
--
-- `share_ata_rent_funder` carries 0066's rent-attribution rule onto the build:
-- when the plan creates the owner's share token account AND a fee payer was
-- named, the provider build embedded that address as the rent payer, and the
-- submit copies this value onto the movement row (whose own column 0067
-- added). NULL keeps the historical meaning — the owner funded its own rent —
-- so the exit's refund defaults back to the owner. Stored rather than
-- re-derived for exactly 0066's reason: the refund happens at EXIT, possibly
-- months later, and must follow who actually paid, never who is configured
-- that day.
--
-- Both are nullable with no backfill: every existing row predates the feature
-- and was owner-paid, which NULL already says.

ALTER TABLE earn_external_wallet_transactions
  ADD COLUMN fee_payer text NULL,
  ADD COLUMN share_ata_rent_funder text NULL;

-- The funder can only ever be the named fee payer (the one-identity rule:
-- partner pays fee and rent alike, or the owner pays both), and only a build
-- that creates the account has rent to attribute. Same shape discipline as
-- 0067's movement-side CHECK.
ALTER TABLE earn_external_wallet_transactions
  ADD CONSTRAINT earn_external_wallet_transactions_rent_funder_shape_check
    CHECK (
      share_ata_rent_funder IS NULL
      OR (creates_share_account AND share_ata_rent_funder = fee_payer)
    );

-- Same length rule the table already applies to owner_address (0070).
ALTER TABLE earn_external_wallet_transactions
  ADD CONSTRAINT earn_external_wallet_transactions_fee_payer_format_check
    CHECK (fee_payer IS NULL OR LENGTH(fee_payer) BETWEEN 32 AND 44);
