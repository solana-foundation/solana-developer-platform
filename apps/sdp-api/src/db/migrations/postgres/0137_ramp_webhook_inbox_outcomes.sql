-- Keep the signed body until apply so malformed but authentic deliveries are
-- durable. Existing JSONB rows continue to replay through the legacy payload.
ALTER TABLE ramp_webhook_events
  ADD COLUMN IF NOT EXISTS raw_body TEXT,
  ADD COLUMN IF NOT EXISTS provider_event_id TEXT,
  ADD COLUMN IF NOT EXISTS apply_outcome TEXT,
  ADD COLUMN IF NOT EXISTS discharged_at TEXT;

ALTER TABLE ramp_webhook_events ALTER COLUMN payload DROP NOT NULL;

ALTER TABLE ramp_webhook_events
  ADD CONSTRAINT ramp_webhook_events_body_check
  CHECK (raw_body IS NOT NULL OR payload IS NOT NULL);

ALTER TABLE ramp_webhook_events
  DROP CONSTRAINT IF EXISTS ramp_webhook_events_status_check;

ALTER TABLE ramp_webhook_events
  ADD CONSTRAINT ramp_webhook_events_status_check
  CHECK (status IN ('pending', 'failed', 'discharged'));

ALTER TABLE ramp_webhook_events
  ADD CONSTRAINT ramp_webhook_events_apply_outcome_check
  CHECK (apply_outcome IS NULL OR apply_outcome IN (
    'applied', 'ignored', 'unmatched', 'refused', 'discarded',
    'invalid', 'retryable_error'
  ));
