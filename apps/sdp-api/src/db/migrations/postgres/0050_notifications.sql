-- In-app notifications: a durable, per-user notification store powering the dashboard
-- bell. First writer is the workflow `notify` action; other producers plug in later.
-- (Per-user delivery preferences + multi-channel dispatch are a deferred follow-up.)

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    -- Open TEXT (validated in the app layer), matching the project's category-column
    -- convention. e.g. 'workflow_execution'.
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    -- Optional deep-link target (e.g. resource_type='token', resource_id=<tokenId>).
    resource_type TEXT,
    resource_id TEXT,
    -- Structured facts for client-side (localized) rendering; title/body are the
    -- server-composed fallback.
    params JSONB,
    -- Producer-supplied idempotency handle (e.g. the workflow execution id) so a
    -- retried producer cannot duplicate a user's notification.
    dedupe_key TEXT,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- One notification per (user, dedupe_key): retried producers no-op instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
    ON notifications(user_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;

-- Bell inbox: a user's notifications in an org, unread-first, newest-first.
CREATE INDEX IF NOT EXISTS idx_notifications_user
    ON notifications(organization_id, user_id, created_at DESC);

-- Unread-count badge (partial index on the unread rows only).
CREATE INDEX IF NOT EXISTS idx_notifications_unread
    ON notifications(organization_id, user_id)
    WHERE read_at IS NULL;
