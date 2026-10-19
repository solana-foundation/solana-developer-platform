-- sdp:migration-mode: non-transactional
-- Bound the seven-day discharged-row prune without blocking live writers.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ramp_webhook_events_discharged_at
  ON ramp_webhook_events (discharged_at)
  WHERE status = 'discharged';
