-- Let a retired credential drop its ciphertext, the way a deactivated one can.
--
-- Rotation (HOO-1229) is the first thing that produces `retired`: the old
-- credential is replaced once the new key has been proven, and its secret
-- should stop existing at that moment for the same reason a withdrawn one does.
-- On `encrypted_db` the ciphertext IS the secret, so leaving it behind keeps a
-- decryptable copy of a key the customer has already rotated away from.
--
-- The location check only allowed a null payload for `failed_validation` and
-- `deactivated`, so retiring with the ciphertext cleared raised a constraint
-- violation and the whole rotation rolled back.

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
                    OR status IN ('failed_validation', 'deactivated', 'retired')
                )
            )
        );
