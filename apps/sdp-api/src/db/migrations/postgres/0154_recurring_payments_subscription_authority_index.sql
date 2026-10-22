-- sdp:migration-mode: non-transactional
-- The revoke-subscription-authorities cron (0153, HOO-2210) finds every recurring payment on an
-- authority by its address. Built CONCURRENTLY because payment_recurring_payments is live.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_recurring_payments_subscription_authority
    ON payment_recurring_payments (subscription_authority_address)
    WHERE subscription_authority_address IS NOT NULL;
