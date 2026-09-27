ALTER TABLE dvp_trades
  ADD COLUMN IF NOT EXISTS born_frozen BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN dvp_trades.born_frozen IS
  'The create response was refused because the escrow was created frozen. A keyed retry replays that refusal while the frozen flags still say funding is blocked; a trade frozen only later keeps answering to its key.';
