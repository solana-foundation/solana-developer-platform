-- Durable workflow execution ledger + retry state, modeled on the recurring-payment
-- lifecycle attempts table (0017). Doubles as the execution log (Ticket 3): every
-- trigger match becomes a durable row before any action runs, so the engine is
-- crash-safe and retries are inspectable. See Phase 5 plan.

CREATE TABLE IF NOT EXISTS workflow_executions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    action_type TEXT NOT NULL,
    -- awaiting_review → pending → processing → succeeded | failed | cancelled
    status TEXT NOT NULL DEFAULT 'pending',
    -- Derived from (workflow_id + trigger event identity); dedupes re-delivered events.
    idempotency_key TEXT NOT NULL,
    trigger_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_attempt_at TEXT,
    locked_at TEXT,
    error TEXT,
    -- Who approved/rejected a held execution. The engine's own audit rows carry the
    -- system actor, so without these there is no record of which human authorized an
    -- irreversible action (mint/burn/seize/force_burn).
    decided_by TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (workflow_id) REFERENCES asset_workflows(id) ON DELETE CASCADE,
    CONSTRAINT workflow_executions_status_check
        CHECK (status IN ('awaiting_review', 'pending', 'processing', 'succeeded', 'failed', 'cancelled')),
    CONSTRAINT workflow_executions_payload_is_object
        CHECK (jsonb_typeof(trigger_payload) = 'object'),
    CONSTRAINT workflow_executions_result_is_object
        CHECK (jsonb_typeof(result) = 'object')
);

-- One live execution per (workflow, trigger event): re-delivered webhooks are no-ops.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_executions_idempotency
    ON workflow_executions(workflow_id, idempotency_key);

-- Cron poll: due + retryable executions, oldest first (created_at covers the sort).
CREATE INDEX IF NOT EXISTS idx_workflow_executions_due
    ON workflow_executions(status, next_attempt_at, created_at)
    WHERE status IN ('pending', 'processing');

-- Execution-log view per workflow.
CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow_created
    ON workflow_executions(workflow_id, created_at DESC);

-- The dashboard's execution-log query: newest executions for an asset (and its COUNT).
CREATE INDEX IF NOT EXISTS idx_workflow_executions_token_created
    ON workflow_executions(organization_id, project_id, token_id, created_at DESC);
