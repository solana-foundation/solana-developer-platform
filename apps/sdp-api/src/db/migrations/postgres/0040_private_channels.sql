-- Private Channels (SPC): the whole feature's schema, in one migration.
--
-- Tables are declared in dependency order — the connected instance, then its
-- channels, members and event feed, then deposits, withdrawals, the oracle's
-- settlement observations, and verified wallets. Every statement is
-- IF NOT EXISTS, so re-running is a no-op.


-- ==========================================================================
-- private channel instances

-- SPC connection metadata. At most one active row per project; inactive rows
-- are kept as history so a same-gateway reconnect can reuse the id. Downstream
-- tables reference private_channel_instances.id, so Delete cascades and swap
-- flows must go through Disconnect + Connect (never a raw UPDATE).

CREATE TABLE IF NOT EXISTS private_channel_instances (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,

    gateway_url TEXT NOT NULL,
    chain_rpc_url TEXT NOT NULL,
    escrow_program_id TEXT NOT NULL,
    withdraw_program_id TEXT NOT NULL,
    escrow_instance_addr TEXT NOT NULL,
    -- Auth service base URL. Required: SPC's whole member/wallet model is
    -- meaningless without auth, so the connect flow rejects an instance whose
    -- auth service can't be reached (see probeConnection).
    auth_url TEXT NOT NULL,

    is_active BOOLEAN NOT NULL DEFAULT FALSE,

    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Instance identity within a project. Gateway URL is the stable key: RPC URL
-- and program IDs can be swapped underneath, but changing the gateway means
-- a different SPC deployment and thus a different instance.
CREATE UNIQUE INDEX IF NOT EXISTS idx_private_channel_instances_project_gateway
    ON private_channel_instances(project_id, gateway_url);

-- At most one active row per project. Enforced at the DB layer so a
-- concurrent double-Connect can't race past the app-layer check.
CREATE UNIQUE INDEX IF NOT EXISTS idx_private_channel_instances_project_active
    ON private_channel_instances(project_id)
    WHERE is_active = TRUE;

-- Org-wide listing (future admin views) sorted by recency.
CREATE INDEX IF NOT EXISTS idx_private_channel_instances_org_updated
    ON private_channel_instances(organization_id, updated_at DESC);


-- ==========================================================================
-- private channels

-- Logical channels: named groupings within an SPC instance. Exactly one channel
-- per instance is the auto-provisioned default (is_default).

CREATE TABLE IF NOT EXISTS private_channels (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_default BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id) REFERENCES private_channel_instances(id) ON DELETE CASCADE,

    CONSTRAINT private_channels_status_check CHECK (status IN ('active', 'archived'))
);

-- Channel names are unique within an instance. Also the conflict target for createChannel.
CREATE UNIQUE INDEX IF NOT EXISTS private_channels_instance_name_key
    ON private_channels(instance_id, name);

-- At most one default channel per instance.
CREATE UNIQUE INDEX IF NOT EXISTS private_channels_one_default_per_instance
    ON private_channels(instance_id)
    WHERE is_default;

-- List an instance's active channels, newest first.
CREATE INDEX IF NOT EXISTS idx_private_channels_instance_created
    ON private_channels(instance_id, created_at DESC)
    WHERE status = 'active';


-- ==========================================================================
-- private channel users

-- Private Channel users: SDP users invited to an SPC workspace, scoped to a
-- project. Kept as its own table so PC-specific state (SPC credential, invite
-- bookkeeping) doesn't pollute the shared `users` table. FK to users(id)
-- preserves the identity link.
--
-- Revoke = hard-delete the row. FK cascades clean the channel memberships.

CREATE TABLE IF NOT EXISTS private_channel_users (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,

    -- SPC credential (created by POST /auth/register at invite time). SDP owns
    -- these; the user never sees them. The password ciphertext is written by the
    -- SPC cipher router: either AES-GCM under SPC_CREDENTIAL_ENCRYPTION_KEY
    -- (base64 IV + ciphertext + auth tag, per EncryptionService) or, when
    -- SPC_CREDENTIAL_KMS_KEY_NAME is set, a `v2.`-prefixed Cloud KMS envelope.
    -- Decryption dispatches on that prefix, so no version column is needed.
    spc_user_id TEXT,
    spc_username TEXT,
    spc_credential_ciphertext TEXT,

    invited_by TEXT,
    invite_token TEXT,
    invited_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    accepted_at TEXT,

    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    -- invited_by → users(id) ON DELETE SET NULL: audit is best-effort. When the
    -- inviting SDP admin is removed, the invitee stays but the "who invited
    -- them" reference is dropped. TODO: revisit if we need a durable audit
    -- record (e.g. snapshot inviter email/name into a separate audit table on
    -- invite so the trail survives inviter deletion).
    FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL,

    UNIQUE (project_id, user_id)
);

