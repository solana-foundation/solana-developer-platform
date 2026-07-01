-- Existing databases may have applied the original recurring-payment tables
-- before lifecycle statuses were added to the historical migration text.

ALTER TABLE payment_recurring_payments
    DROP CONSTRAINT IF EXISTS payment_recurring_payments_status_check;

ALTER TABLE payment_recurring_payments
    ADD CONSTRAINT payment_recurring_payments_status_check
        CHECK (status IN (
            'pending_activation',
            'activating',
            'active',
            'canceling',
            'resuming',
            'paused',
            'canceled',
            'expired'
        ));

ALTER TABLE payment_subscriptions
    DROP CONSTRAINT IF EXISTS payment_subscriptions_status_check;

ALTER TABLE payment_subscriptions
    ADD CONSTRAINT payment_subscriptions_status_check
        CHECK (status IN (
            'pending_authorization',
            'active',
            'paused',
            'canceling',
            'canceled',
            'expired'
        ));
