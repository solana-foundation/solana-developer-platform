-- Notification center: per-user delivery preferences + the email-delivery idempotency
-- claim table. Completes the deferred half of 0050_notifications (which shipped the
-- in-app store); category/channel vocabulary lives in @sdp/types (notifications.ts).

-- Opt-out preference matrix. No row = enabled (the default); rows exist only where a
-- user changed something. `enabled` is stored explicitly (not implied by row presence)
-- so a future default-off category stays representable.
CREATE TABLE IF NOT EXISTS notification_preferences (
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    -- Open TEXT (validated in the app layer): one of @sdp/types NOTIFICATION_CATEGORIES.
    category TEXT NOT NULL,
    -- Open TEXT: one of @sdp/types NOTIFICATION_CHANNELS ('in_app' | 'email').
    channel TEXT NOT NULL,
    enabled BOOLEAN NOT NULL,
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    PRIMARY KEY (organization_id, user_id, category, channel),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Email-delivery idempotency claims (NOT an attempt log — webhook_deliveries is the
-- per-attempt log pattern; this table exists so a retried producer cannot re-send an
-- email the way it can no-op an in-app row on idx_notifications_dedupe).
CREATE TABLE IF NOT EXISTS notification_deliveries (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    -- NULL for sends without a platform recipient (direct-address notify param,
    -- counterparty receipts).
    user_id TEXT,
    -- Open TEXT: delivery channel, 'email' today.
    channel TEXT NOT NULL,
    -- Address actually used at send time.
    recipient TEXT NOT NULL,
    -- Producer idempotency handle, e.g. '<eventKey>:<userId>' or
    -- '<eventKey>:counterparty:<counterpartyId>'.
    dedupe_key TEXT NOT NULL,
    -- pending | sent | failed. A crash between claim and send strands a 'pending' row,
    -- making email at-most-once — the in-app row is the durable truth, which is the
    -- right bias for a notification email.
    status TEXT NOT NULL DEFAULT 'pending',
    provider_message_id TEXT,
    error TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    CONSTRAINT notification_deliveries_status_check
        CHECK (status IN ('pending', 'sent', 'failed')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- The claim: one delivery per (channel, dedupe_key). 'failed' rows are reclaimable
-- (retry re-attempts a genuinely failed email); 'sent'/'pending' are not.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_deliveries_dedupe
    ON notification_deliveries(channel, dedupe_key);
