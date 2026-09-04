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

-- Pre-flight: a cross-representation duplicate (one active row claiming a
-- reference in the denormalized column while another claims the same value
-- only in JSON) was representable before this migration, and both rows are
-- live lookup candidates — the webhook lookups already fail closed on the
-- ambiguity today. Which row legitimately owns the provider relationship is
-- not decidable mechanically, so the migration deliberately stops with the
-- conflicting ids instead of silently reassigning a payment-provider
-- relationship; resolve ownership (archive or clear the stale copy) via the
-- runbook in docs/ops/tenant-isolation.md and re-run.
DO $$
DECLARE
  bvnk_conflicts TEXT;
  mural_conflicts TEXT;
BEGIN
  SELECT string_agg(format('%s -> [%s]', effective_reference, ids), '; ')
  INTO bvnk_conflicts
  FROM (
    SELECT
      COALESCE(bvnk_customer_reference, provider_data->'bvnk'->'customer'->>'customerReference')
        AS effective_reference,
      string_agg(id, ', ' ORDER BY id) AS ids
    FROM counterparties
    WHERE status = 'active'
      AND COALESCE(bvnk_customer_reference, provider_data->'bvnk'->'customer'->>'customerReference')
        IS NOT NULL
    GROUP BY 1
    HAVING count(*) > 1
  ) duplicates;

  SELECT string_agg(format('%s -> [%s]', effective_reference, ids), '; ')
  INTO mural_conflicts
  FROM (
    SELECT
      COALESCE(mural_organization_id, provider_data->'mural'->'organization'->>'id')
        AS effective_reference,
      string_agg(id, ', ' ORDER BY id) AS ids
    FROM counterparties
    WHERE status = 'active'
      AND COALESCE(mural_organization_id, provider_data->'mural'->'organization'->>'id')
        IS NOT NULL
    GROUP BY 1
    HAVING count(*) > 1
  ) duplicates;

  IF bvnk_conflicts IS NOT NULL OR mural_conflicts IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'Duplicate active counterparty provider references must be resolved before this migration can enforce uniqueness. bvnk: %s | mural: %s. See docs/ops/tenant-isolation.md.',
        COALESCE(bvnk_conflicts, 'none'),
        COALESCE(mural_conflicts, 'none')
      );
  END IF;
END $$;

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
