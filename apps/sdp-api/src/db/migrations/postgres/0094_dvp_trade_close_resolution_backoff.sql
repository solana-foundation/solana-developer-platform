ALTER TABLE dvp_trades
  ADD COLUMN IF NOT EXISTS close_resolution_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS close_resolution_after TEXT;

COMMENT ON COLUMN dvp_trades.close_resolution_attempts IS
  'Number of capped close-history scans used to calculate reconciliation backoff.';
COMMENT ON COLUMN dvp_trades.close_resolution_after IS
  'ISO timestamp before which close-history resolution should not run again.';
