-- Recurring mandates in base units (ADR 0012).
--
-- A recurring payment, and the subscription plan its pulls run under, store
-- the mandate once, when it is made: the asset, the decimals its terms had,
-- what each pull debits, and the fee tolerance, the largest transfer fee one
-- pull may pay (the effective fee for that debit when the mandate was made).
-- The subscriptions program pulls with a plain `TransferChecked` and its plan
-- cap counts the debit, so mandates are debit-only. Before each pull SDP reads
-- the token's terms again and holds the pull when the fee is above the
-- tolerance. Every build and verification uses these base units, never the
-- amount text parsed again.
--
-- A row written before this migration, or by the previous revision while it
-- still serves, has no mandate: its amount is parsed at the decimals the pull
-- reads, as before, and its tolerance is the fee of that read.
--
-- The CHECKs are added NOT VALID: rows written before them are not scanned,
-- and every new or updated row is checked.

ALTER TABLE payment_recurring_payments
    ADD COLUMN IF NOT EXISTS asset_kind TEXT,
    ADD COLUMN IF NOT EXISTS mint TEXT,
    ADD COLUMN IF NOT EXISTS token_program TEXT,
    ADD COLUMN IF NOT EXISTS decimals SMALLINT,
    ADD COLUMN IF NOT EXISTS mandate_debit sdp_u64,
    ADD COLUMN IF NOT EXISTS max_fee_per_pull sdp_u64;

-- All of the mandate or none of it. Recurring moves SPL tokens only; the
-- mandate's mint is the row's token, and `amount` is its debit in token units.
-- A tolerance never takes the whole debit.
ALTER TABLE payment_recurring_payments
    ADD CONSTRAINT payment_recurring_payments_mandate_shape CHECK (
        num_nulls(asset_kind, mint, token_program, decimals, mandate_debit, max_fee_per_pull)
            IN (0, 6)
        AND (asset_kind IS NULL OR asset_kind = 'token')
        AND (token_program IS NULL OR token_program IN ('spl-token', 'token-2022'))
        AND (mint IS NULL OR mint = token)
        AND (decimals IS NULL OR decimals BETWEEN 0 AND 255)
        AND (mandate_debit IS NULL OR mandate_debit > 0)
        AND (max_fee_per_pull IS NULL OR max_fee_per_pull < mandate_debit)
        AND CASE
            WHEN mandate_debit IS NULL THEN TRUE
            ELSE amount::numeric * power(10::numeric, decimals) = mandate_debit
        END
    ) NOT VALID;

ALTER TABLE payment_subscription_plans
    ADD COLUMN IF NOT EXISTS asset_kind TEXT,
    ADD COLUMN IF NOT EXISTS mint TEXT,
    ADD COLUMN IF NOT EXISTS token_program TEXT,
    ADD COLUMN IF NOT EXISTS decimals SMALLINT,
    ADD COLUMN IF NOT EXISTS mandate_debit sdp_u64,
    ADD COLUMN IF NOT EXISTS max_fee_per_pull sdp_u64;

ALTER TABLE payment_subscription_plans
    ADD CONSTRAINT payment_subscription_plans_mandate_shape CHECK (
        num_nulls(asset_kind, mint, token_program, decimals, mandate_debit, max_fee_per_pull)
            IN (0, 6)
        AND (asset_kind IS NULL OR asset_kind = 'token')
        AND (token_program IS NULL OR token_program IN ('spl-token', 'token-2022'))
        AND (mint IS NULL OR mint = token)
        AND (decimals IS NULL OR decimals BETWEEN 0 AND 255)
        AND (mandate_debit IS NULL OR mandate_debit > 0)
        AND (max_fee_per_pull IS NULL OR max_fee_per_pull < mandate_debit)
        AND CASE
            WHEN mandate_debit IS NULL THEN TRUE
            ELSE amount::numeric * power(10::numeric, decimals) = mandate_debit
        END
    ) NOT VALID;
