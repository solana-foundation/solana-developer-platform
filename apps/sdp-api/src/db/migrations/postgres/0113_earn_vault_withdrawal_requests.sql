-- Solana Earn: asynchronous vault withdrawal requests.
--
-- A queued withdrawal is not a signed movement with a slow confirmation. The
-- holder first signs a REQUEST transaction that escrows shares, a provider
-- solver later pays assets in a different transaction, and the holder may sign
-- a CANCEL transaction only after the deadline. Keeping those three facts in
-- `earn_movements` would make a finalized request transaction look like a
-- finalized payout. These tables deliberately keep the long-lived request,
-- its signed owner actions, and caller-signed transaction builds separate.

CREATE TABLE IF NOT EXISTS earn_vault_withdrawal_request_statuses (
    id TEXT PRIMARY KEY,
    is_terminal BOOLEAN NOT NULL
);
INSERT INTO earn_vault_withdrawal_request_statuses (id, is_terminal) VALUES
    ('creating', FALSE),
    ('pending', FALSE),
    ('fulfillable', FALSE),
    ('expired_cancelable', FALSE),
    ('cancelling', FALSE),
    -- The request account has closed but its closing event could not yet be
    -- fetched. It remains retryable: ambiguity is never a terminal guess.
    ('closed_or_unknown', FALSE),
    ('fulfilled', TRUE),
    ('cancelled', TRUE),
    ('failed', TRUE)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS earn_vault_withdrawal_action_statuses (
    id TEXT PRIMARY KEY,
    is_terminal BOOLEAN NOT NULL
);
INSERT INTO earn_vault_withdrawal_action_statuses (id, is_terminal) VALUES
    ('requested', FALSE),
    ('submitted', FALSE),
    ('confirmed', FALSE),
    ('finalized', TRUE),
    ('failed', TRUE)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS earn_vault_withdrawal_requests (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    environment TEXT NOT NULL,
    provider TEXT NOT NULL,
    position_id TEXT NOT NULL,
    custody_wallet_id TEXT,
    -- Always the on-chain owner, including custody. `custody_wallet_id`
    -- distinguishes an SDP signer from an external signer; retaining the
    -- address lets the indexer authenticate landed PDA and lifecycle state.
    owner_address TEXT NOT NULL,
    -- MATCH SIMPLE needs a nullable external-wallet discriminator: custody
    -- requests still retain their owner address for chain verification, but
    -- must not be checked against the external-wallet position identity.
    external_owner_address TEXT GENERATED ALWAYS AS (
        CASE WHEN custody_wallet_id IS NULL THEN owner_address ELSE NULL END
    ) STORED,
    vault_address TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    share_mint TEXT NOT NULL,
    request_address TEXT NOT NULL,
    status TEXT NOT NULL,

    shares TEXT NOT NULL,
    quoted_assets TEXT NOT NULL,
    share_decimals SMALLINT NOT NULL,
    asset_decimals SMALLINT NOT NULL,
    discount_bps INTEGER NOT NULL,
    -- Provider timestamps are Unix epoch seconds. NUMERIC preserves uint64
    -- exactly and is mapped to strings at the TypeScript boundary.
    -- The nonce is chain truth too: preview/build cannot know it, so it stays
    -- null until the landed PDA or lifecycle event is observed.
    nonce NUMERIC,
    creation_timestamp NUMERIC,
    maturity_timestamp NUMERIC NOT NULL,
    deadline_timestamp NUMERIC NOT NULL,

    -- The create key is anchored on the request object. Cancellation keys live
    -- on their action rows because a failed cancellation may be retried with a
    -- fresh transaction without manufacturing a second request.
    client_request_id TEXT NOT NULL,
    idempotency_fingerprint TEXT NOT NULL,

    creation_signature TEXT,
    cancel_signature TEXT,
    closing_signature TEXT,
    assets_paid TEXT,
    failure_reason TEXT,
    last_index_error TEXT,
    fulfilled_at TEXT,
    cancelled_at TEXT,
    created_by TEXT,
    initiated_by_key_id TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    last_checked_at TEXT,

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    FOREIGN KEY (position_id, organization_id, environment, provider)
        REFERENCES earn_positions(id, organization_id, environment, provider),
    FOREIGN KEY (
        position_id, organization_id, environment, provider,
        vault_address, custody_wallet_id
    ) REFERENCES earn_positions(
        id, organization_id, environment, provider,
        vault_address, custody_wallet_id
    ),
    FOREIGN KEY (
        position_id, organization_id, project_id, environment, provider,
        vault_address, external_owner_address
    ) REFERENCES earn_positions(
        id, organization_id, project_id, environment, provider,
        vault_address, owner_address
    ),
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (status) REFERENCES earn_vault_withdrawal_request_statuses(id),

    CONSTRAINT earn_vault_withdrawal_requests_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT earn_vault_withdrawal_requests_owner_address_format_check
        CHECK (LENGTH(owner_address) BETWEEN 32 AND 44),
    CONSTRAINT earn_vault_withdrawal_requests_amounts_check
        CHECK (
            LENGTH(shares) BETWEEN 1 AND 128
            AND shares ~ '^\d+(\.\d+)?$'
            AND shares ~ '[1-9]'
            AND LENGTH(quoted_assets) BETWEEN 1 AND 128
            AND quoted_assets ~ '^\d+(\.\d+)?$'
        ),
    CONSTRAINT earn_vault_withdrawal_requests_decimals_check
        CHECK (share_decimals BETWEEN 0 AND 9 AND asset_decimals BETWEEN 0 AND 9),
    CONSTRAINT earn_vault_withdrawal_requests_discount_check
        CHECK (discount_bps BETWEEN 0 AND 10000),
    CONSTRAINT earn_vault_withdrawal_requests_timestamps_check
        CHECK (
            (nonce IS NULL OR (
                nonce = TRUNC(nonce)
                AND nonce BETWEEN 0 AND 18446744073709551615
            ))
            AND
            maturity_timestamp = TRUNC(maturity_timestamp)
            AND deadline_timestamp = TRUNC(deadline_timestamp)
            AND maturity_timestamp >= 0
            AND deadline_timestamp > maturity_timestamp
            AND (creation_timestamp IS NULL OR (
                creation_timestamp = TRUNC(creation_timestamp)
                AND creation_timestamp >= 0
            ))
        ),
    CONSTRAINT earn_vault_withdrawal_requests_assets_paid_check
        CHECK (
            assets_paid IS NULL
            OR (
                status = 'fulfilled'
                AND LENGTH(assets_paid) BETWEEN 1 AND 128
                AND assets_paid ~ '^\d+(\.\d+)?$'
            )
        ),
    CONSTRAINT earn_vault_withdrawal_requests_terminal_metadata_check
        CHECK (
            (status = 'fulfilled') = (fulfilled_at IS NOT NULL)
            AND (status = 'cancelled') = (cancelled_at IS NOT NULL)
            AND (status = 'failed') = (failure_reason IS NOT NULL)
        ),
    CONSTRAINT earn_vault_withdrawal_requests_tenancy_key
        UNIQUE (id, organization_id, environment),
    CONSTRAINT earn_vault_withdrawal_requests_client_request_key
        UNIQUE (organization_id, client_request_id)
);

