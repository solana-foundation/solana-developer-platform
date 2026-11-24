-- One dashboard serves devnet and mainnet again (PRO-2579). An organization admitted while this
-- deployment was mainnet-only got its default production project alone (activateOrganization
-- skips an environment the deployment refuses), so give every organization that still has a
-- member its default sandbox project, and every active member a seat in it, as admission does
-- on a deployment that serves both. Additions only: an organization that already has a
-- default-sandbox row or an active sandbox project is left as it is. On a deployment that still
-- refuses sandbox projects the new rows stay hidden and refused, like the pre-cutover ones.
INSERT INTO projects (
    id, organization_id, name, slug, description, environment, status, created_by
)
SELECT
    'prj_' || gen_random_uuid(),
    o.id,
    'Default Sandbox Project',
    'default-sandbox',
    'Default sandbox project',
    'sandbox',
    'active',
    first_member.user_id
FROM   organizations o
JOIN LATERAL (
    SELECT user_id
    FROM   organization_members
    WHERE  organization_id = o.id
      AND  status          = 'active'
    ORDER  BY created_at ASC
    LIMIT  1
) first_member ON true
WHERE  o.status IN ('active', 'suspended')
  AND  NOT EXISTS (
    SELECT 1
    FROM   projects p
    WHERE  p.organization_id = o.id
      AND  (p.slug = 'default-sandbox' OR (p.environment = 'sandbox' AND p.status = 'active'))
)
ON CONFLICT (organization_id, slug) DO NOTHING;

-- Every active member belongs to every active project of their organization.
INSERT INTO project_members (id, project_id, user_id)
SELECT
    'pm_' || gen_random_uuid(),
    p.id,
    om.user_id
FROM   projects             p
JOIN   organization_members om
       ON  om.organization_id = p.organization_id
       AND om.status          = 'active'
WHERE  p.slug   = 'default-sandbox'
  AND  p.status = 'active'
ON CONFLICT (project_id, user_id) DO NOTHING;
