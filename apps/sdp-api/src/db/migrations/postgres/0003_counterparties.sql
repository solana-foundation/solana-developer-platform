-- Counterparties: provider-agnostic identity records for payments / ramps flows.
-- Each counterparty is scoped to (organization_id, project_id).
-- The `identity` column is JSONB so adding provider-specific fields later does
-- not require a migration. Field-level validation runs at the application
-- layer via Zod; the database only guarantees the column is a JSON object.

CREATE TABLE IF NOT EXISTS counterparties (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    external_id TEXT,
    entity_type TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL,
    identity JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT counterparties_identity_is_object CHECK (jsonb_typeof(identity) = 'object')
);

-- Default list: scoped to (org, project), newest first.
CREATE INDEX IF NOT EXISTS idx_counterparties_org_project_created
    ON counterparties(organization_id, project_id, created_at DESC)
    WHERE is_active;

-- External-id idempotency: unique per (org, project), null-tolerant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparties_org_project_external_id
    ON counterparties(organization_id, project_id, external_id)
    WHERE external_id IS NOT NULL AND is_active;
