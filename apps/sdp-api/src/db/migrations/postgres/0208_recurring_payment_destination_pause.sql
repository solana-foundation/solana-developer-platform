-- Widen the reason check before the new collector can pause an archived
-- recipient. Existing writers and rows remain valid. NOT VALID avoids scanning
-- the live table while its previous revision still serves traffic.
ALTER TABLE payment_recurring_payments
    DROP CONSTRAINT payment_recurring_payments_paused_reason_check,
    ADD CONSTRAINT payment_recurring_payments_paused_reason_check
        CHECK (paused_reason IN (
            'custody_policy_refused', 'failed_attempts', 'destination_unavailable'
        )) NOT VALID;