-- Sandbox and production can point at deployments whose deterministic PDA
-- identities repeat. A definitively failed create never occupied its PDA on
-- chain, so a fresh transaction may safely reuse it; all live or completed
-- requests remain globally unique within their environment.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_vault_withdrawal_requests_live_address
    ON earn_vault_withdrawal_requests(environment, request_address)
    WHERE status <> 'failed';

CREATE TABLE IF NOT EXISTS earn_vault_withdrawal_request_actions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    environment TEXT NOT NULL,
    withdrawal_request_id TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    signature TEXT NOT NULL,
    signed_transaction TEXT NOT NULL,
    last_valid_block_height NUMERIC NOT NULL,
    client_request_id TEXT NOT NULL,
    idempotency_fingerprint TEXT NOT NULL,
    failure_reason TEXT,
    confirmed_at TEXT,
    settled_at TEXT,
    created_by TEXT,
    initiated_by_key_id TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    last_checked_at TEXT,
    -- A missing signature after blockhash expiry is sampled twice before a
    -- request is failed: one RPC history miss is not proof of absence.
    unknown_signature_observed_at TEXT,

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    FOREIGN KEY (withdrawal_request_id, organization_id, environment)
        REFERENCES earn_vault_withdrawal_requests(id, organization_id, environment)
        ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (status) REFERENCES earn_vault_withdrawal_action_statuses(id),

    CONSTRAINT earn_vault_withdrawal_request_actions_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT earn_vault_withdrawal_request_actions_action_check
        CHECK (action IN ('request', 'cancel')),
    CONSTRAINT earn_vault_withdrawal_request_actions_height_check
        CHECK (
            last_valid_block_height = TRUNC(last_valid_block_height)
            AND last_valid_block_height BETWEEN 0 AND 18446744073709551615
        ),
    CONSTRAINT earn_vault_withdrawal_request_actions_confirmation_check
        CHECK ((status IN ('confirmed', 'finalized')) = (confirmed_at IS NOT NULL)),
    CONSTRAINT earn_vault_withdrawal_request_actions_settlement_check
        CHECK ((status = 'finalized') = (settled_at IS NOT NULL)),
    CONSTRAINT earn_vault_withdrawal_request_actions_failure_check
        CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
    CONSTRAINT earn_vault_withdrawal_request_actions_signature_key UNIQUE (signature),
    CONSTRAINT earn_vault_withdrawal_request_actions_client_request_key
        UNIQUE (organization_id, client_request_id)
);

