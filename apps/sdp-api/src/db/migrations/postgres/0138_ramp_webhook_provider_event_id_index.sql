-- sdp:migration-mode: non-transactional
-- Dedupe only provider-issued event ids; providers without one keep NULL.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ramp_webhook_events_provider_event_id_unique
  ON ramp_webhook_events (provider, environment, provider_event_id)
  WHERE status <> 'archived' AND provider_event_id IS NOT NULL;
