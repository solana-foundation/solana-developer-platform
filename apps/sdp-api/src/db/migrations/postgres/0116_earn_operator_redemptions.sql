-- Generalize the durable async-withdrawal ledger for issuer/operator par
-- redemptions without changing the existing Veda solver-queue contract.
--
-- `solver_queue` keeps its discount/maturity/deadline terms. An
-- `operator_redemption` records the intermediate token delegated to the
-- provider (Hastra wYLDS) and has no invented queue clock or discount.

ALTER TABLE earn_vault_withdrawal_requests
  ADD COLUMN IF NOT EXISTS mechanism TEXT NOT NULL DEFAULT 'solver_queue',
  ADD COLUMN IF NOT EXISTS intermediate_mint TEXT,
  ADD COLUMN IF NOT EXISTS intermediate_amount TEXT;

ALTER TABLE earn_vault_withdrawal_requests
  ALTER COLUMN discount_bps DROP NOT NULL,
  ALTER COLUMN maturity_timestamp DROP NOT NULL,
  ALTER COLUMN deadline_timestamp DROP NOT NULL;

ALTER TABLE earn_vault_withdrawal_requests
  DROP CONSTRAINT IF EXISTS earn_vault_withdrawal_requests_discount_check,
  DROP CONSTRAINT IF EXISTS earn_vault_withdrawal_requests_timestamps_check;

ALTER TABLE earn_vault_withdrawal_requests
  ADD CONSTRAINT earn_vault_withdrawal_requests_mechanism_check
    CHECK (mechanism IN ('solver_queue', 'operator_redemption')),
  ADD CONSTRAINT earn_vault_withdrawal_requests_mechanism_terms_check
    CHECK (
      (
        mechanism = 'solver_queue'
        AND discount_bps IS NOT NULL
        AND discount_bps BETWEEN 0 AND 10000
        AND intermediate_mint IS NULL
        AND intermediate_amount IS NULL
        AND maturity_timestamp IS NOT NULL
        AND deadline_timestamp IS NOT NULL
        AND maturity_timestamp = TRUNC(maturity_timestamp)
        AND deadline_timestamp = TRUNC(deadline_timestamp)
        AND maturity_timestamp >= 0
        AND deadline_timestamp > maturity_timestamp
      )
      OR
      (
        mechanism = 'operator_redemption'
        AND discount_bps IS NULL
        AND maturity_timestamp IS NULL
        AND deadline_timestamp IS NULL
        AND intermediate_mint IS NOT NULL
        AND intermediate_amount IS NOT NULL
        AND LENGTH(intermediate_mint) BETWEEN 32 AND 44
        AND LENGTH(intermediate_amount) BETWEEN 1 AND 128
        AND intermediate_amount ~ '^\d+(\.\d+)?$'
        AND intermediate_amount ~ '[1-9]'
      )
    ),
  ADD CONSTRAINT earn_vault_withdrawal_requests_chain_values_check
    CHECK (
      (nonce IS NULL OR (
        nonce = TRUNC(nonce)
        AND nonce BETWEEN 0 AND 18446744073709551615
      ))
      AND (creation_timestamp IS NULL OR (
        creation_timestamp = TRUNC(creation_timestamp)
        AND creation_timestamp >= 0
      ))
    );

ALTER TABLE earn_external_wallet_withdrawal_request_transactions
  ADD COLUMN IF NOT EXISTS mechanism TEXT NOT NULL DEFAULT 'solver_queue',
  ADD COLUMN IF NOT EXISTS intermediate_mint TEXT,
  ADD COLUMN IF NOT EXISTS intermediate_amount TEXT;

ALTER TABLE earn_external_wallet_withdrawal_request_transactions
  DROP CONSTRAINT IF EXISTS earn_external_wallet_withdrawal_request_transactions_request_shape_check;

ALTER TABLE earn_external_wallet_withdrawal_request_transactions
  ADD CONSTRAINT earn_external_wallet_withdrawal_request_transactions_mechanism_check
    CHECK (mechanism IN ('solver_queue', 'operator_redemption')),
  ADD CONSTRAINT earn_external_wallet_withdrawal_request_transactions_request_shape_check
    CHECK (
      (
        action = 'request' AND withdrawal_request_id IS NULL
        AND position_id IS NOT NULL
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
        )
      )
      OR
      (
        action = 'cancel' AND withdrawal_request_id IS NOT NULL
        AND shares IS NULL AND quoted_assets IS NULL
        AND share_decimals IS NULL AND asset_decimals IS NULL
        AND intermediate_mint IS NULL AND intermediate_amount IS NULL
        AND discount_bps IS NULL
        AND maturity_timestamp IS NULL AND deadline_timestamp IS NULL
      )
    );

-- A Hastra request PDA is derived from only the owner and is reusable after
-- closure. Preserve a short database-side embargo in addition to the adapter's
-- finalized block-height check, so no concurrent API path can immediately
-- reserve the just-closed identity. Existing solver-queue leases predate this
-- rule and remain immediately eligible under their existing semantics.
ALTER TABLE earn_vault_withdrawal_request_pda_leases
  ADD COLUMN IF NOT EXISTS reuse_not_before TEXT NOT NULL
    DEFAULT '1970-01-01T00:00:00.000Z';

-- Veda queue identities remain permanently unique after any landed request.
-- Hastra alone derives one reusable owner PDA, so only its terminal operator
-- redemption rows leave the live uniqueness set.
DROP INDEX IF EXISTS idx_earn_vault_withdrawal_requests_live_address;
CREATE UNIQUE INDEX idx_earn_vault_withdrawal_requests_live_address
  ON earn_vault_withdrawal_requests(environment, request_address)
  WHERE mechanism = 'solver_queue' AND status <> 'failed';

CREATE UNIQUE INDEX idx_earn_vault_withdrawal_requests_operator_live_address
  ON earn_vault_withdrawal_requests(environment, request_address)
  WHERE mechanism = 'operator_redemption'
    AND status NOT IN ('failed', 'fulfilled', 'cancelled');
