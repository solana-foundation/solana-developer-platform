-- sdp:migration-mode: non-transactional
-- Serve the transfers list (organization and project, newest first) from one
-- ordered index range. Row-level security makes PostgreSQL estimate a tenant's
-- rows near one, so without an index covering both equalities and the sort a
-- cached generic plan bitmap-scans and sorts every transfer of a large tenant
-- before the LIMIT. The same range answers the list's COUNT(*) as an
-- index-only scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_transfers_org_project_created_id
  ON payment_transfers (organization_id, project_id, created_at DESC, id DESC);
