ALTER TABLE counterparties ALTER COLUMN project_id DROP NOT NULL;

ALTER TABLE counterparties ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
UPDATE counterparties SET status = CASE WHEN is_active THEN 'active' ELSE 'archived' END;
ALTER TABLE counterparties DROP COLUMN IF EXISTS is_active;

DROP INDEX IF EXISTS idx_counterparties_org_project_created;
CREATE INDEX IF NOT EXISTS idx_counterparties_org_status_created
    ON counterparties(organization_id, status, created_at DESC);

DROP INDEX IF EXISTS idx_counterparties_org_project_external_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparties_org_external_id
    ON counterparties(organization_id, external_id)
    WHERE external_id IS NOT NULL AND status = 'active';
