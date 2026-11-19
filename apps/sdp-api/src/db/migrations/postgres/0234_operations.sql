-- Additive coordination only. Earn movements and provider requests remain the
-- source of truth for economic settlement. Retain the original project identity
-- without a cascading project FK so deleting a project cannot erase recovery.
CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
    kind TEXT NOT NULL CHECK (kind IN ('earn.deposit', 'earn.withdraw')),
    status TEXT NOT NULL CHECK (status IN (
        'prepared', 'queued', 'awaiting_signature', 'submitted',
        'settling', 'completed', 'failed', 'cancelled'
    )),
    intent JSONB NOT NULL CHECK (jsonb_typeof(intent) = 'object' AND intent ->> 'kind' = kind),
    source JSONB NOT NULL CHECK (jsonb_typeof(source) = 'object'),
    principal JSONB NOT NULL CHECK (jsonb_typeof(principal) = 'object'),
    action_principal JSONB NOT NULL CHECK (jsonb_typeof(action_principal) = 'object'),
    request_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    action_id TEXT NOT NULL,
    action_version INTEGER NOT NULL DEFAULT 1 CHECK (action_version > 0),
    action_purpose TEXT NOT NULL DEFAULT 'execute' CHECK (action_purpose IN ('execute', 'cancel')),
    next_action JSONB,
    terms JSONB NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
    build_ref JSONB,
    resource_ref JSONB,
    error JSONB,
    cancel_requested_at TEXT,
    claim_token TEXT,
    claim_until TIMESTAMPTZ,
    fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    CONSTRAINT operations_request_unique UNIQUE
        (organization_id, project_id, environment, kind, request_key),
    CONSTRAINT operations_claim_pair CHECK
        ((claim_token IS NULL) = (claim_until IS NULL)),
    CONSTRAINT operations_terminal_action CHECK
        (status NOT IN ('completed', 'failed', 'cancelled') OR next_action IS NULL)
);

CREATE INDEX operations_project_history ON operations
    (organization_id, project_id, environment, created_at DESC, id DESC);

CREATE TABLE operation_attempts (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES operations(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
    action_id TEXT NOT NULL,
    action_version INTEGER NOT NULL CHECK (action_version > 0),
    principal JSONB NOT NULL CHECK (jsonb_typeof(principal) = 'object'),
    build_ref JSONB,
    signed_transaction TEXT,
    signature TEXT,
    last_valid_block_height TEXT,
    dispatch_started_at TEXT,
    execution_requested_at TEXT,
    audit_intent_id TEXT,
    observation_only BOOLEAN NOT NULL DEFAULT FALSE,
    proposal_binding JSONB,
    resource_ref JSONB,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    CONSTRAINT operation_attempts_action_unique UNIQUE
        (operation_id, action_id, action_version),
    CONSTRAINT operation_attempts_signed_pair CHECK (
        (signed_transaction IS NULL AND signature IS NULL AND last_valid_block_height IS NULL)
        OR
        (signed_transaction IS NOT NULL AND signature IS NOT NULL AND last_valid_block_height IS NOT NULL)
    )
);

-- Scope and economic intent are never changed by a lease holder or refresher.
CREATE FUNCTION sdp_operation_immutable_intent() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.organization_id, NEW.project_id, NEW.environment, NEW.kind,
           NEW.intent, NEW.source, NEW.principal, NEW.request_key, NEW.fingerprint)
       IS DISTINCT FROM
       ROW(OLD.organization_id, OLD.project_id, OLD.environment, OLD.kind,
           OLD.intent, OLD.source, OLD.principal, OLD.request_key, OLD.fingerprint) THEN
        RAISE EXCEPTION 'Operation intent and initiating identity are immutable';
    END IF;
    IF OLD.cancel_requested_at IS NOT NULL AND
       NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at THEN
        RAISE EXCEPTION 'Operation cancellation intent is immutable';
    END IF;
    IF NEW.action_id = OLD.action_id AND NEW.action_principal IS DISTINCT FROM OLD.action_principal THEN
        RAISE EXCEPTION 'Operation action principal is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER operations_immutable_intent BEFORE UPDATE ON operations
    FOR EACH ROW EXECUTE FUNCTION sdp_operation_immutable_intent();

-- Once a cancelled or expired signature is observation-only, no restarted
-- worker may restore permission to broadcast it.
CREATE FUNCTION sdp_operation_attempt_observation_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.execution_requested_at IS NOT NULL AND
       NEW.execution_requested_at IS DISTINCT FROM OLD.execution_requested_at THEN
        RAISE EXCEPTION 'Operation execution request is immutable';
    END IF;
    IF OLD.observation_only AND NOT NEW.observation_only THEN
        RAISE EXCEPTION 'Operation observation-only restriction is irreversible';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER operation_attempts_observation_only BEFORE UPDATE ON operation_attempts
    FOR EACH ROW EXECUTE FUNCTION sdp_operation_attempt_observation_only();

-- Audit admission commits with acceptance before worker effects.
CREATE FUNCTION sdp_operation_attempt_audit_intent() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.audit_intent_id IS NOT NULL AND
       NEW.audit_intent_id IS DISTINCT FROM OLD.audit_intent_id THEN
        RAISE EXCEPTION 'Operation audit admission is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER operation_attempts_audit_intent BEFORE UPDATE ON operation_attempts
    FOR EACH ROW EXECUTE FUNCTION sdp_operation_attempt_audit_intent();

ALTER TABLE operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON operations
    USING (sdp_tenant_isolation_allows(organization_id))
    WITH CHECK (sdp_tenant_isolation_allows(organization_id));

ALTER TABLE operation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON operation_attempts
    USING (sdp_tenant_isolation_allows(organization_id))
    WITH CHECK (sdp_tenant_isolation_allows(organization_id));
