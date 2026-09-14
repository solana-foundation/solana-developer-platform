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

-- Every organization with an active member gets both defaults; an organization
-- with none is provisioned on its first authenticated request, as today.
INSERT INTO projects (
    id, organization_id, name, slug, description,
    environment, settings, status, created_by, created_at, updated_at
)
SELECT
    'prj_' || gen_random_uuid(),
    o.id,
    d.name,
    d.slug,
    d.description,
    d.environment,
    NULL,
    'active',
    first_member.user_id,
    sdp_datetime_now(),
    sdp_datetime_now()
FROM   organizations o
CROSS JOIN (VALUES
    ('Default Sandbox Project',    'default-sandbox',    'Default sandbox project',    'sandbox'),
    ('Default Production Project', 'default-production', 'Default production project', 'production')
) AS d(name, slug, description, environment)
JOIN LATERAL (
    SELECT user_id
    FROM   organization_members
    WHERE  organization_id = o.id
      AND  status          = 'active'
    ORDER  BY created_at ASC
    LIMIT  1
) first_member ON true
WHERE NOT EXISTS (
    SELECT 1
    FROM   projects p
    WHERE  p.organization_id = o.id
      AND  p.slug            = d.slug
)
ON CONFLICT (organization_id, slug) DO NOTHING;

-- Every active organization member belongs to both default projects.
INSERT INTO project_members (id, project_id, user_id, role, created_at)
SELECT
    'pm_' || gen_random_uuid(),
    p.id,
    om.user_id,
    'admin',
    sdp_datetime_now()
FROM   projects             p
JOIN   organization_members om
       ON  om.organization_id = p.organization_id
       AND om.status          = 'active'
WHERE  p.slug IN ('default-sandbox', 'default-production')
ON CONFLICT (project_id, user_id) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_org_environment_active
  ON projects (organization_id, environment)
  WHERE status = 'active';
