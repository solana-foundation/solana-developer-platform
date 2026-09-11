-- PLANNED DELETION — project consolidation.
-- Every organization has exactly two projects, both active: default-sandbox
-- and default-production. There is no legacy shape. Any other row — a project
-- created through the removed POST /v1/projects, or a default archived through
-- the removed DELETE /v1/projects — is consolidated away: dropped outright,
-- and its data with it. Every foreign key to projects cascades or nulls except
-- api_keys (RESTRICT), whose rows go first and whose own dependents cascade.
-- Pre-mainnet, no production funds; anything worth keeping is moved onto the
-- default projects before this runs, never reconciled here.
DELETE FROM api_keys
 WHERE project_id IN (
   SELECT id FROM projects
    WHERE NOT (status = 'active'
               AND slug = CASE environment
                            WHEN 'sandbox' THEN 'default-sandbox'
                            ELSE 'default-production'
                          END)
 );

DELETE FROM projects
 WHERE NOT (status = 'active'
            AND slug = CASE environment
                         WHEN 'sandbox' THEN 'default-sandbox'
                         ELSE 'default-production'
                       END);

CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_org_environment_active
  ON projects (organization_id, environment)
  WHERE status = 'active';
