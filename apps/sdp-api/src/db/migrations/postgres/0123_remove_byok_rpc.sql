-- sdp:migration-compat: breaking
-- BYOK RPC is removed (HOO-1876): every project's RPC is SDP's managed pool for
-- its cluster, and nothing per organization or per project selects a provider.
-- Merge only after the code that stops reading these objects (PR #2216) is
-- deployed; the previous image still reads `rpc_connections`.
--
-- `provider_credentials` stays because custody (Privy) and Helius Rings
-- credentials live there too. The custody and RPC provider vocabularies do not
-- overlap (see 0072), and `helius` is not `helius_rings`.

DROP TABLE rpc_connections;

-- A GCP Secret Manager version outlives its row, so each one is queued for the
-- `retire-orphaned-secrets` sweeper before the row that records it is deleted.
-- `encrypted_db` ciphertext dies with the row.
INSERT INTO secret_retirements
    (id, organization_id, source_id, storage_backend, secret_ref, secret_version_ref, last_error)
SELECT 'wf_secret_retirement_' || gen_random_uuid(),
       organization_id,
       id,
       storage_backend,
       secret_ref,
       secret_version_ref,
       'byok rpc removed (0123)'
  FROM provider_credentials
 WHERE provider IN ('alchemy', 'helius', 'nodit', 'quicknode', 'triton', 'validationcloud')
   AND storage_backend = 'gcp_secret_manager'
   AND secret_version_ref IS NOT NULL
ON CONFLICT (secret_version_ref) DO NOTHING;

DELETE FROM provider_credentials
 WHERE provider IN ('alchemy', 'helius', 'nodit', 'quicknode', 'triton', 'validationcloud');

ALTER TABLE organizations
    DROP COLUMN rpc_credential_mode;

-- Settings that held only RPC keys become NULL, the "never set" value the
-- project and organization readers return as `null`.
UPDATE projects
   SET settings = NULLIF(((settings::jsonb) - 'rpcProvider' - 'rpcEndpoint')::text, '{}')
 WHERE settings LIKE '%rpcProvider%' OR settings LIKE '%rpcEndpoint%';

UPDATE organizations
   SET settings = NULLIF((((settings::jsonb) - 'rpcProvider') #- '{providerOverrides,rpc}')::text, '{}')
 WHERE settings LIKE '%rpcProvider%' OR settings LIKE '%"rpc"%';
