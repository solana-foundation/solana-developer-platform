-- sdp:migration-mode: non-transactional
-- Target for composite (subscription_id, organization_id, project_id) foreign keys from recurring
-- payments and collection attempts, so a child row cannot point at another project's subscription
-- (HOO-2463). Unique because it contains the primary key. Built CONCURRENTLY because the table is
-- live.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_subscriptions_id_org_project
    ON payment_subscriptions (id, organization_id, project_id);
