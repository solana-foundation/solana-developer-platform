-- Managed outbound-webhook registry (deferred from the Phase 5 send_webhook MVP).
-- webhook_endpoints: per-project endpoints with server-generated signing secrets held
-- as credential-secret-store handles (the asset_workflows.definition.actionSecret
-- precedent — opaque JSONB, no typed secret columns). The row id is stable: workflow
-- rules reference endpointId, so rotation swaps handles in place (current → previous
-- with a grace expiry) instead of the provider_credentials new-row lineage.
-- webhook_deliveries: per-attempt delivery log; workflow_executions only keeps the
-- last attempt's aggregate state, so this is the only durable request/response record.

CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    -- https-only, SSRF-checked at save time; immutable after create (make a new endpoint).
    url TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    -- StoredCredentialSecret handles (see services/credential-secret-store.ts).
    secret_storage JSONB NOT NULL,
    previous_secret_storage JSONB,
    previous_secret_expires_at TEXT,
    secret_version INTEGER NOT NULL DEFAULT 1,
    -- Actor id: a user OR an API key, so no FK (the asset_workflows precedent).
    created_by TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT webhook_endpoints_status_check CHECK (status IN ('active', 'disabled')),
    CONSTRAINT webhook_endpoints_secret_is_object
        CHECK (jsonb_typeof(secret_storage) = 'object'),
    CONSTRAINT webhook_endpoints_previous_secret_is_object
        CHECK (previous_secret_storage IS NULL OR jsonb_typeof(previous_secret_storage) = 'object'),
    -- The grace expiry travels with the displaced secret: both set or both absent.
    CONSTRAINT webhook_endpoints_previous_secret_pair_check
        CHECK ((previous_secret_storage IS NULL) = (previous_secret_expires_at IS NULL)),
    CONSTRAINT webhook_endpoints_secret_version_positive CHECK (secret_version > 0)
);

-- Registry list per project, newest first.
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_org_project_created
    ON webhook_endpoints(organization_id, project_id, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    -- Nullable refs: the delivery log outlives execution purges and rule soft-deletes.
    execution_id TEXT,
    workflow_id TEXT,
    trigger_type TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    manual BOOLEAN NOT NULL DEFAULT FALSE,
    redelivery_of TEXT,
    -- Byte-exact signed payload (TEXT, not JSONB — JSONB normalization would break
    -- redelivery's signature byte-identity). Capped at 65,536 chars + flag.
    request_body TEXT NOT NULL,
    request_body_truncated BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL,
    response_status INTEGER,
    -- Truncated to 4,096 chars; the flag records that the receiver sent more (the UI
    -- would otherwise have to guess from the length).
    response_body TEXT,
    response_body_truncated BOOLEAN NOT NULL DEFAULT FALSE,
    error TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    FOREIGN KEY (execution_id) REFERENCES workflow_executions(id) ON DELETE SET NULL,
    FOREIGN KEY (redelivery_of) REFERENCES webhook_deliveries(id) ON DELETE SET NULL,
    CONSTRAINT webhook_deliveries_status_check CHECK (status IN ('succeeded', 'failed'))
);

-- Delivery-log view per endpoint, newest first (mirrors idx_workflow_executions_token_created).
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint_created
    ON webhook_deliveries(organization_id, project_id, endpoint_id, created_at DESC);

-- Retention: batched `DELETE ... WHERE created_at < cutoff` (purge job deferred).
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created
    ON webhook_deliveries(created_at);

-- FK maintenance for the ON DELETE SET NULL paths.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_execution
    ON webhook_deliveries(execution_id)
    WHERE execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_redelivery_of
    ON webhook_deliveries(redelivery_of)
    WHERE redelivery_of IS NOT NULL;

-- FK maintenance for the CASCADE paths. The composite listing indexes lead with
-- organization_id (and the endpoints one is partial on deleted_at), so a project purge
-- or an endpoint hard-delete couldn't use them and would seq-scan — and deliveries is
-- the table that grows.
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_project
    ON webhook_endpoints(project_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_project
    ON webhook_deliveries(project_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint
    ON webhook_deliveries(endpoint_id);
