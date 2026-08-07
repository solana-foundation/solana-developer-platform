ALTER TABLE custody_wallets
    ADD COLUMN IF NOT EXISTS custody_connection_id TEXT,
    ALTER COLUMN custody_config_id DROP NOT NULL;

ALTER TABLE custody_wallets
    ADD CONSTRAINT custody_wallets_connection_fkey
        FOREIGN KEY (custody_connection_id)
        REFERENCES custody_connections(id)
        ON DELETE RESTRICT,
    ADD CONSTRAINT custody_wallets_exactly_one_owner
        CHECK ((custody_config_id IS NOT NULL) <> (custody_connection_id IS NOT NULL)),
    ADD CONSTRAINT custody_wallets_id_connection_unique
        UNIQUE (id, custody_connection_id),
    ADD CONSTRAINT custody_wallets_connection_wallet_unique
        UNIQUE (custody_connection_id, wallet_id);

ALTER TABLE custody_connections
    DROP CONSTRAINT IF EXISTS custody_connections_default_custody_wallet_id_fkey;

ALTER TABLE custody_connections
    ADD CONSTRAINT custody_connections_default_wallet_owner_fkey
        FOREIGN KEY (default_custody_wallet_id, id)
        REFERENCES custody_wallets(id, custody_connection_id)
        ON DELETE SET NULL (default_custody_wallet_id);

ALTER TABLE provider_credentials
    DROP CONSTRAINT IF EXISTS provider_credentials_secret_location_check;

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
                    OR status = 'failed_validation'
                )
            )
        );
