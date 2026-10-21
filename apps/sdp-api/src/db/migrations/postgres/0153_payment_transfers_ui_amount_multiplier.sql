-- The Token-2022 scaled UI amount multiplier a transfer was signed under.
--
-- A scaled mint's holders see trunc(base units x multiplier), and the signed
-- transaction carries only the base units. The multiplier in effect at signing
-- is saved beside them, so a transfer's fee and received amount read back in
-- the UI units its recipient saw, even after the issuer changes the multiplier.
-- NULL for any mint without a scaled UI amount.
--
-- DOUBLE PRECISION holds the mint's on-chain f64 exactly. The CHECK refuses
-- zero, negatives, infinity and NaN (which PostgreSQL orders above every other
-- value), matching what the program accepts.

ALTER TABLE payment_transfers
    ADD COLUMN IF NOT EXISTS ui_amount_multiplier DOUBLE PRECISION
        CONSTRAINT payment_transfers_ui_amount_multiplier_positive
        CHECK (ui_amount_multiplier > 0 AND ui_amount_multiplier < 'Infinity'::DOUBLE PRECISION);
