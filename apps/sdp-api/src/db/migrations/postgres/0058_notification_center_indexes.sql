-- FK-cascade support indexes for the notification-center tables (0057). Deleting a
-- user (or an organization) cascades into these tables; without a matching index each
-- deleted parent row forces a sequential scan of the whole child table.
-- notification_preferences' organization_id is already the PK's leading column;
-- notification_deliveries' only index was the (channel, dedupe_key) claim unique.

CREATE INDEX IF NOT EXISTS idx_notification_preferences_user
    ON notification_preferences(user_id);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_org
    ON notification_deliveries(organization_id);
