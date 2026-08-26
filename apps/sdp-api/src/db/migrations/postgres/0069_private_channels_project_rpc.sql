-- Private Channels uses the project's effective RPC connection for all Solana
-- L1 traffic. Keeping a second endpoint on the instance duplicated credentials,
-- became stale when the project changed provider, and could not represent
-- providers whose credentials travel in headers.

ALTER TABLE private_channel_instances
    DROP COLUMN IF EXISTS chain_rpc_url;
