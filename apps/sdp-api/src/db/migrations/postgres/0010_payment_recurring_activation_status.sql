-- Branch-compatibility migration:
-- Some upgraded databases may have created payment_recurring_payments before
-- the activating and lifecycle claim statuses were added to the 0009
-- constraint. Fresh databases already get this constraint from 0009, so this
-- migration intentionally re-applies it idempotently for upgraded branches.
ALTER TABLE payment_recurring_payments
    DROP CONSTRAINT IF EXISTS payment_recurring_payments_status_check;

ALTER TABLE payment_recurring_payments
    ADD CONSTRAINT payment_recurring_payments_status_check
    CHECK (status IN ('pending_activation', 'activating', 'active', 'canceling', 'resuming', 'paused', 'canceled', 'expired'));
