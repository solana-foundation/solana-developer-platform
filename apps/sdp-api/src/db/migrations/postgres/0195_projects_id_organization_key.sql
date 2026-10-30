-- sdp:migration-mode: non-transactional
-- Target for composite (project_id, organization_id) foreign keys, so a child row's organization
-- must be its project's organization (HOO-2437). Unique because it contains the primary key.
-- Built CONCURRENTLY because projects is live.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_id_organization_id
    ON projects (id, organization_id);
