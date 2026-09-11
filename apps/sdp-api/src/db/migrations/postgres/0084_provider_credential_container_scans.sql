-- One retained Credential owns the periodic scan for one shared GCP container.
-- Existing per-version cleanup evidence remains historical; new scans use only
-- this timestamp and the normal Credential/reference/rollback guards.
ALTER TABLE provider_credentials
    ADD COLUMN secret_next_scan_at TIMESTAMPTZ,
    ADD CONSTRAINT provider_credentials_scan_owner_check CHECK (
        secret_next_scan_at IS NULL
        OR (provider = 'privy' AND source = 'stored'
            AND storage_backend = 'gcp_secret_manager' AND secret_ref IS NOT NULL)
    );

WITH owners AS (
    SELECT id, row_number() OVER (
        PARTITION BY secret_ref ORDER BY created_at, id
    ) AS ordinal
    FROM provider_credentials
    WHERE provider = 'privy' AND source = 'stored'
      AND storage_backend = 'gcp_secret_manager' AND secret_ref IS NOT NULL
)
UPDATE provider_credentials pc SET secret_next_scan_at = clock_timestamp()
FROM owners WHERE owners.id = pc.id AND owners.ordinal = 1;

CREATE UNIQUE INDEX idx_provider_credentials_gcp_scan_owner
    ON provider_credentials(secret_ref) WHERE secret_next_scan_at IS NOT NULL;
CREATE INDEX idx_provider_credentials_gcp_scan_due
    ON provider_credentials(secret_next_scan_at, id) WHERE secret_next_scan_at IS NOT NULL;
