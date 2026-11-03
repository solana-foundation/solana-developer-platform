-- sdp:migration-mode: non-transactional
-- Target for composite (recurring_payment_id, organization_id, project_id) foreign keys from the
-- activation, lifecycle and update attempt tables, so an attempt cannot point at another project's
-- recurring payment (HOO-2464). Unique because it contains the primary key. Built CONCURRENTLY
-- because the table is live.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_recurring_payments_id_org_project
    ON payment_recurring_payments (id, organization_id, project_id);
