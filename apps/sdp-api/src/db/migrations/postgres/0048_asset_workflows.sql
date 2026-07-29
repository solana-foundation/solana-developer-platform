-- Issuer-configured "WHEN X → THEN Y (GUARD Z)" automation rules, asset-scoped.
-- trigger_type/action_type are open TEXT validated in the app layer against the CODE
-- catalog (@sdp/issuance/workflows) — no migration to add a trigger/action, mirroring
-- how asset_category/asset_type are validated. See Phase 5 plan.

CREATE TABLE IF NOT EXISTS asset_workflows (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    action_type TEXT NOT NULL,
    -- Rule definition: guard/condition + action params + retry policy.
    definition JSONB NOT NULL DEFAULT '{}'::jsonb,
    version INTEGER NOT NULL DEFAULT 1,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    review_mode TEXT NOT NULL DEFAULT 'auto',
    created_by TEXT,
    -- Soft delete: a hard DELETE would cascade into workflow_executions and erase the
    -- rule's run history. Deleted rules disappear from every read path but keep it.
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (token_id) REFERENCES issued_tokens(id) ON DELETE CASCADE,
    CONSTRAINT asset_workflows_review_mode_check
        CHECK (review_mode IN ('auto', 'manual')),
    CONSTRAINT asset_workflows_definition_is_object
        CHECK (jsonb_typeof(definition) = 'object')
);

-- Dispatcher hot path: enabled rules for a project + trigger type.
CREATE INDEX IF NOT EXISTS idx_asset_workflows_project_trigger_enabled
    ON asset_workflows(organization_id, project_id, trigger_type)
    WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_asset_workflows_token
    ON asset_workflows(token_id) WHERE enabled = TRUE;