-- Invite token lookups (email accept flow, scaffolded).
CREATE UNIQUE INDEX IF NOT EXISTS private_channel_users_invite_token_key
    ON private_channel_users(invite_token)
    WHERE invite_token IS NOT NULL AND accepted_at IS NULL;

-- Project listing.
CREATE INDEX IF NOT EXISTS idx_private_channel_users_project_created
    ON private_channel_users(project_id, created_at DESC);

-- Channel ↔ user junction. Cascades on either side so removing a channel or
-- revoking a workspace-user cleans up.
CREATE TABLE IF NOT EXISTS private_channel_memberships (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    private_channel_user_id TEXT NOT NULL,

    added_by TEXT,
    added_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (channel_id) REFERENCES private_channels(id) ON DELETE CASCADE,
    FOREIGN KEY (private_channel_user_id) REFERENCES private_channel_users(id) ON DELETE CASCADE,
    FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL,

    UNIQUE (channel_id, private_channel_user_id)
);

CREATE INDEX IF NOT EXISTS idx_private_channel_memberships_channel
    ON private_channel_memberships(channel_id);
CREATE INDEX IF NOT EXISTS idx_private_channel_memberships_user
    ON private_channel_memberships(private_channel_user_id);


-- ==========================================================================
-- private channel events

-- Private channel activity events.
-- Durable, audit_logs-style trail: all scope ids (org/project/instance/channel/
-- sdp_user) are denormalized with no FK, so events survive parent deletion.

CREATE TABLE IF NOT EXISTS private_channel_events (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    channel_id TEXT,
    sdp_user_id TEXT,
    family TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now()
);

-- Channel feed query: filter by instance_id, order by (occurred_at, id) DESC.
--
-- There is deliberately no (channel_id, occurred_at) index: the only channel-scoped
-- read is `instance_id = ? AND (channel_id = ? OR channel_id IS NULL)`, and a
-- channel-leading index cannot serve the IS NULL arm. This index answers it with
-- the channel test applied as a filter.
CREATE INDEX IF NOT EXISTS idx_private_channel_events_instance_occurred
    ON private_channel_events (instance_id, occurred_at DESC, id DESC);

-- Project feed. Same (occurred_at, id) DESC cursor as the instance feed above, so it
-- carries the same trailing id to keep the sort fully index-ordered.
CREATE INDEX IF NOT EXISTS idx_private_channel_events_project_occurred
    ON private_channel_events (project_id, occurred_at DESC, id DESC);


-- ==========================================================================
-- private channel deposits

-- Deposit intents that move `amount` of `mint` from a custody wallet into the
-- instance's escrow on-chain, credited to `recipient` in the channel by the
-- operator. Lifecycle: pending -> submitted -> confirmed -> settled (or
-- failed). Amounts are decimal strings, never numeric/float.
--
-- Deposits are FINANCIAL/AUDIT records: `instance_id` is denormalized with NO
-- FK so a deposit survives instance deletion; the delete handler rejects
-- deletion while non-terminal deposits exist.
--
-- A deposit terminates at `confirmed` (tx confirmed on-chain). The operator's
-- SPC-side credit is off-chain and not observable by this reconciler, so
-- `settled` stays unreachable for deposits. The UI surfaces the credit via the
-- SPC channel-balance read on the deposit page.
--
-- `context` is an audit-only JSONB snapshot of the SPC instance parameters at
-- intent time (gateway URL, chain RPC, escrow addr, acting user). NEVER
-- consulted by the oracle or the poll handler — reconciliation always reads
-- the current instance row so an operator can repoint a stale endpoint without
-- stranding in-flight intents. Purely for forensics; secrets redacted at
-- render time (see redactCredentialSecrets).

CREATE TABLE IF NOT EXISTS private_channel_deposits (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    wallet_id TEXT NOT NULL,
    depositor TEXT NOT NULL,
    recipient TEXT NOT NULL,
    mint TEXT NOT NULL,
    amount TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    -- On-chain deposit tx signature (null until submitted).
    signature TEXT,
    -- Settlement reference. Populated when `status = 'settled'`. The chain
    -- oracle cannot reach this for deposits; set by the future SPC event source.
    settlement_ref TEXT,
    failure_reason TEXT,
    context JSONB NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    -- org/project cascade; instance_id is intentionally NOT an FK so the
    -- deposit record outlives the instance (financial history).
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,

    CONSTRAINT private_channel_deposits_status_check
        CHECK (status IN ('pending', 'submitted', 'confirmed', 'settled', 'failed'))
);

