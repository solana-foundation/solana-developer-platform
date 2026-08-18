ALTER TABLE signing_requests
ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

UPDATE signing_requests AS request
SET project_id = config.project_id
FROM custody_configs AS config
WHERE request.custody_config_id = config.id
  AND request.project_id IS NULL
  AND config.project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_signing_requests_org_project
ON signing_requests(organization_id, project_id);
