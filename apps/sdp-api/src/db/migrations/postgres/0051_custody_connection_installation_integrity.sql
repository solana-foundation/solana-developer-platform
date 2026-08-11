ALTER TABLE custody_connections
    ADD COLUMN provider_account_fingerprint TEXT;

ALTER TABLE custody_connections
    ADD CONSTRAINT custody_connections_checking_lifecycle_check
        CHECK (
            status <> 'checking'
            OR (
                last_check_status IS NOT NULL
                AND last_check_status = 'running'
                AND last_check_at IS NOT NULL
            )
        ),
    ADD CONSTRAINT custody_connections_active_lifecycle_check
        CHECK (
            status <> 'active'
            OR (
                last_check_status IS NOT NULL
                AND last_check_status = 'success'
                AND last_check_at IS NOT NULL
                AND default_custody_wallet_id IS NOT NULL
                AND activated_at IS NOT NULL
            )
        ),
    ADD CONSTRAINT custody_connections_failed_lifecycle_check
        CHECK (
            status <> 'failed'
            OR (
                last_check_status IS NOT NULL
                AND last_check_status = 'failed'
                AND last_check_at IS NOT NULL
            )
        );

UPDATE custody_connections
SET provider_account_fingerprint = setup_metadata ->> 'providerAccountFingerprint',
    setup_metadata = setup_metadata - 'providerAccountFingerprint'
WHERE setup_metadata ? 'providerAccountFingerprint';

CREATE UNIQUE INDEX idx_custody_connections_privy_unfinished
    ON custody_connections(organization_id, project_id, provider)
    WHERE provider = 'privy'
      AND project_id IS NOT NULL
      AND status IN ('pending', 'checking');

CREATE UNIQUE INDEX idx_custody_connections_live_provider_account
    ON custody_connections(
        organization_id,
        project_id,
        provider,
        provider_account_fingerprint
    )
    WHERE project_id IS NOT NULL
      AND provider_account_fingerprint IS NOT NULL
      AND status IN ('pending', 'checking', 'active');

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
                )
            )
        );
