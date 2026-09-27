-- Durable revocation epoch for Private Channels wallet verifications
-- (SOLA9-664 / APE-812).
--
-- `private_channel_verified_wallets` is the SDP mirror of an SPC wallet
-- binding, and the value-movement gates trust it. A verification request spends
-- seconds inside its SPC challenge → sign → verify handshake before it upserts
-- the mirror, so a concurrent revocation could complete its SPC `deleteWallet`
-- plus mirror removal in that window and the stale verification continuation
-- would then recreate the mirror row while SPC stayed unbound — a row the gates
-- accept even though the upstream authority has no binding.
--
-- This table is the revocation barrier that survives mirror deletion: a
-- revocation advances `epoch` in the same transaction that removes the mirror,
-- and a verification records the epoch it observed before its SPC handshake so
-- its conditional mirror upsert only lands when the epoch is unchanged. An
-- epoch that advanced means a revocation committed after the verification read
-- it, so the verification's local write must lose.
--
-- The epoch is keyed by (user_id, instance_id, pubkey) — one row per
-- identity's binding. Every reader that compares the epoch against a
-- pending-revocation marker's `claim_epoch` (the cleanup-claim latch) is
-- scoped to that one identity: a marker's `claim_epoch` records the epoch its
-- claim advanced to, and only the claiming identity's own convergence (its
-- compensating delete plus the epoch advance of its local half) may move the
-- epoch past it. Keying the epoch by (instance_id, pubkey) alone would let
-- another identity's claim or revocation for the same pubkey advance the
-- shared counter and falsely release the marker's latch while its owner's
-- compensating delete is still in flight — a fresh verification would then
-- land a mirror whose binding that outstanding delete removes. Each
-- identity's own actions are the only advances its latch may observe.
--
-- The epoch never resets: higher is always newer.

CREATE TABLE IF NOT EXISTS private_channel_wallet_revocation_epochs (
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    epoch BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES private_channel_users(id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id) REFERENCES private_channel_instances(id) ON DELETE CASCADE,

    PRIMARY KEY (user_id, instance_id, pubkey)
);

ALTER TABLE private_channel_wallet_revocation_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_channel_wallet_revocation_epochs FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON private_channel_wallet_revocation_epochs
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
