ALTER TABLE counterparties ALTER COLUMN project_id DROP NOT NULL;

DROP INDEX IF EXISTS idx_counterparties_org_project_created;
CREATE INDEX IF NOT EXISTS idx_counterparties_org_created
    ON counterparties(organization_id, created_at DESC)
    WHERE is_active;

DROP INDEX IF EXISTS idx_counterparties_org_project_external_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparties_org_external_id
    ON counterparties(organization_id, external_id)
    WHERE external_id IS NOT NULL AND is_active;
