-- Durable retry queue for SPC wallet bindings that were created while an
-- identity was being disabled. It is intentionally separate from the verified
-- wallet mirror: another active identity may already own the same pubkey in
-- SDP, but the disabled identity's upstream binding still needs revocation.

CREATE TABLE IF NOT EXISTS private_channel_wallet_revocations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    wallet_id TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES private_channel_users(id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id) REFERENCES private_channel_instances(id) ON DELETE CASCADE,

    UNIQUE (user_id, instance_id, pubkey)
);

CREATE INDEX IF NOT EXISTS private_channel_wallet_revocations_user_instance
    ON private_channel_wallet_revocations(user_id, instance_id);
