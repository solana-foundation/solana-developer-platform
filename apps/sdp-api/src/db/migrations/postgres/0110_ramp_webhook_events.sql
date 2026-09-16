-- Durable inbox for verified ramp provider webhooks. A settlement event is
-- persisted here BEFORE the 200 ack, so a crash or DB blip in the background
-- apply pass can no longer lose the only settlement signal a provider will
-- send. Applied events are deleted on success; only rows still awaiting apply
-- (or exhausted) live here, which also bounds how long a raw provider payload
-- is at rest.

CREATE TABLE IF NOT EXISTS ramp_webhook_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    environment TEXT NOT NULL,
    -- The signature-verified provider payload, exactly as `verify` returned
    -- it. Replay re-runs the processor's `parse` on it, so it must stay the
    -- original bytes' JSON — never a redacted or reshaped copy.
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (sdp_iso_now()),
    updated_at TEXT NOT NULL DEFAULT (sdp_iso_now())
);

CREATE INDEX IF NOT EXISTS idx_ramp_webhook_events_pending
    ON ramp_webhook_events (created_at)
    WHERE status = 'pending';