-- At most one non-failed transaction may advance each action. A failed cancel
-- may be retried with a fresh key and fresh blockhash after an RPC/program
-- refusal; a landed/finalizing one may never race another.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_vault_withdrawal_request_actions_live_kind
    ON earn_vault_withdrawal_request_actions(withdrawal_request_id, action)
    WHERE status <> 'failed';

-- Building two request transactions against the same queue owner before
-- either lands can derive the same provider nonce/PDA. Custody has no durable
-- unsigned-build row, so it takes this short lease after the provider returns
-- the deterministic PDA and before SDP signs. A crashed worker releases it by
-- expiry. Recording a request atomically promotes the shared lease to durable
-- occupancy, so RLS cannot hide a live or historical PDA from another tenant.
CREATE TABLE IF NOT EXISTS earn_vault_withdrawal_request_reservations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    environment TEXT NOT NULL,
    provider TEXT NOT NULL,
    vault_address TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    request_address TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    idempotency_fingerprint TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    -- External-wallet builds use chain height as their authoritative lease;
    -- custody's short in-process build reservation leaves this null.
    last_valid_block_height NUMERIC,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    CONSTRAINT earn_vault_withdrawal_request_reservations_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT earn_vault_withdrawal_request_reservations_owner_format_check
        CHECK (LENGTH(owner_address) BETWEEN 32 AND 44),
    CONSTRAINT earn_vault_withdrawal_request_reservations_height_check
        CHECK (
            last_valid_block_height IS NULL OR (
                last_valid_block_height = TRUNC(last_valid_block_height)
                AND last_valid_block_height BETWEEN 0 AND 18446744073709551615
            )
        )
);

-- Provider PDAs are public chain identities, not tenant data. This deliberately
-- contains no organization/project/owner fields and is therefore a shared
-- coordination table: both custody and keyed external builders atomically
-- claim the same key, and an expired lease can be replaced even when its
-- tenant-owned forensic reservation row is hidden by RLS.
CREATE TABLE IF NOT EXISTS earn_vault_withdrawal_request_pda_leases (
    environment TEXT NOT NULL,
    request_address TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_valid_block_height NUMERIC,
    -- False while a builder merely reserves the next nonce. Once its request
    -- row is durable this becomes a permanent public-chain occupancy claim,
    -- retained across tenants and terminal history. It is released only when
    -- the create is definitively failed before landing.
    occupied BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT earn_vault_withdrawal_request_pda_leases_pkey
        PRIMARY KEY (environment, request_address),
    CONSTRAINT earn_vault_withdrawal_request_pda_leases_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT earn_vault_withdrawal_request_pda_leases_height_check
        CHECK (
            last_valid_block_height IS NULL OR (
                last_valid_block_height = TRUNC(last_valid_block_height)
                AND last_valid_block_height BETWEEN 0 AND 18446744073709551615
            )
        )
);

