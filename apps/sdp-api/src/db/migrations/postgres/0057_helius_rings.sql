-- Helius Rings: the whole module's schema, in one migration.
--
-- Rings is the shielded-transfer module: a private wallet is bound to an SDP
-- custody wallet, and every shielded action runs through a persisted state
-- machine (draft -> preparing -> approval_required -> proving -> ready_to_sign
-- -> submitted -> indexing -> completed, with a typed `failed` edge from every
-- non-terminal state).
--
-- Tables are declared in dependency order — the wallet, then its key material
-- and zones, then operations, their timelocks and event feed, then the
-- platform-level asset allowlist and runtime health board. Every statement is
-- IF NOT EXISTS, so re-running is a no-op.
--
-- Three decisions worth stating up front, because they are the ones that are
-- expensive to retrofit:
--
--   1. `intent_key` carries a UNIQUE index. It is the idempotency contract:
--      hash(walletId, opType, canonical(inputs), clientNonce). Without the
--      index, a retried request creates a ghost duplicate operation that only
--      ever surfaces in production, on the money path, under load.
--
--   2. `retry_of_operation_id` is ON DELETE SET NULL, never CASCADE. A retry
--      chain is audit evidence; cascading would let the deletion of one
--      operation recursively erase the whole lineage that explains it.
--
--   3. Operations reference their wallet through the composite
--      (wallet_id, organization_id, project_id) key, following the pattern
--      0048_earn.sql established for earn_movements. A plain wallet_id FK
--      would happily let an operation in project A point at a wallet in
--      project B; for a privacy module that is a tenant-isolation break, not
--      merely a data-quality one.
--
-- Closed value sets are named CHECK constraints on TEXT rather than
-- CREATE TYPE enums — the repo has no enums anywhere. Each set below mirrors an
-- `as const` array in packages/sdp-helius-rings/src/constants.ts, which is the
-- runtime source of truth; the CHECK is the schema-level twin. These sets are
-- closed by compile-time unions, so widening one already requires a code
-- change, and pairing it with a migration is the point rather than the cost.
-- (Contrast the ADR 0001 asset-profiles pattern used for open registries like
-- earn providers, which deliberately carry no CHECK.)
--
-- Timestamps are TEXT ISO-8601 via sdp_iso_now() — never NOW(), never
-- timestamptz. Amounts are string-encoded u64, never numeric/float.


-- ==========================================================================
-- Wallets
-- ==========================================================================

