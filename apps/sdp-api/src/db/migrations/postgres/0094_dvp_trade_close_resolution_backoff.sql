ALTER TABLE dvp_trades
  ADD COLUMN IF NOT EXISTS close_resolution_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS close_resolution_after TEXT;
