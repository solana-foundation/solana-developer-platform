-- HOO-2299: emails to an organization's admins when money moves or its configuration changes.
-- The Worker derives each alert from rows that already record the event (the audit ledger, the
-- payment rows) and keeps here what it decided to send and what it sent: Iterable takes no
-- idempotency key, so a delivery's sent_at is what stops a retry from emailing an admin twice.

-- One alert per source event: `audit:<ledger_sequence>` for an audit entry, or
-- `money:<project>:<window start>` for a project's money-movement digest.
CREATE TABLE admin_alerts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    source_key TEXT NOT NULL UNIQUE,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    CONSTRAINT admin_alerts_details_is_object CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX admin_alerts_organization_created ON admin_alerts (organization_id, created_at DESC);

-- One row per admin an alert goes to, snapshotted when the alert is written. A send claims the
-- row for a lease first, so two Worker runs never send it at once; a lost answer after Iterable
-- accepted it is the one case that can still send twice.
CREATE TABLE admin_alert_deliveries (
    alert_id TEXT NOT NULL REFERENCES admin_alerts(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_until TEXT,
    last_error TEXT,
    sent_at TEXT,
    abandoned_at TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    PRIMARY KEY (alert_id, user_id),
    CONSTRAINT admin_alert_deliveries_attempts_nonnegative CHECK (attempts >= 0)
);

CREATE INDEX admin_alert_deliveries_unsent
    ON admin_alert_deliveries (created_at)
    WHERE sent_at IS NULL AND abandoned_at IS NULL;

-- How far the Worker has read each source: the audit ledger by `ledger_sequence` (written under
-- the ledger's lock, so sequences commit in order), money by the end of the last digest window
-- (epoch milliseconds). Seeded at the present, so the history before this migration emails nobody.
CREATE TABLE admin_alert_cursors (
    source TEXT PRIMARY KEY,
    position BIGINT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    CONSTRAINT admin_alert_cursors_source_check CHECK (source IN ('audit_ledger', 'money'))
);

INSERT INTO admin_alert_cursors (source, position)
VALUES
    ('audit_ledger', COALESCE((SELECT max(ledger_sequence) FROM audit_logs), 0)),
    ('money', (extract(epoch FROM now()) * 1000)::bigint);

ALTER TABLE admin_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON admin_alerts
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));

ALTER TABLE admin_alert_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_alert_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON admin_alert_deliveries
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));

-- Only the Worker reads or moves a cursor; no tenant has one.
ALTER TABLE admin_alert_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_alert_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_system_only ON admin_alert_cursors
  USING (sdp_tenant_isolation_is_privileged())
  WITH CHECK (sdp_tenant_isolation_is_privileged());
