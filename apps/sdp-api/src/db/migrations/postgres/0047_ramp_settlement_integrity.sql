-- Provider settlement references must resolve to exactly one active tenant row.
-- The historical JSON-path indexes stop covering rows after encrypted provider
-- data is purged, so enforce uniqueness on the denormalized lookup columns.
CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparties_bvnk_customer_reference_denormalized_active
    ON counterparties(bvnk_customer_reference)
    WHERE status = 'active' AND bvnk_customer_reference IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparties_mural_organization_id_denormalized_active
    ON counterparties(mural_organization_id)
    WHERE status = 'active' AND mural_organization_id IS NOT NULL;

-- A confirmed wallet transfer can fund at most one MoneyGram off-ramp session.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_transfers_moneygram_crypto_leg
    ON payment_transfers ((provider_data->'moneygram'->>'cryptoTransferId'))
    WHERE provider = 'moneygram'
      AND provider_data->'moneygram'->>'cryptoTransferId' IS NOT NULL;

-- Signed Mural deliveries are consumed exactly once even when the provider retries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_transfers_mural_account_credit_delivery
    ON payment_transfers ((provider_data->'mural'->>'accountCreditedDeliveryId'))
    WHERE provider = 'mural'
      AND provider_data->'mural'->>'accountCreditedDeliveryId' IS NOT NULL;
