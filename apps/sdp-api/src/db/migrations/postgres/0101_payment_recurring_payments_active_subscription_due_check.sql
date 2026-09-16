ALTER TABLE payment_recurring_payments
    ADD CONSTRAINT payment_recurring_payments_active_subscription_due_check
    CHECK (status <> 'active' OR (subscription_id IS NOT NULL AND next_collection_due_at IS NOT NULL));
