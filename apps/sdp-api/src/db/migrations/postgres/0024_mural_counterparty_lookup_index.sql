CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparties_mural_organization_id_active
    ON counterparties ((provider_data->'mural'->'organization'->>'id'))
    WHERE status = 'active'
      AND provider_data->'mural'->'organization'->>'id' IS NOT NULL;
