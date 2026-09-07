-- Counterparty provider lookup keys: enforce uniqueness of the *effective*
-- lookup value at the database.
--
-- The webhook lookup (findCounterpartyByMuralOrganizationId) resolves a tenant from a
-- provider-supplied reference via
--   COALESCE(<denormalized column>, <provider_data JSON path>)
-- (column first, JSON only when the column is NULL). The historical unique
-- indexes each cover one representation in isolation:
--   * 0024 — the provider_data JSON expression (stops covering rows once
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
  mural_conflicts TEXT;
BEGIN
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

  IF mural_conflicts IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'Duplicate active counterparty provider references must be resolved before this migration can enforce uniqueness. mural: %s. See docs/ops/tenant-isolation.md.',
        mural_conflicts
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparties_mural_organization_id_effective_active
ON counterparties ((COALESCE(mural_organization_id, provider_data->'mural'->'organization'->>'id')))
WHERE status = 'active'
  AND COALESCE(mural_organization_id, provider_data->'mural'->'organization'->>'id') IS NOT NULL;

-- The JSON-only unique indexes now conflict with the effective-key semantics:
-- once a row's denormalized column diverges from a stale JSON value, that dead
-- JSON value would still block an unrelated tenant's row. Keep the JSON
-- expression indexed for the lookup fallback branch, but not uniquely.

DROP INDEX IF EXISTS idx_counterparties_mural_organization_id_active;

CREATE INDEX IF NOT EXISTS idx_counterparties_mural_organization_id_json_active
ON counterparties ((provider_data->'mural'->'organization'->>'id'))
WHERE status = 'active'
  AND provider_data->'mural'->'organization'->>'id' IS NOT NULL;

-- Links whose parent counterparty is no longer active are not lookup
-- candidates (the runtime join requires the parent to be active), but the
-- historical archive flow left them 'active'. Align them first so neither the
-- pre-flight below nor the unique index can be blocked or occupied by a
-- reference the runtime would never resolve; archiveCounterparty now keeps
-- this invariant going forward.
UPDATE counterparty_provider_accounts cpa
   SET status = 'archived',
       updated_at = sdp_iso_now()
  FROM counterparties c
 WHERE c.id = cpa.counterparty_id
   AND c.status <> 'active'
   AND cpa.status = 'active';

-- BVNK (and any provider using the linked-account model) resolves a webhook's
-- tenant through counterparty_provider_accounts.provider_customer_reference.
-- The same dual-claim ambiguity applies: two active customer links claiming one
-- provider reference would make the system-scoped webhook lookup match rows in
-- two organizations. Same contract as the mural index above: stop with the
-- conflicting ids rather than silently reassigning a provider relationship.
DO $$
DECLARE
  reference_conflicts TEXT;
BEGIN
  SELECT string_agg(format('%s/%s -> [%s]', provider, provider_customer_reference, ids), '; ')
  INTO reference_conflicts
  FROM (
    SELECT provider, provider_customer_reference, string_agg(id, ', ' ORDER BY id) AS ids
    FROM counterparty_provider_accounts
    WHERE status = 'active'
      AND kind = 'customer_link'
      AND provider_customer_reference IS NOT NULL
    GROUP BY provider, provider_customer_reference
    HAVING count(*) > 1
  ) duplicates;

  IF reference_conflicts IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'Duplicate active provider customer links must be resolved before this migration can enforce uniqueness: %s. See docs/ops/tenant-isolation.md.',
        reference_conflicts
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparty_provider_accounts_customer_link_reference
ON counterparty_provider_accounts(provider, provider_customer_reference)
WHERE status = 'active'
  AND kind = 'customer_link'
  AND provider_customer_reference IS NOT NULL;
