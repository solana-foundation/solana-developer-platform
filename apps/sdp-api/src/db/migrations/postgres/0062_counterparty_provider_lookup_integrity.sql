-- Counterparty provider lookup keys: enforce uniqueness of the *effective*
-- lookup value at the database.
--
-- The webhook lookups (findActiveCounterpartyByBvnkCustomerReference,
-- findCounterpartyByMuralOrganizationId) resolve a tenant from a
-- provider-supplied reference via
--   COALESCE(<denormalized column>, <provider_data JSON path>)
-- (column first, JSON only when the column is NULL). The historical unique
-- indexes each cover one representation in isolation:
--   * 0020/0024 — the provider_data JSON expression (stops covering rows once
--     the PII purge nulls provider_data),
--   * 0047      — the denormalized columns.
-- In the dual-write window one tenant can hold a reference in the column
-- while another holds the same value only in JSON: both indexes are satisfied
-- yet the lookup matches two rows across tenants. Indexing the COALESCE
-- expression itself makes the effective key unique, so a provider reference
-- resolves to at most one active counterparty in any migration phase.

CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparties_bvnk_customer_reference_effective_active
ON counterparties ((COALESCE(bvnk_customer_reference, provider_data->'bvnk'->'customer'->>'customerReference')))
WHERE status = 'active'
  AND COALESCE(bvnk_customer_reference, provider_data->'bvnk'->'customer'->>'customerReference') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparties_mural_organization_id_effective_active
ON counterparties ((COALESCE(mural_organization_id, provider_data->'mural'->'organization'->>'id')))
WHERE status = 'active'
  AND COALESCE(mural_organization_id, provider_data->'mural'->'organization'->>'id') IS NOT NULL;

-- The JSON-only unique indexes now conflict with the effective-key semantics:
-- once a row's denormalized column diverges from a stale JSON value, that dead
-- JSON value would still block an unrelated tenant's row. Keep the JSON
-- expression indexed for the lookup fallback branch, but not uniquely.

DROP INDEX IF EXISTS idx_counterparties_bvnk_customer_reference_active;
DROP INDEX IF EXISTS idx_counterparties_mural_organization_id_active;

CREATE INDEX IF NOT EXISTS idx_counterparties_bvnk_customer_reference_json_active
ON counterparties ((provider_data->'bvnk'->'customer'->>'customerReference'))
WHERE status = 'active'
  AND provider_data->'bvnk'->'customer'->>'customerReference' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_counterparties_mural_organization_id_json_active
ON counterparties ((provider_data->'mural'->'organization'->>'id'))
WHERE status = 'active'
  AND provider_data->'mural'->'organization'->>'id' IS NOT NULL;
