-- Expand-only: previous revisions keep their existing provider references.
-- Strategies are catalogue identities; a provider vault is an implementation.
ALTER TABLE earn_positions ADD COLUMN strategy_id TEXT;
ALTER TABLE earn_positions ADD CONSTRAINT earn_positions_strategy_fk
  FOREIGN KEY (strategy_id) REFERENCES earn_strategies(id)
  ON DELETE SET NULL NOT VALID;

ALTER TABLE earn_external_wallet_transactions
  ADD COLUMN strategy_id TEXT,
  ADD COLUMN custody_wallet_id TEXT,
  ADD COLUMN fee_mode TEXT NOT NULL DEFAULT 'wallet';
ALTER TABLE earn_external_wallet_transactions
  ADD CONSTRAINT earn_prepared_strategy_fk
    FOREIGN KEY (strategy_id) REFERENCES earn_strategies(id)
    ON DELETE SET NULL NOT VALID,
  ADD CONSTRAINT earn_prepared_custody_wallet_fk
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id)
    ON DELETE NO ACTION NOT VALID,
  ADD CONSTRAINT earn_prepared_fee_mode_check
    CHECK (fee_mode IN ('wallet', 'partner', 'sponsored')) NOT VALID;
