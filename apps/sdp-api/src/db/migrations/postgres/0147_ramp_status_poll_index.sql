-- sdp:migration-mode: non-transactional
-- Keep the status pull's per-provider queue bounded as ramp history grows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_transfers_ramp_status_poll
  ON payment_transfers (provider, provider_status_last_polled_at ASC NULLS FIRST, created_at ASC, id ASC)
  WHERE type IN ('onramp', 'offramp')
    AND status IN ('pending', 'processing', 'awaiting_payment', 'settling', 'expired');
