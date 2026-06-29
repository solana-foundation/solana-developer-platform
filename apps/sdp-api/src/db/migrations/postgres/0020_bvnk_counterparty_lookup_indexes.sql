CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparties_bvnk_customer_reference_active
    ON counterparties ((provider_data->'bvnk'->'customer'->>'customerReference'))
    WHERE status = 'active'
      AND provider_data->'bvnk'->'customer'->>'customerReference' IS NOT NULL;

