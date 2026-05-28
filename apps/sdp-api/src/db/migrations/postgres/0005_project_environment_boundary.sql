-- 0005_project_environment_boundary.sql
--
-- Establishes sandbox/production as a project-level boundary instead of an
-- api_keys column.
--
-- Steps:
--   1. Rename slug "default-project" → "default-sandbox" for existing sandbox projects
--   2. Ensure every org has a default-sandbox project
--   3. Ensure every org has a default-production project
--   4. Ensure all active org members are members of both default projects
--   5. Backfill api_keys.project_id from api_keys.environment where still NULL
--   6. Make api_keys.project_id NOT NULL and tighten FK to ON DELETE RESTRICT
--   7. Drop api_keys.environment
--   8. Add CHECK constraint on projects.environment narrowing it to sandbox|production
--   9. Backfill remaining org-scoped resources (custody_configs, custody_scope_defaults,
--      payment_transfers, counterparties) onto each org's default-sandbox project


-- ─── 1. Rename default-project → default-sandbox ─────────────────────────────
UPDATE projects
SET    slug       = 'default-sandbox',
       name       = 'Default Sandbox Project',
       updated_at = sdp_datetime_now()
WHERE  slug        = 'default-project'
  AND  environment = 'sandbox';

UPDATE projects
SET    name       = 'Default Sandbox Project',
       updated_at = sdp_datetime_now()
WHERE  slug = 'default-sandbox'
  AND  name <> 'Default Sandbox Project';

UPDATE projects
SET    name       = 'Default Production Project',
       updated_at = sdp_datetime_now()
WHERE  slug = 'default-production'
  AND  name <> 'Default Production Project';


-- ─── 2. Create default-sandbox for orgs that have no sandbox project ──────────
INSERT INTO projects (
    id, organization_id, name, slug, description,
    environment, settings, status, created_by, created_at, updated_at
)
SELECT
    'prj_' || gen_random_uuid(),
    o.id,
    'Default Sandbox Project',
    'default-sandbox',
    'Default sandbox project',
    'sandbox',
    NULL,
    'active',
    first_member.user_id,
    sdp_datetime_now(),
    sdp_datetime_now()
FROM   organizations o
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
      AND  p.environment     = 'sandbox'
)
ON CONFLICT (organization_id, slug) DO NOTHING;


-- ─── 3. Create default-production for orgs that have no production project ────
INSERT INTO projects (
    id, organization_id, name, slug, description,
    environment, settings, status, created_by, created_at, updated_at
)
SELECT
    'prj_' || gen_random_uuid(),
    o.id,
    'Default Production Project',
    'default-production',
    'Default production project',
    'production',
    NULL,
    'active',
    first_member.user_id,
    sdp_datetime_now(),
    sdp_datetime_now()
FROM   organizations o
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
      AND  p.environment     = 'production'
)
ON CONFLICT (organization_id, slug) DO NOTHING;


-- ─── 4. Ensure all active org members belong to both default projects ─────────
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


-- ─── 5. Backfill api_keys.project_id from api_keys.environment ───────────────
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   information_schema.columns
        WHERE  table_name  = 'api_keys'
          AND  column_name = 'environment'
    ) THEN
        UPDATE api_keys ak
        SET    project_id = (
            SELECT p.id
            FROM   projects p
            WHERE  p.organization_id = ak.organization_id
              AND  p.environment     = ak.environment
            ORDER  BY
                CASE
                    WHEN p.slug = 'default-sandbox'    AND p.environment = 'sandbox'    THEN 0
                    WHEN p.slug = 'default-production' AND p.environment = 'production' THEN 0
                    ELSE 1
                END,
                p.created_at ASC
            LIMIT  1
        )
        WHERE  ak.project_id IS NULL;
    END IF;
END $$;


-- ─── 6. Make project_id NOT NULL; tighten FK to ON DELETE RESTRICT ───────────
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_project_id_fkey;
ALTER TABLE api_keys ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;


-- ─── 7. Drop api_keys.environment ────────────────────────────────────────────
ALTER TABLE api_keys DROP COLUMN IF EXISTS environment;


-- ─── 8. Narrow projects.environment to sandbox | production ──────────────────
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_environment_check;
ALTER TABLE projects ADD CONSTRAINT projects_environment_check
    CHECK (environment IN ('sandbox', 'production'));


-- ─── 9. Backfill remaining org-scoped resources to default-sandbox ───────────
UPDATE custody_configs cc
SET    project_id = (
    SELECT p.id FROM projects p
    WHERE  p.organization_id = cc.organization_id
      AND  p.slug = 'default-sandbox'
)
WHERE  cc.project_id IS NULL;

UPDATE custody_scope_defaults csd
SET    project_id = (
    SELECT p.id FROM projects p
    WHERE  p.organization_id = csd.organization_id
      AND  p.slug = 'default-sandbox'
)
WHERE  csd.project_id IS NULL;

UPDATE payment_transfers pt
SET    project_id = (
    SELECT p.id FROM projects p
    WHERE  p.organization_id = pt.organization_id
      AND  p.slug = 'default-sandbox'
)
WHERE  pt.project_id IS NULL;

UPDATE counterparties c
SET    project_id = (
    SELECT p.id FROM projects p
    WHERE  p.organization_id = c.organization_id
      AND  p.slug = 'default-sandbox'
)
WHERE  c.project_id IS NULL;
