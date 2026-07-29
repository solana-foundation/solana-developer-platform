ALTER TABLE provider_credentials
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;

ALTER TABLE provider_credentials
    DROP CONSTRAINT IF EXISTS provider_credentials_idempotency_pair_check;

ALTER TABLE provider_credentials
    ADD CONSTRAINT provider_credentials_idempotency_pair_check
        CHECK (
            (idempotency_key IS NULL AND idempotency_fingerprint IS NULL)
            OR (idempotency_key IS NOT NULL AND idempotency_fingerprint IS NOT NULL)
        );

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_credentials_org_idempotency_key
    ON provider_credentials(organization_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
