-- Retain one retired stored Credential for rollback and durably mark terminal
-- GCP rotation-candidate versions for the shared secret-cleanup batch.

ALTER TABLE provider_credentials
    ADD COLUMN secret_retention_expires_at TEXT;

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
                        AND rotated_from_provider_credential_id IS NOT NULL
                    )
                )
            )
        );

ALTER TABLE provider_credentials
    DROP CONSTRAINT provider_credentials_secret_location_check;

ALTER TABLE provider_credentials
    ADD CONSTRAINT provider_credentials_secret_location_check
        CHECK (
            (
                source = 'runtime'
                AND storage_backend = 'runtime_env'
                AND secret_ref IS NULL
                AND secret_version_ref IS NULL
                AND encrypted_secret_payload IS NULL
            )
            OR (
                source = 'stored'
                AND storage_backend = 'gcp_secret_manager'
                AND secret_ref IS NOT NULL
                AND encrypted_secret_payload IS NULL
            )
            OR (
                source = 'stored'
                AND storage_backend = 'encrypted_db'
                AND secret_ref IS NULL
                AND (
                    encrypted_secret_payload IS NOT NULL
                    OR status IN ('failed_validation', 'deactivated')
                    OR (status = 'retired' AND secret_retention_expires_at IS NULL)
                )
            )
        );

CREATE INDEX idx_provider_credentials_secret_retention_due
    ON provider_credentials(secret_retention_expires_at, id)
    WHERE secret_retention_expires_at IS NOT NULL;
