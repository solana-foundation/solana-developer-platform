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

DELETE FROM provider_credentials
 WHERE provider IN ('alchemy', 'helius', 'nodit', 'quicknode', 'triton', 'validationcloud');

ALTER TABLE organizations
    DROP COLUMN rpc_credential_mode;

UPDATE projects
   SET settings = ((settings::jsonb) - 'rpcProvider' - 'rpcEndpoint')::text
 WHERE settings LIKE '%rpcProvider%' OR settings LIKE '%rpcEndpoint%';

UPDATE organizations
   SET settings = (((settings::jsonb) - 'rpcProvider') #- '{providerOverrides,rpc}')::text
 WHERE settings LIKE '%rpcProvider%' OR settings LIKE '%"rpc"%';
