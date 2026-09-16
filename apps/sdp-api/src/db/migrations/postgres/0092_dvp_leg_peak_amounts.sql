ALTER TABLE dvp_trades
  ADD COLUMN IF NOT EXISTS escrow_a_peak_amount TEXT,
  ADD COLUMN IF NOT EXISTS escrow_b_peak_amount TEXT;

COMMENT ON COLUMN dvp_trades.escrow_a_peak_amount IS
  'Highest observed escrow balance while the trade was open; a later lower balance is a depositor ReclaimDvp.';
COMMENT ON COLUMN dvp_trades.escrow_b_peak_amount IS
  'Highest observed escrow balance while the trade was open; a later lower balance is a depositor ReclaimDvp.';
