-- Common unsigned queue builds retain their signing source and exact fee mode.
-- Defaults preserve external-wallet builds written by the previous image.
ALTER TABLE earn_external_wallet_withdrawal_request_transactions
  ADD COLUMN custody_wallet_id TEXT,
  ADD COLUMN strategy_id TEXT,
  ADD COLUMN fee_mode TEXT NOT NULL DEFAULT 'wallet'
    CHECK (fee_mode IN ('wallet', 'partner', 'sponsored'));
ALTER TABLE earn_external_wallet_withdrawal_request_transactions
  ADD CONSTRAINT earn_queued_build_custody_wallet_fkey
  FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id) NOT VALID;
ALTER TABLE earn_external_wallet_withdrawal_request_transactions
  ADD CONSTRAINT earn_queued_build_strategy_fkey
  FOREIGN KEY (strategy_id) REFERENCES earn_strategies(id) NOT VALID;

-- Expand the prior request shape: an unsigned discovery build can retain its
-- catalogue identity until the verified signed request claims a position.
ALTER TABLE earn_external_wallet_withdrawal_request_transactions
  DROP CONSTRAINT earn_external_wallet_withdrawal_request_transactions_request_shape_check,
  ADD CONSTRAINT earn_external_wallet_withdrawal_request_transactions_request_shape_check
  CHECK (
    (action = 'request' AND withdrawal_request_id IS NULL
      AND (position_id IS NOT NULL OR strategy_id IS NOT NULL)
      AND shares IS NOT NULL AND quoted_assets IS NOT NULL
      AND share_decimals IS NOT NULL AND asset_decimals IS NOT NULL
      AND (
        (mechanism = 'solver_queue'
          AND intermediate_mint IS NULL AND intermediate_amount IS NULL
          AND discount_bps IS NOT NULL
          AND maturity_timestamp IS NOT NULL AND deadline_timestamp IS NOT NULL)
        OR
        (mechanism = 'operator_redemption'
          AND intermediate_mint IS NOT NULL AND intermediate_amount IS NOT NULL
          AND discount_bps IS NULL
          AND maturity_timestamp IS NULL AND deadline_timestamp IS NULL)
      ))
    OR
    (action = 'cancel' AND withdrawal_request_id IS NOT NULL
      AND shares IS NULL AND quoted_assets IS NULL
      AND share_decimals IS NULL AND asset_decimals IS NULL
      AND intermediate_mint IS NULL AND intermediate_amount IS NULL
      AND discount_bps IS NULL
      AND maturity_timestamp IS NULL AND deadline_timestamp IS NULL)
  ) NOT VALID;
