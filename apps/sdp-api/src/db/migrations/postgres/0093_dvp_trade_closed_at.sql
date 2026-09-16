ALTER TABLE dvp_trades
  ADD COLUMN IF NOT EXISTS closed_at TEXT;

UPDATE dvp_trades
   SET closed_at = updated_at
 WHERE closed_at IS NULL
   AND status IN ('settled', 'cancelled', 'rejected', 'closed_unknown');

COMMENT ON COLUMN dvp_trades.closed_at IS
  'When the trade was first observed or recorded in a closed status (settled, cancelled, rejected, closed_unknown). Set once, never moved; keys the late-deposit sweep window.';