-- List a project's deposits, newest first.
CREATE INDEX IF NOT EXISTS idx_private_channel_deposits_project_created
    ON private_channel_deposits(project_id, created_at DESC);

-- Opportunistic non-terminal sweep (page load / operator view). Partial index
-- keeps the scan cheap as terminal rows accumulate.
CREATE INDEX IF NOT EXISTS idx_private_channel_deposits_pending
    ON private_channel_deposits(updated_at)
    WHERE status IN ('pending', 'submitted', 'confirmed');

-- Guard query: are there non-terminal deposits blocking instance deletion?
CREATE INDEX IF NOT EXISTS idx_private_channel_deposits_instance_status
    ON private_channel_deposits(instance_id)
    WHERE status IN ('pending', 'submitted', 'confirmed');


-- ==========================================================================
-- private channel withdrawals

-- Withdrawal intents that burn `amount` of `mint` from the `owner`'s
-- channel-chain balance, later settled by the operator releasing real USDC on
-- devnet from the instance escrow ATA to `destination`. Lifecycle: pending ->
-- submitted -> confirmed -> settled (or failed). Amounts are decimal strings.
--
-- Withdrawals are FINANCIAL/AUDIT records: `instance_id` is denormalized with
-- NO FK so a withdrawal survives instance deletion. `context` is the same
-- audit-only snapshot as private_channel_deposits above.
--
-- Under the chain-heuristic oracle a withdrawal CAN reach `settled`: after
-- `confirmed` (burn seen on the channel chain), the oracle scans the escrow
-- ATA on devnet for a matching release transfer, records the attribution in
-- private_channel_settlement_observations, and advances the intent with
-- settlement_ref = the release signature. A withdrawal may park at `confirmed`
-- indefinitely if the operator's release hasn't landed — never auto-failed
-- after the burn is confirmed (the balance is already gone; only a human or
-- an authoritative SPC event moves it forward).

CREATE TABLE IF NOT EXISTS private_channel_withdrawals (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    wallet_id TEXT NOT NULL,
    -- Channel-chain address whose token balance is burned (the burn `user`).
    owner TEXT NOT NULL,
    -- Devnet address that receives the operator's real-USDC release.
    destination TEXT NOT NULL,
    mint TEXT NOT NULL,
    amount TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    -- Channel-chain burn signature (null until submitted). Named for symmetry
    -- with private_channel_deposits.signature.
    signature TEXT,
    -- Devnet release signature (settlement correlation). Populated when
    -- `status = 'settled'`.
    settlement_ref TEXT,
    failure_reason TEXT,
    context JSONB NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,

    CONSTRAINT private_channel_withdrawals_status_check
        CHECK (status IN ('pending', 'submitted', 'confirmed', 'settled', 'failed'))
);

-- List a project's withdrawals, newest first.
CREATE INDEX IF NOT EXISTS idx_private_channel_withdrawals_project_created
    ON private_channel_withdrawals(project_id, created_at DESC);

-- Opportunistic non-terminal sweep. Partial index for cheap scans.
CREATE INDEX IF NOT EXISTS idx_private_channel_withdrawals_pending
    ON private_channel_withdrawals(updated_at)
    WHERE status IN ('pending', 'submitted', 'confirmed');

-- Guard query: are there non-terminal withdrawals blocking instance deletion?
CREATE INDEX IF NOT EXISTS idx_private_channel_withdrawals_instance_status
    ON private_channel_withdrawals(instance_id)
    WHERE status IN ('pending', 'submitted', 'confirmed');


-- ==========================================================================
-- private channel settlement observations

-- Oracle-internal correlation log. One row per attributed on-chain release
-- transfer. Nothing outside the withdrawal reconciler reads or writes this.
--
-- Two constraints do all the work:
--   PRIMARY KEY (signature, instruction_index) — one on-chain transfer can
--     only be attributed once. instruction_index lets an operator batch
--     several releases in a single tx without collision.
--   UNIQUE (intent_kind, intent_id) — each intent can only settle once.
--     Concurrent pollers racing to claim the same release collide here; the
--     loser reads the winner's row and returns the same settlement_ref.
--
-- The oracle decides from copied-in values (destination/mint/amount) rather
-- than re-reading the intent row, so external mutations can't retroactively
-- change a claim.

