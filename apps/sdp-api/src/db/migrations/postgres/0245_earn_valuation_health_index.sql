-- sdp:migration-mode: non-transactional
-- Health reads unresolved valuations, never the growing finalized history.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_earn_valuation_health
    ON earn_movements(environment, settled_at)
    WHERE execution_model = 'vault_direct' AND status = 'finalized'
      AND signature IS NOT NULL
      AND ((direction = 'withdrawal' AND token_amount_settled IS NULL)
        OR (provider = 'kamino' AND direction = 'deposit' AND deposit_receipt_observed_at IS NULL));
