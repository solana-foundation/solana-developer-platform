-- Token movement legs (ADR 0012): what each movement SDP builds moves, in
-- base units, one row per (movement, destination).
--
-- A leg belongs to exactly one owning row:
--   payment_transfer_id            a single transfer or a funded off-ramp
--                                  deposit, whose own row carries the signature;
--   payment_transfer_recipient_id  one recipient of a batch. Its chunk's
--                                  transfer row carries the signature, and the
--                                  recipient row keeps each destination of a
--                                  chunk attributable.
-- The composite keys tie each leg to its owner's organization and project.
--
-- The quote is the ledger: debit = credit + fee, where the fee is the mint's
-- transfer fee withheld in the destination (never the network fee, which is
-- payment_transfers.fee). `fee_epoch` is the epoch whose fee entry priced it;
-- `as_of_*` is the Clock read with the mint; `display_rule` is the mint's
-- scaled or interest rule, from which the API derives the display values.
-- The observed amounts stay NULL until a movement is checked against the
-- chain; a movement SDP built and signed is verified by construction once it
-- lands.
--
-- A leg is immutable once its movement has a saved signature: before that a
-- rerun may replace the quote (an off-ramp deposit claimed again after a
-- release). The repository's upsert refuses it in its predicate, and the
-- trigger below refuses it for any writer.
--
-- Legacy = no leg: rows written before quotes keep their entered amount and
-- have no leg. There is no backfill (pre-launch).
CREATE TABLE token_movement_legs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    payment_transfer_id TEXT,
    payment_transfer_recipient_id TEXT,
    asset_kind TEXT NOT NULL CHECK (asset_kind IN ('native', 'token')),
    mint TEXT,
    token_program TEXT CHECK (token_program IN ('spl-token', 'token-2022')),
    decimals SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 255),
    basis TEXT NOT NULL CHECK (basis IN ('debit', 'credit')),
    quoted_debit sdp_u64 NOT NULL,
    quoted_fee sdp_u64 NOT NULL,
    quoted_credit sdp_u64 NOT NULL,
    fee_epoch sdp_u64,
    as_of_slot sdp_u64,
    as_of_unix_timestamp BIGINT,
    display_rule JSONB,
    observed_debit sdp_u64,
    observed_fee sdp_u64,
    observed_credit sdp_u64,
    verification_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (verification_state IN ('pending', 'verified', 'mismatch', 'not_required')),
    verification_reason TEXT
        CHECK (verification_reason IN ('sdp_built_transfer_landed', 'movement_not_executed')),
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (payment_transfer_id, organization_id, project_id)
        REFERENCES payment_transfers(id, organization_id, project_id)
        ON DELETE CASCADE,
    FOREIGN KEY (payment_transfer_recipient_id, organization_id, project_id)
        REFERENCES payment_transfer_recipients(id, organization_id, project_id)
        ON DELETE CASCADE,
    CONSTRAINT token_movement_legs_one_owner
        CHECK (num_nonnulls(payment_transfer_id, payment_transfer_recipient_id) = 1),
    CONSTRAINT token_movement_legs_asset CHECK (
        (asset_kind = 'native') = (mint IS NULL)
        AND (mint IS NULL) = (token_program IS NULL)
    ),
    -- Native SOL has fixed terms: 9 decimals, no fee, no display rule, nothing read.
    CONSTRAINT token_movement_legs_native_terms CHECK (
        asset_kind <> 'native'
        OR (decimals = 9 AND quoted_fee = 0 AND fee_epoch IS NULL AND display_rule IS NULL)
    ),
    CONSTRAINT token_movement_legs_terms_read CHECK (
        (as_of_slot IS NULL) = (as_of_unix_timestamp IS NULL)
        AND (asset_kind = 'native') = (as_of_slot IS NULL)
    ),
    CONSTRAINT token_movement_legs_quote_splits CHECK (quoted_debit = quoted_credit + quoted_fee),
    CONSTRAINT token_movement_legs_quote_credits CHECK (quoted_credit > 0),
    CONSTRAINT token_movement_legs_display_rule_object
        CHECK (display_rule IS NULL OR jsonb_typeof(display_rule) = 'object'),
    CONSTRAINT token_movement_legs_observed CHECK (
        num_nulls(observed_debit, observed_fee, observed_credit) IN (0, 3)
        AND (observed_debit IS NULL OR observed_debit = observed_credit + observed_fee)
    ),
    -- Every state a verdict writes says why; a pending leg has no verdict yet.
    CONSTRAINT token_movement_legs_verification_reason
        CHECK ((verification_state = 'pending') = (verification_reason IS NULL))
);

CREATE UNIQUE INDEX token_movement_legs_payment_transfer
    ON token_movement_legs (payment_transfer_id)
    WHERE payment_transfer_id IS NOT NULL;

CREATE UNIQUE INDEX token_movement_legs_payment_transfer_recipient
    ON token_movement_legs (payment_transfer_recipient_id)
    WHERE payment_transfer_recipient_id IS NOT NULL;

ALTER TABLE token_movement_legs ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_movement_legs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON token_movement_legs;
CREATE POLICY sdp_tenant_isolation ON token_movement_legs
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));

-- The movement's signature seals the quote: the owning transfer's own, or the
-- one its recipient's chunk transfer carries. Verification and observed
-- amounts stay writable.
CREATE OR REPLACE FUNCTION sdp_reject_sealed_token_movement_leg()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM payment_transfers movement
         WHERE movement.signature IS NOT NULL
           AND movement.id = COALESCE(
                 OLD.payment_transfer_id,
                 (SELECT recipient.transfer_id
                    FROM payment_transfer_recipients recipient
                   WHERE recipient.id = OLD.payment_transfer_recipient_id)
               )
    ) THEN
        RAISE EXCEPTION 'token movement leg % is sealed: its movement has a saved signature', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER token_movement_legs_quote_sealed
    BEFORE UPDATE ON token_movement_legs
    FOR EACH ROW
    WHEN (
        (OLD.organization_id, OLD.project_id, OLD.payment_transfer_id,
         OLD.payment_transfer_recipient_id, OLD.asset_kind, OLD.mint, OLD.token_program,
         OLD.decimals, OLD.basis, OLD.quoted_debit, OLD.quoted_fee, OLD.quoted_credit,
         OLD.fee_epoch, OLD.as_of_slot, OLD.as_of_unix_timestamp, OLD.display_rule)
        IS DISTINCT FROM
        (NEW.organization_id, NEW.project_id, NEW.payment_transfer_id,
         NEW.payment_transfer_recipient_id, NEW.asset_kind, NEW.mint, NEW.token_program,
         NEW.decimals, NEW.basis, NEW.quoted_debit, NEW.quoted_fee, NEW.quoted_credit,
         NEW.fee_epoch, NEW.as_of_slot, NEW.as_of_unix_timestamp, NEW.display_rule)
    )
    EXECUTE FUNCTION sdp_reject_sealed_token_movement_leg();
