CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_org_environment_active
  ON projects (organization_id, environment)
  WHERE status = 'active';
