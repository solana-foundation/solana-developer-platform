-- The API now resolves Private Channels traffic through the project's RPC
-- integration. Keep the legacy column during the compatibility window, but
-- allow new writers to omit a value that is no longer used for execution.
ALTER TABLE private_channel_instances
    ALTER COLUMN chain_rpc_url SET DEFAULT '';
