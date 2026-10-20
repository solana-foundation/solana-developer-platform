-- Fireblocks uses the existing stored-credential lifecycle, including durable
-- GCP creation and container cleanup. Apply before deploying its BYOK runtime.
ALTER TABLE provider_credentials
    DROP CONSTRAINT provider_credentials_creating_location_check,
    ADD CONSTRAINT provider_credentials_creating_location_check CHECK (
        status <> 'creating' OR (
            provider IN ('privy', 'fireblocks') AND source = 'stored'
            AND storage_backend = 'gcp_secret_manager' AND secret_ref IS NOT NULL
            AND secret_version_ref IS NULL AND encrypted_secret_payload IS NULL
        )
    ) NOT VALID,
    DROP CONSTRAINT provider_credentials_scan_owner_check,
    ADD CONSTRAINT provider_credentials_scan_owner_check CHECK (
        secret_next_scan_at IS NULL OR (
            provider IN ('privy', 'fireblocks') AND source = 'stored'
            AND storage_backend = 'gcp_secret_manager' AND secret_ref IS NOT NULL
        )
    ) NOT VALID;