-- Binds one Rings shielded identity to one SDP custody wallet within a project.
--   status: pending until the identity is provisioned, ready once it is,
--   paused when runtime health goes red and the module stops accepting work.
--   material_tag records whether the key material behind this wallet is real
--   ('live') or a placeholder from a pre-integration environment
--   ('simulated'), so a simulated wallet can never be mistaken for a funded one.
CREATE TABLE IF NOT EXISTS helius_rings_wallets (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    sdp_wallet_id TEXT NOT NULL,
    name TEXT NOT NULL,
    network TEXT NOT NULL DEFAULT 'devnet',
    status TEXT NOT NULL DEFAULT 'pending',
    shielded_address TEXT,
    sync_cursor TEXT,
    material_tag TEXT NOT NULL DEFAULT 'simulated',
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    -- The schema-level twin of the runtime devnet guard in HeliusRingsService.
    -- Rings is devnet-only for this scope; going to mainnet is a deliberate
    -- forward migration that drops this constraint, not a config flip.
    CONSTRAINT helius_rings_wallets_network_check CHECK (network = 'devnet'),
    CONSTRAINT helius_rings_wallets_status_check
        CHECK (status IN ('pending', 'ready', 'paused')),
    CONSTRAINT helius_rings_wallets_material_tag_check
        CHECK (material_tag IN ('simulated', 'live')),
    -- Lets helius_rings_operations FK on (wallet_id, organization_id,
    -- project_id) so an operation can never point at a wallet in a different
    -- org/project. Mirrors earn_positions_id_org_project_key in 0048.
    CONSTRAINT helius_rings_wallets_id_org_project_key
        UNIQUE (id, organization_id, project_id),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- One Rings wallet per SDP custody wallet per project: provisioning is
-- idempotent, and a second shielded identity over the same custody wallet
-- would split its shielded balance across two identities that cannot see
-- each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_helius_rings_wallets_project_sdp
    ON helius_rings_wallets(project_id, sdp_wallet_id);

CREATE INDEX IF NOT EXISTS idx_helius_rings_wallets_project_created
    ON helius_rings_wallets(project_id, created_at DESC, id DESC);


-- ==========================================================================
-- Key material
-- ==========================================================================

-- Ciphertext blobs holding viewing and nullifier material, encrypted with
-- custody-cipher (AES-256-GCM under CUSTODY_ENCRYPTION_KEY). Plaintext key
-- material never lands in this table, and repositories pass ciphertext
-- through untouched — ciphertext in, ciphertext out, never SecretRef.reveal.
--
-- key_version is the cipher key generation that sealed this blob, so a key
-- rotation can re-wrap rows without guessing which generation each one used.
CREATE TABLE IF NOT EXISTS helius_rings_key_refs (
    id TEXT PRIMARY KEY,
    wallet_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    key_version TEXT NOT NULL,
    material_tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    CONSTRAINT helius_rings_key_refs_kind_check
        CHECK (kind IN ('viewing', 'nullifier')),
    CONSTRAINT helius_rings_key_refs_material_tag_check
        CHECK (material_tag IN ('simulated', 'live')),
    FOREIGN KEY (wallet_id) REFERENCES helius_rings_wallets(id) ON DELETE CASCADE
);

-- Exactly one viewing key and one nullifier key per wallet. Provisioning
-- returns both together, so a duplicate here means a re-provision raced and
-- one of the two identities is now unreachable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_helius_rings_key_refs_wallet_kind
    ON helius_rings_key_refs(wallet_id, kind);


-- ==========================================================================
-- Zones
-- ==========================================================================

-- Named destinations within a wallet. A treasury zone holds shielded value;
-- a public zone is the declared exit point back to transparent addresses.
CREATE TABLE IF NOT EXISTS helius_rings_zones (
    id TEXT PRIMARY KEY,
    wallet_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'treasury',
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    CONSTRAINT helius_rings_zones_kind_check
        CHECK (kind IN ('treasury', 'public')),
    -- Lets operations FK on (zone_id, wallet_id) so an operation cannot
    -- reference another wallet's zone.
    CONSTRAINT helius_rings_zones_id_wallet_key UNIQUE (id, wallet_id),
    FOREIGN KEY (wallet_id) REFERENCES helius_rings_wallets(id) ON DELETE CASCADE
);

-- Zone names are the operator's handle for a destination; two zones sharing a
-- name inside one wallet makes the Send composer ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS helius_rings_zones_wallet_name_key
    ON helius_rings_zones(wallet_id, name);


-- ==========================================================================
-- Operations — the state machine
-- ==========================================================================

-- One row per shielded action, carrying its whole lifecycle. `state` is the
-- persisted state machine; transitions are applied under SELECT ... FOR UPDATE
-- inside a transaction so two workers cannot advance the same operation twice.
--
-- proof_ref is an opaque handle the gateway hands back, not proof material —
-- it is wrapped in SecretRef at the API boundary and must never be logged or
-- serialized into a response.
CREATE TABLE IF NOT EXISTS helius_rings_operations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    wallet_id TEXT NOT NULL,
    op_type TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft',
    asset_mint TEXT,
    amount_raw TEXT,
    from_addr TEXT,
    to_addr TEXT,
    zone_id TEXT,
    transfer_mode TEXT,
    intent_key TEXT NOT NULL,
    approval_request_id TEXT,
    policy_evaluation_id TEXT,
    proof_source TEXT,
    proof_ref TEXT,
    outer_tx_signature TEXT,
    photon_indexed_at TEXT,
    failure_code TEXT,
    failure_message TEXT,
    retryable BOOLEAN,
    retry_of_operation_id TEXT,
    -- Denormalized from helius_rings_timelocks so the Activity table can sort
    -- and filter by unlock time without joining. The timelocks row remains
    -- the authority; this column is a read optimization.
    timelock_unlock_at TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    CONSTRAINT helius_rings_operations_op_type_check
        CHECK (op_type IN (
            'shield',
            'transfer_registered',
            'transfer_anonymous',
            'withdraw',
            'merge',
            'timelock_create',
            'timelock_settle',
            'zone_create'
        )),
    CONSTRAINT helius_rings_operations_state_check
        CHECK (state IN (
            'draft',
            'preparing',
            'approval_required',
            'proving',
            'ready_to_sign',
            'submitted',
            'indexing',
            'completed',
            'failed'
        )),
    CONSTRAINT helius_rings_operations_proof_source_check
        CHECK (proof_source IS NULL OR proof_source IN ('simulated', 'live')),
    -- transfer_mode is derivable from op_type, and the two disagreeing is a
    -- privacy bug rather than a cosmetic one: an anonymous transfer rendered
    -- as registered tells the operator their counterparty was disclosed when
    -- it was not, or the reverse. Pin them together.
    CONSTRAINT helius_rings_operations_transfer_mode_check
        CHECK (
            (op_type = 'transfer_registered' AND transfer_mode = 'registered')
            OR (op_type = 'transfer_anonymous' AND transfer_mode = 'anonymous')
            OR (
                op_type NOT IN ('transfer_registered', 'transfer_anonymous')
                AND transfer_mode IS NULL
            )
        ),
    -- Failure detail exists exactly when the operation failed. The three
    -- columns move together: a `failed` row without a code is unactionable in
    -- the recovery UI, and a live row carrying stale failure text misreports
    -- a healthy operation as broken.
    CONSTRAINT helius_rings_operations_failure_check
        CHECK (
            (
                state = 'failed'
                AND failure_code IS NOT NULL
                AND failure_message IS NOT NULL
                AND retryable IS NOT NULL
            )
            OR (
                state <> 'failed'
                AND failure_code IS NULL
                AND failure_message IS NULL
                AND retryable IS NULL
            )
        ),
    CONSTRAINT helius_rings_operations_failure_code_check
        CHECK (
            failure_code IS NULL
            OR failure_code IN (
                'policy_denied',
                'approval_rejected',
                'proof_failed',
                'signer_failed',
                'submit_failed',
                'indexing_timeout',
                'gateway_unavailable',
                'invalid_input',
                'insufficient_balance'
            )
        ),
    -- An operation cannot be its own retry; a self-referencing lineage makes
    -- the retry-depth cap in A21 loop forever.
    CONSTRAINT helius_rings_operations_retry_not_self_check
        CHECK (retry_of_operation_id IS NULL OR retry_of_operation_id <> id),
    -- Same fixed-width-UTC pin as helius_rings_timelocks; the Activity table
    -- sorts on this column.
    CONSTRAINT helius_rings_operations_timelock_unlock_at_format_check
        CHECK (
            timelock_unlock_at IS NULL
            OR timelock_unlock_at ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
        ),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (wallet_id, organization_id, project_id)
        REFERENCES helius_rings_wallets(id, organization_id, project_id)
        ON DELETE CASCADE,
    -- Composite: the zone must belong to this operation's wallet. The SET
    -- NULL column list (Postgres 15+) clears only zone_id, not wallet_id.
    FOREIGN KEY (zone_id, wallet_id)
        REFERENCES helius_rings_zones(id, wallet_id)
        ON DELETE SET NULL (zone_id),
    -- SET NULL, never CASCADE: see decision 2 in the header.
    FOREIGN KEY (retry_of_operation_id)
        REFERENCES helius_rings_operations(id) ON DELETE SET NULL
);