CREATE TABLE IF NOT EXISTS earn_external_wallet_withdrawal_request_transactions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    environment TEXT NOT NULL,
    provider TEXT NOT NULL,
    position_id TEXT,
    withdrawal_request_id TEXT,
    action TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    vault_address TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    share_mint TEXT NOT NULL,
    request_address TEXT NOT NULL,
    shares TEXT,
    quoted_assets TEXT,
    share_decimals SMALLINT,
    asset_decimals SMALLINT,
    discount_bps INTEGER,
    maturity_timestamp NUMERIC,
    deadline_timestamp NUMERIC,
    fee_payer TEXT,
    unsigned_transaction TEXT NOT NULL,
    last_valid_block_height NUMERIC NOT NULL,
    consumed_action_id TEXT,
    consumed_at TEXT,
    created_by TEXT,
    initiated_by_key_id TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    FOREIGN KEY (
        position_id, organization_id, project_id, environment, provider,
        vault_address, owner_address
    ) REFERENCES earn_positions(
        id, organization_id, project_id, environment, provider,
        vault_address, owner_address
    ),
    FOREIGN KEY (withdrawal_request_id, organization_id, environment)
        REFERENCES earn_vault_withdrawal_requests(id, organization_id, environment),
    FOREIGN KEY (consumed_action_id) REFERENCES earn_vault_withdrawal_request_actions(id),
    FOREIGN KEY (created_by) REFERENCES users(id),

    CONSTRAINT earn_external_wallet_withdrawal_request_transactions_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT earn_external_wallet_withdrawal_request_transactions_action_check
        CHECK (action IN ('request', 'cancel')),
    CONSTRAINT earn_external_wallet_withdrawal_request_transactions_owner_format_check
        CHECK (LENGTH(owner_address) BETWEEN 32 AND 44),
    CONSTRAINT earn_external_wallet_withdrawal_request_transactions_fee_payer_format_check
        CHECK (fee_payer IS NULL OR LENGTH(fee_payer) BETWEEN 32 AND 44),
    CONSTRAINT earn_external_wallet_withdrawal_request_transactions_request_shape_check
        CHECK (
            (action = 'request' AND withdrawal_request_id IS NULL
             AND position_id IS NOT NULL
             AND shares IS NOT NULL AND quoted_assets IS NOT NULL
             AND share_decimals IS NOT NULL AND asset_decimals IS NOT NULL
             AND discount_bps IS NOT NULL
             AND maturity_timestamp IS NOT NULL AND deadline_timestamp IS NOT NULL)
            OR
            (action = 'cancel' AND withdrawal_request_id IS NOT NULL
             AND shares IS NULL AND quoted_assets IS NULL
             AND share_decimals IS NULL AND asset_decimals IS NULL
             AND discount_bps IS NULL
             AND maturity_timestamp IS NULL AND deadline_timestamp IS NULL)
        ),
    CONSTRAINT earn_external_wallet_withdrawal_request_transactions_height_check
        CHECK (
            last_valid_block_height = TRUNC(last_valid_block_height)
            AND last_valid_block_height BETWEEN 0 AND 18446744073709551615
        ),
    CONSTRAINT earn_external_wallet_withdrawal_request_transactions_consumed_check
        CHECK ((consumed_action_id IS NULL) = (consumed_at IS NULL)),
    CONSTRAINT earn_external_wallet_withdrawal_request_transactions_consumed_action_key
        UNIQUE (consumed_action_id)
);

CREATE INDEX IF NOT EXISTS idx_earn_vault_withdrawal_requests_tenant_created
    ON earn_vault_withdrawal_requests(
        organization_id, environment, created_at DESC, id DESC
    );
CREATE INDEX IF NOT EXISTS idx_earn_vault_withdrawal_requests_owner_created
    ON earn_vault_withdrawal_requests(
        organization_id, project_id, environment, owner_address, created_at DESC, id DESC
    );
CREATE INDEX IF NOT EXISTS idx_earn_vault_withdrawal_requests_reconcile
    ON earn_vault_withdrawal_requests(
        COALESCE(last_checked_at, updated_at), id
    )
    WHERE status IN (
        'creating', 'pending', 'fulfillable', 'expired_cancelable',
        'cancelling', 'closed_or_unknown'
    );
CREATE INDEX IF NOT EXISTS idx_earn_vault_withdrawal_request_actions_reconcile
    ON earn_vault_withdrawal_request_actions(
        COALESCE(last_checked_at, updated_at), id
    )
    WHERE status IN ('requested', 'submitted', 'confirmed');
-- The shared PDA lease table is the sole cross-tenant concurrency authority.
-- A tenant-owned build row is RLS-hidden from other organizations, so a
-- global partial unique index here would incorrectly block an expired lease
-- takeover even after the shared lease had atomically moved to its successor.

-- Best-effort audit backfill is safe under concurrent idempotent replays: one
-- owner-signed request/cancel action produces at most one hash-chain entry.
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_earn_vault_withdrawal_action
    ON audit_logs(resource_id)
    WHERE resource_type = 'earn_vault_withdrawal_request'
      AND action IN ('withdraw_request', 'withdraw_cancel');

-- Tenant isolation is part of the creating migration. A later coverage test
-- rejects any tenant-owned table which relies on application scoping alone.
ALTER TABLE earn_vault_withdrawal_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE earn_vault_withdrawal_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON earn_vault_withdrawal_requests
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));

ALTER TABLE earn_vault_withdrawal_request_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE earn_vault_withdrawal_request_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON earn_vault_withdrawal_request_actions
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));

ALTER TABLE earn_vault_withdrawal_request_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE earn_vault_withdrawal_request_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON earn_vault_withdrawal_request_reservations
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));

ALTER TABLE earn_external_wallet_withdrawal_request_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE earn_external_wallet_withdrawal_request_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON earn_external_wallet_withdrawal_request_transactions
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
