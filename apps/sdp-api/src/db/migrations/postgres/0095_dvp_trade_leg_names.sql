ALTER TABLE dvp_trades
  ADD COLUMN IF NOT EXISTS name_a TEXT,
  ADD COLUMN IF NOT EXISTS name_b TEXT;

COMMENT ON COLUMN dvp_trades.name_a IS
  'Token name read from mint metadata at create, or the well-known registry; null when neither has one.';

COMMENT ON COLUMN dvp_trades.name_b IS
  'Token name read from mint metadata at create, or the well-known registry; null when neither has one.';