-- The idempotency contract. This index is what makes retry-safety real:
-- reserveIntent() inserts with ON CONFLICT (intent_key), and on a replay it has
-- to hand back the operation already reserved rather than a second one.
--
-- Note for whoever writes that query: the conflict action must be a no-op
-- DO UPDATE, not DO NOTHING. `ON CONFLICT DO NOTHING ... RETURNING *` emits
-- zero rows on conflict, so a retry would read back null and look like a failure
-- instead of an already-reserved intent. The idiom the repo already uses for
-- this is `DO UPDATE SET updated_at = helius_rings_operations.updated_at
-- RETURNING *` — see the approval_requests insert in
-- db/repositories/policy.repository.postgres.ts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_helius_rings_operations_intent_key
    ON helius_rings_operations(intent_key);

-- Activity table: newest first. The id tiebreaker matters because operations
-- created in one request share a single sdp_iso_now() value — the lesson of
-- payment_transfers 0028-0031.
CREATE INDEX IF NOT EXISTS idx_helius_rings_operations_wallet_created
    ON helius_rings_operations(wallet_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_helius_rings_operations_project_created
    ON helius_rings_operations(project_id, created_at DESC, id DESC);

-- Partial index for the resume/poll sweep, which only ever looks at operations
-- still in flight. Terminal rows accumulate forever and would otherwise
-- dominate the index.
CREATE INDEX IF NOT EXISTS idx_helius_rings_operations_in_flight
    ON helius_rings_operations(state, updated_at)
    WHERE state IN (
        'preparing',
        'approval_required',
        'proving',
        'ready_to_sign',
        'submitted',
        'indexing'
    );

CREATE INDEX IF NOT EXISTS idx_helius_rings_operations_retry_of
    ON helius_rings_operations(retry_of_operation_id)
    WHERE retry_of_operation_id IS NOT NULL;


-- ==========================================================================
-- Timelocks
-- ==========================================================================

-- Escrow leg of a timelock operation. One row per timelock_create operation;
-- released_at is stamped when the matching timelock_settle completes.
CREATE TABLE IF NOT EXISTS helius_rings_timelocks (
    operation_id TEXT PRIMARY KEY,
    unlock_at TEXT NOT NULL,
    released_at TEXT,
    beneficiary_addr TEXT NOT NULL,
    -- The ordering check compares text; lexical order is only chronological
    -- when every value is the fixed-width UTC shape sdp_iso_now() emits. A
    -- caller-supplied offset value ('...T23:30:00.000-01:00') would sort
    -- wrong and let an early release through, so the format is a constraint.
    CONSTRAINT helius_rings_timelocks_unlock_at_format_check
        CHECK (unlock_at ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'),
    CONSTRAINT helius_rings_timelocks_released_at_format_check
        CHECK (
            released_at IS NULL
            OR released_at ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
        ),
    CONSTRAINT helius_rings_timelocks_released_after_unlock_check
        CHECK (released_at IS NULL OR released_at >= unlock_at),
    FOREIGN KEY (operation_id)
        REFERENCES helius_rings_operations(id) ON DELETE CASCADE
);

-- The release sweep only cares about escrows still held.
CREATE INDEX IF NOT EXISTS idx_helius_rings_timelocks_pending
    ON helius_rings_timelocks(unlock_at)
    WHERE released_at IS NULL;


-- ==========================================================================
-- Event feed
-- ==========================================================================

-- Immutable, append-only timeline powering the operation detail panel.
--
-- payload is JSONB rather than the TEXT the design sketch called for: the
-- domain type is `payload?: unknown`, and JSONB both validates the JSON on
-- write and stays queryable. It must never contain SecretRef material —
-- event.service.ts in private-channels is the precedent, redacting the payload
-- before persist. `kind` is intentionally open TEXT: event kinds are additive
-- documentation of what happened, and gating each new one behind a migration
-- would be the reason someone logs it somewhere worse instead.
CREATE TABLE IF NOT EXISTS helius_rings_events (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload JSONB,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    CONSTRAINT helius_rings_events_payload_is_object_check
        CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
    FOREIGN KEY (operation_id)
        REFERENCES helius_rings_operations(id) ON DELETE CASCADE
);

-- Timeline order, oldest first, with the id tiebreaker for events appended
-- inside a single transition.
CREATE INDEX IF NOT EXISTS idx_helius_rings_events_operation_created
    ON helius_rings_events(operation_id, created_at, id);


-- ==========================================================================
-- Asset allowlist (platform-level)
-- ==========================================================================

-- Which mints Rings will move. Platform-level, not tenant-scoped: the
-- constraint is what the shielded pool and prover actually support, which is a
-- property of the deployment rather than of a customer. Adding a mint requires
-- joint validation with Helius — an unsupported mint does not fail loudly, it
-- produces an operation that proves and submits and then never indexes.
CREATE TABLE IF NOT EXISTS helius_rings_asset_allowlist (
    mint TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    decimals INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    CONSTRAINT helius_rings_asset_allowlist_status_check
        CHECK (status IN ('active', 'disabled')),
    CONSTRAINT helius_rings_asset_allowlist_decimals_check
        CHECK (decimals BETWEEN 0 AND 18)
);

-- Seed: wrapped SOL and devnet USDC only. Both mints and their decimals are
-- taken from packages/sdp-types/src/well-known-tokens.ts (SOL_MINT at 9
-- decimals; USDC devnet at 6) rather than retyped, so the allowlist cannot
-- drift from the registry the rest of the platform resolves against.
--
-- ON CONFLICT DO NOTHING keeps the re-run a no-op and, more importantly, means
-- this migration never revives a mint an operator has since disabled.
INSERT INTO helius_rings_asset_allowlist (mint, symbol, decimals, status)
VALUES
    ('So11111111111111111111111111111111111111112', 'SOL', 9, 'active'),
    ('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 'USDC', 6, 'active')
ON CONFLICT (mint) DO NOTHING;


-- ==========================================================================
-- Runtime health
-- ==========================================================================

-- Latest observed health of each upstream Rings depends on, one row per
-- component per project. Overwritten in place rather than appended: this is a
-- status board the diagnostics page and the red-state action gate read, not a
-- history. The event feed is where durable history lives.
CREATE TABLE IF NOT EXISTS helius_rings_runtime_health (
    project_id TEXT NOT NULL,
    component TEXT NOT NULL,
    status TEXT NOT NULL,
    observed_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    detail JSONB,
    PRIMARY KEY (project_id, component),
    CONSTRAINT helius_rings_runtime_health_component_check
        CHECK (component IN ('rpc', 'prover', 'photon', 'gateway')),
    CONSTRAINT helius_rings_runtime_health_status_check
        CHECK (status IN ('green', 'amber', 'red')),
    CONSTRAINT helius_rings_runtime_health_detail_is_object_check
        CHECK (detail IS NULL OR jsonb_typeof(detail) = 'object'),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
