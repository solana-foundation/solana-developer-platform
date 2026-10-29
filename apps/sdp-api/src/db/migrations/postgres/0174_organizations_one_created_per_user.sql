-- sdp:migration-mode: non-transactional
-- A person creates at most one organization (HOO-2221, ADR 0012). Organization creation claims
-- the slot with its INSERT, so a concurrent second creation loses on this index before any
-- Clerk call. A deleted organization frees the slot. Built CONCURRENTLY because organizations
-- is live.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_organizations_one_created_per_user
    ON organizations (created_by_user_id)
    WHERE created_by_user_id IS NOT NULL AND status <> 'deleted';
