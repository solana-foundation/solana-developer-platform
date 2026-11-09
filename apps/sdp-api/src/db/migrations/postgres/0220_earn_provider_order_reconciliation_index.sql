-- sdp:migration-mode: non-transactional
-- Source finality leaves provider orders open; the chain-leg outbox index excludes them.
CREATE INDEX CONCURRENTLY IF NOT EXISTS earn_provider_order_reconciliation_due
  ON earn_movements (environment, provider, reconciliation_attempted_at, created_at, id)
  WHERE execution_model = 'vault_direct' AND status = 'confirmed' AND chain_finalized_at IS NOT NULL;
