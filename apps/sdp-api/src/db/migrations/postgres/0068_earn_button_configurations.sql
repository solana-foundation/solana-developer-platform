-- One durable customer-facing Earn button per organization/project.
--
-- The strategy id is intentionally not a foreign key. earn_strategies is a
-- provider-synced catalogue cache whose delist pass deletes rows; a stale or
-- removed strategy must make the builder refuse configuration, not block the
-- catalogue sync or erase the handoff record. The authenticated write path
-- re-runs the complete money-in admission gates before accepting an id.
--
-- public_token is an unguessable bearer locator for the read-only engineering
-- handoff. The public response contains strategy/style only, never tenant ids
-- or an API key.
--
-- created_by is deliberately open TEXT rather than a user foreign key. This
-- authenticated resource accepts user, session, and API-key principals, and
-- deleting the actor must not delete or invalidate the project configuration.

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_id_organization
    ON projects(id, organization_id);

CREATE TABLE IF NOT EXISTS earn_button_configurations (
    id TEXT PRIMARY KEY,
    public_token TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    style TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id)
        ON DELETE CASCADE,
    CONSTRAINT earn_button_configurations_scope_unique
        UNIQUE (organization_id, project_id),
    CONSTRAINT earn_button_configurations_public_token_unique
        UNIQUE (public_token)
);

CREATE INDEX IF NOT EXISTS idx_earn_button_configurations_strategy
    ON earn_button_configurations(strategy_id);