CREATE TABLE IF NOT EXISTS private_channel_settlement_observations (
    -- On-chain release signature.
    signature TEXT NOT NULL,
    -- Position within the tx for batched releases (0 for atomic sources).
    instruction_index INT NOT NULL DEFAULT 0,
    -- 'deposit' | 'withdrawal'. Only 'withdrawal' is populated today; deposit
    -- settlement is not observable from chain (see track-pending-deposits).
    intent_kind TEXT NOT NULL,
    intent_id TEXT NOT NULL,
    -- Copied in from the observed transfer. Redundant with the intent row on
    -- purpose — the oracle claims from its own copy.
    destination TEXT NOT NULL,
    mint TEXT NOT NULL,
    amount TEXT NOT NULL,
    block_time BIGINT,
    observed_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    PRIMARY KEY (signature, instruction_index),
    UNIQUE (intent_kind, intent_id),

    CONSTRAINT private_channel_settlement_observations_kind_check
        CHECK (intent_kind IN ('deposit', 'withdrawal'))
);


-- ==========================================================================
-- private channel transfers

-- Private Channels transfers move tokens between two verified member addresses
-- on the channel chain. Amounts are decimal strings (never numeric/float).
--
-- These rows are FINANCIAL/AUDIT history. Instance, channel, member, custody
-- wallet and verification identifiers carry NO FK, so disconnecting an instance,
-- archiving/deleting a channel, revoking a member or deleting a wallet
-- verification cannot erase transfer history. Only the owning org/project
-- cascade, since nothing in the row is meaningful once those are gone.
--
-- Lifecycle: a row is inserted as `pending` BEFORE anything is broadcast, then
-- `submitted` once SPC accepts the transaction at ingress, then `confirmed` once
-- a signature-status read shows it executed cleanly. `failed` covers preparation
-- errors, ingress rejection and execution errors. `confirmed` is terminal: SPC
-- runs one sequencer with no fork choice, so a single status read is final and
-- there is no `settled` (nothing leaves the channel).
--
-- A row still in `pending` means the request died mid-flight. A row still in
-- `submitted` means the confirm read never returned a verdict — a transport
-- error, or a dedup drop (stale blockhash / duplicate) that SPC discards without
-- telling the caller. Nothing sweeps either; both are operator signals.

CREATE TABLE IF NOT EXISTS private_channel_transfers (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    sender_private_channel_user_id TEXT NOT NULL,
    recipient_private_channel_user_id TEXT NOT NULL,
    sender_wallet_id TEXT NOT NULL,
    recipient_verified_wallet_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    mint TEXT NOT NULL,
    amount TEXT NOT NULL,
    status TEXT NOT NULL,
    signature TEXT,
    failure_reason TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,

    CONSTRAINT private_channel_transfers_distinct_addresses_check
        CHECK (sender <> recipient),
    CONSTRAINT private_channel_transfers_status_check
        CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed')),
    CONSTRAINT private_channel_transfers_result_check
        CHECK (
            (status = 'pending' AND signature IS NULL AND failure_reason IS NULL)
            OR (status = 'submitted' AND signature IS NOT NULL AND failure_reason IS NULL)
            OR (status = 'confirmed' AND signature IS NOT NULL AND failure_reason IS NULL)
            OR (status = 'failed' AND failure_reason IS NOT NULL)
        )
);

-- Project and channel history feeds, newest first.
CREATE INDEX IF NOT EXISTS idx_private_channel_transfers_project_created
    ON private_channel_transfers(project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_private_channel_transfers_channel_created
    ON private_channel_transfers(channel_id, created_at DESC, id DESC);


-- ==========================================================================
-- private channel verified wallets

-- SPC verified wallets: a custody wallet (pubkey) a member has proven control
-- of, via the challenge → sign → verify handshake with the connected instance's
-- auth service, under that member's SPC user. A row is the record that a member
-- controls a wallet, for flows that require proof of control before moving funds.
--
-- A member may verify many wallets, but a verification is scoped to the instance
-- it was made under and does not transfer across instances: uniqueness is
-- (user_id, instance_id, pubkey). user_id and instance_id are each globally
-- unique keys that pin the org/project, so those columns are not part of the key.

CREATE TABLE IF NOT EXISTS private_channel_verified_wallets (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    -- The private_channel_users row (SPC user) this wallet was verified under.
    user_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    wallet_id TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    verified_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES private_channel_users(id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id) REFERENCES private_channel_instances(id) ON DELETE CASCADE
);

-- One verification per (member, instance, pubkey); the same pubkey may recur
-- under another instance or member. This is the ON CONFLICT target — a re-verify
-- refreshes the row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_private_channel_verified_wallets_user_instance_pubkey
    ON private_channel_verified_wallets(user_id, instance_id, pubkey);

CREATE INDEX IF NOT EXISTS idx_private_channel_verified_wallets_instance
    ON private_channel_verified_wallets(instance_id);

-- The per-member, per-instance listing (newest first) + the members' verified
-- count both read by (user_id, instance_id).
CREATE INDEX IF NOT EXISTS idx_private_channel_verified_wallets_user_instance
    ON private_channel_verified_wallets(user_id, instance_id, verified_at DESC);
