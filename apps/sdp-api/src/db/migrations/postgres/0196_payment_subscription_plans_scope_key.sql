-- sdp:migration-mode: non-transactional
-- Target for composite (plan_id, organization_id, project_id) foreign keys from subscriptions and
-- recurring payments, so a child row cannot point at another project's plan (HOO-2462). Unique
-- because it contains the primary key. Built CONCURRENTLY because the table is live.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_subscription_plans_id_org_project
    ON payment_subscription_plans (id, organization_id, project_id);
