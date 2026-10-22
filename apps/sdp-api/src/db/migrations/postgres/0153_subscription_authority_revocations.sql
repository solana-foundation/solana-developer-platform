-- Revoking a wallet's per-mint Subscriptions authority once its recurring
-- payments have ended (HOO-2210).
--
-- Activation approves the program's SubscriptionAuthority PDA as the SPL
-- delegate on the wallet's token account for u64::MAX, and cancel leaves that
-- delegation in place: the program keeps a canceled subscription resumable
-- until the end of its billing period, and resume needs the same authority.
-- The revoke-subscription-authorities cron revokes it once every recurring
-- payment on the authority has ended and its last period is over.
--
-- One row per revoke the cron runs. A `processing` row holds the wallet's
-- authorities: activation, update and resume refuse to claim a recurring
-- payment on that wallet until it settles, so a new subscription never lands
-- on an authority that is being closed. The signature and the expiry of the
-- blockhash it was signed with are saved before the send, as recurring
-- attempts do (0152), so recovery can prove a send never landed.
--
-- `environment` is the project's, copied so the one-in-flight index can be
-- per cluster: the same wallet address has a separate authority on each.
--
-- `lease_id` names the run that holds a `processing` revoke. A run that takes
-- over a stale one issues a new lease, and every save and finish requires the
-- caller's, so a slow run that wakes after a takeover can change nothing.
CREATE TABLE payment_subscription_authority_revocations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
    -- Cascades like custody_wallets itself does from its config, so retiring a config is never
    -- blocked by a revoke's history.
    custody_wallet_id TEXT NOT NULL REFERENCES custody_wallets(id) ON DELETE CASCADE,
    wallet_address TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    subscription_authority_address TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('processing', 'confirmed', 'failed')),
    lease_id TEXT NOT NULL,
    signature TEXT,
    last_valid_block_height sdp_u64,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    CHECK ((signature IS NULL) = (last_valid_block_height IS NULL)),
    CHECK (status <> 'confirmed' OR error IS NULL)
);

CREATE UNIQUE INDEX payment_subscription_authority_revocations_one_in_flight
    ON payment_subscription_authority_revocations (environment, subscription_authority_address)
    WHERE status = 'processing';

CREATE INDEX payment_subscription_authority_revocations_wallet_status
    ON payment_subscription_authority_revocations (environment, wallet_address, status);

CREATE INDEX payment_subscription_authority_revocations_authority_created
    ON payment_subscription_authority_revocations (environment, subscription_authority_address, created_at DESC);

ALTER TABLE payment_subscription_authority_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_subscription_authority_revocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON payment_subscription_authority_revocations;
CREATE POLICY sdp_tenant_isolation ON payment_subscription_authority_revocations
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
