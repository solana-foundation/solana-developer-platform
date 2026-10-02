-- sdp:migration-mode: non-transactional
--
-- Receipt repair (claimUnvaluedKaminoDeposits) scans finalized Kamino deposits
-- with no observed receipt, never-attempted rows first, then oldest attempt.
--
-- CONCURRENTLY for the same reason as 0073 and 0100: earn_movements is the
-- live, append-heavy ledger, and a plain CREATE INDEX would block deposit and
-- withdrawal writes for the whole build. Split from 0121 because the runner
-- applies a concurrent build outside the migration transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_earn_movements_kamino_receipt_repair
  ON earn_movements ((reconciliation_attempted_at IS NOT NULL),
                    COALESCE(reconciliation_attempted_at, settled_at), id)
  WHERE execution_model = 'vault_direct' AND provider = 'kamino'
    AND direction = 'deposit' AND status = 'finalized'
    AND deposit_receipt_observed_at IS NULL AND signature IS NOT NULL;
