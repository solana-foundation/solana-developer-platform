-- Cleanup scheduling is independent of rollback retention and Credential lifecycle.
-- Retain the exact parent and outcome when the accepted absence policy closes a row.
ALTER TABLE provider_credentials
    ADD COLUMN secret_cleanup_attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN secret_cleanup_next_attempt_at TEXT,
    ADD COLUMN secret_cleanup_absent_since TEXT,
    ADD COLUMN secret_cleanup_outcome TEXT,
    -- Two distinct identities suffice to retain evidence of an inventory conflict.
    ADD COLUMN secret_cleanup_observed_version_refs TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD CONSTRAINT provider_credentials_cleanup_observed_versions_check
        CHECK (cardinality(secret_cleanup_observed_version_refs) <= 2
               AND array_position(secret_cleanup_observed_version_refs, NULL) IS NULL),
    ADD CONSTRAINT provider_credentials_cleanup_attempt_count_check
        CHECK (secret_cleanup_attempt_count >= 0),
    ADD CONSTRAINT provider_credentials_cleanup_schedule_check
        CHECK (
            secret_cleanup_next_attempt_at IS NULL
            OR (source = 'stored' AND storage_backend = 'gcp_secret_manager'
                AND secret_retention_expires_at IS NOT NULL
                AND secret_cleanup_attempt_count > 0)
        ),
    ADD CONSTRAINT provider_credentials_cleanup_absence_check
        CHECK (
            secret_cleanup_absent_since IS NULL
            OR (source = 'stored' AND storage_backend = 'gcp_secret_manager'
                AND status = 'deactivated'
                AND last_failure_code IS NOT DISTINCT FROM 'secret_creation_abandoned'
                AND secret_version_ref IS NULL
                AND cardinality(secret_cleanup_observed_version_refs) = 0)
        ),
    ADD CONSTRAINT provider_credentials_cleanup_outcome_check
        CHECK (
            secret_cleanup_outcome IS NULL
            OR (source = 'stored' AND storage_backend = 'gcp_secret_manager'
                AND status IN ('retired', 'failed_validation', 'deactivated')
                AND secret_retention_expires_at IS NULL
                AND secret_cleanup_next_attempt_at IS NULL
                AND (
                    (secret_cleanup_outcome = 'confirmed_destroyed' AND secret_version_ref IS NOT NULL
                        AND cardinality(secret_cleanup_observed_version_refs) <= 1)
                    OR (secret_cleanup_outcome = 'assumed_absent'
                        AND secret_cleanup_absent_since IS NOT NULL)
                ))
        );

CREATE INDEX idx_provider_credentials_cleanup_retry_due
    ON provider_credentials(secret_cleanup_next_attempt_at, id)
    WHERE secret_retention_expires_at IS NOT NULL;
