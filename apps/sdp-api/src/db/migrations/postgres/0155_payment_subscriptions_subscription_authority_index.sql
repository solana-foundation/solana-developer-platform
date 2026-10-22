-- sdp:migration-mode: non-transactional
-- The revoke-subscription-authorities cron (0153, HOO-2210) finds every subscription on an
-- authority by its address, once per candidate. Built CONCURRENTLY because payment_subscriptions
-- is live.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_subscriptions_subscription_authority
    ON payment_subscriptions (subscription_authority_address)
    WHERE subscription_authority_address IS NOT NULL;
