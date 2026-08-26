-- One durable customer-facing Earn button per organization/project.
--
-- The strategy id is intentionally not a foreign key. earn_strategies is a
-- provider-synced catalogue cache whose delist pass deletes rows; a stale or
-- removed strategy must make the builder refuse configuration, not block the
-- catalogue sync or erase the handoff record. The authenticated write path
-- re-runs the complete money-in admission gates before accepting an id.
--
-- project_id takes the plain single-column FK every project-scoped table uses.
-- Org/project consistency is enforced at the auth layer (requireProjectId
-- serves membership-verified or key-derived projects only), and a composite FK
-- would have needed a new unique index on the hot projects table, built
-- non-concurrently inside the transactional migration path.
--
-- public_token is an unguessable bearer locator for the read-only engineering
-- handoff. The public response contains strategy/style only, never tenant ids
-- or an API key.
--
-- created_by is deliberately open TEXT rather than a user foreign key. This
-- authenticated resource accepts user, session, and API-key principals, and
-- deleting the actor must not delete or invalidate the project configuration.
--
-- accent_color keeps the CTA accent with the durable project configuration so
-- the dashboard preview and public engineering handoff render the same
-- customer treatment.

CREATE TABLE IF NOT EXISTS earn_button_configurations (
    id TEXT PRIMARY KEY,
    public_token TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    strategy_id TEXT NOT NULL,
    style TEXT NOT NULL,
    accent_color TEXT NOT NULL DEFAULT '#14F195',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    CONSTRAINT earn_button_configurations_scope_unique
        UNIQUE (organization_id, project_id),
    CONSTRAINT earn_button_configurations_public_token_unique
        UNIQUE (public_token),
    CONSTRAINT earn_button_configurations_accent_color_hex
        CHECK (accent_color ~ '^#[0-9A-Fa-f]{6}$')
);

CREATE INDEX IF NOT EXISTS idx_earn_button_configurations_strategy
    ON earn_button_configurations(strategy_id);
