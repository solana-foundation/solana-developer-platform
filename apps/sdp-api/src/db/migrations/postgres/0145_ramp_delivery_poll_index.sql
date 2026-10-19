-- sdp:migration-mode: non-transactional
-- Keep the chain verifier's fair poll queue bounded as ramp history grows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_transfers_ramp_delivery_poll
  ON payment_transfers (finalization_last_polled_at ASC NULLS FIRST, id ASC)
  WHERE status = 'settling'
    AND type IN ('onramp', 'offramp')
    AND jsonb_typeof(provider_data->'providerSettlement') = 'object';
