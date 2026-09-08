-- Persist custody GCP creation before the external write. The Credential row
-- is also the recovery record when a write or its SQL finalization is unknown.
ALTER TABLE provider_credentials
    DROP CONSTRAINT provider_credentials_status_check;

ALTER TABLE provider_credentials
    ADD CONSTRAINT provider_credentials_status_check
        CHECK (status IN ('creating', 'pending', 'active', 'failed_validation', 'retired', 'deactivated')),
    ADD CONSTRAINT provider_credentials_creating_location_check
        CHECK (
            status <> 'creating'
            OR (
                provider = 'privy'
                AND source = 'stored'
                AND storage_backend = 'gcp_secret_manager'
                AND secret_ref IS NOT NULL
                AND secret_version_ref IS NULL
                AND encrypted_secret_payload IS NULL
            )
        );

ALTER TABLE provider_credentials
    DROP CONSTRAINT provider_credentials_secret_retention_check;

ALTER TABLE provider_credentials
    ADD CONSTRAINT provider_credentials_secret_retention_check
        CHECK (
            secret_retention_expires_at IS NULL
            OR (
                source = 'stored'
                AND (
                    status = 'retired'
                    OR (
                        storage_backend = 'gcp_secret_manager'
                        AND status IN ('failed_validation', 'deactivated')
                        AND (
                            rotated_from_provider_credential_id IS NOT NULL
                            OR (status = 'deactivated'
                                AND last_failure_code IS NOT DISTINCT FROM 'secret_creation_abandoned')
                        )
                    )
                )
            )
        );

CREATE INDEX idx_provider_credentials_stale_creation
    ON provider_credentials(created_at, id)
    WHERE status = 'creating';
