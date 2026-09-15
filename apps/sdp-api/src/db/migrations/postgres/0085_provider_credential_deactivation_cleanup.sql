-- Explicit GCP Credential deactivation also retains cleanup retries for roots.
-- Preserve 0082's abandoned roots and all existing creation/retry/scan constraints.
-- Existing terminal history without a marker remains unchanged.

ALTER TABLE provider_credentials
    DROP CONSTRAINT provider_credentials_secret_retention_check,
    ADD CONSTRAINT provider_credentials_secret_retention_check
        CHECK (
            secret_retention_expires_at IS NULL
            OR (
                source = 'stored'
                AND (
                    status = 'retired'
                    OR (
                        storage_backend = 'gcp_secret_manager'
                        AND (
                            status = 'deactivated'
                            OR (
                                status = 'failed_validation'
                                AND rotated_from_provider_credential_id IS NOT NULL
                            )
                        )
                    )
                )
            )
        );
