-- Add explicit default custody configuration pointer per scope.

CREATE TABLE IF NOT EXISTS custody_scope_defaults (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT,
  default_custody_config_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (default_custody_config_id) REFERENCES custody_configs(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_custody_scope_defaults_org_project_not_null
  ON custody_scope_defaults(organization_id, project_id)
  WHERE project_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_custody_scope_defaults_org_null_project
  ON custody_scope_defaults(organization_id)
  WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_custody_scope_defaults_default_config
  ON custody_scope_defaults(default_custody_config_id);

-- Backfill defaults for project-scoped active configs.
INSERT INTO custody_scope_defaults (id, organization_id, project_id, default_custody_config_id)
SELECT
  'csd_' || lower(hex(randomblob(16))),
  selected.organization_id,
  selected.project_id,
  selected.id
FROM (
  SELECT c.id, c.organization_id, c.project_id
  FROM custody_configs c
  WHERE c.status = 'active'
    AND c.project_id IS NOT NULL
    AND c.id = (
      SELECT c2.id
      FROM custody_configs c2
      WHERE c2.organization_id = c.organization_id
        AND c2.project_id = c.project_id
        AND c2.status = 'active'
      ORDER BY c2.updated_at DESC, c2.id DESC
      LIMIT 1
    )
) selected
WHERE NOT EXISTS (
  SELECT 1
  FROM custody_scope_defaults existing
  WHERE existing.organization_id = selected.organization_id
    AND existing.project_id = selected.project_id
);

-- Backfill defaults for org-scoped active configs.
INSERT INTO custody_scope_defaults (id, organization_id, project_id, default_custody_config_id)
SELECT
  'csd_' || lower(hex(randomblob(16))),
  selected.organization_id,
  NULL,
  selected.id
FROM (
  SELECT c.id, c.organization_id
  FROM custody_configs c
  WHERE c.status = 'active'
    AND c.project_id IS NULL
    AND c.id = (
      SELECT c2.id
      FROM custody_configs c2
      WHERE c2.organization_id = c.organization_id
        AND c2.project_id IS NULL
        AND c2.status = 'active'
      ORDER BY c2.updated_at DESC, c2.id DESC
      LIMIT 1
    )
) selected
WHERE NOT EXISTS (
  SELECT 1
  FROM custody_scope_defaults existing
  WHERE existing.organization_id = selected.organization_id
    AND existing.project_id IS NULL
);
