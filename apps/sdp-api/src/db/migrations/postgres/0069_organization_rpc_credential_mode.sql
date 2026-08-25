-- Whether an organization runs RPC on SDP's credentials or entirely on its own.
--
-- `managed` is what every organization does today: a tenant connection is used
-- when one is live, and platform providers answer otherwise. `byok` is the
-- other position -- the organization has said its traffic leaves on its own
-- keys, so falling back to ours is not a kindness, it is the platform quietly
-- paying for and seeing traffic the customer chose to keep on their account.
--
-- Default `managed` on purpose: this must not change the behaviour of any
-- organization that has not asked for it.

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS rpc_credential_mode TEXT NOT NULL DEFAULT 'managed';

ALTER TABLE organizations
    DROP CONSTRAINT IF EXISTS organizations_rpc_credential_mode_check;

ALTER TABLE organizations
    ADD CONSTRAINT organizations_rpc_credential_mode_check
        CHECK (rpc_credential_mode IN ('managed', 'byok'));
