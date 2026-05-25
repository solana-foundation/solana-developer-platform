ALTER TABLE counterparties ALTER COLUMN project_id DROP NOT NULL;

DROP INDEX IF EXISTS idx_counterparties_org_project_external_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparties_org_external_id
    ON counterparties(organization_id, external_id)
    WHERE external_id IS NOT NULL AND is_active;
