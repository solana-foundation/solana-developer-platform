-- Solana Earn: record what a vault movement settled in the DEPOSIT token.
--
-- A vault withdrawal is ledgered in SHARES (`denomination` = share mint,
-- `amount_requested` / `amount_settled` = shares), because shares are the
-- exact quantity the transaction encodes; the tokens that come back are decided
-- by the chain. That left the per-owner earned figure unstatable after any
-- exit (`withdrawals_not_valued`, ADR 0002 2026-08-31), and it left the
-- activity feed unable to show a withdrawal in the unit the customer thinks in.
--
-- ADR 0002 already named the fix: observe the actual token payout from the
-- LANDED transaction at settlement. This column is that observation.
--
-- * Deposits: equal to the settled deposit amount, which is already in the
--   deposit token. Stamped so one column answers "what moved, in tokens" for
--   both directions without a direction-conditional read.
-- * Withdrawals: the receiving wallet's post-minus-pre balance of the
--   position's deposit token in the finalized transaction, formatted at the
--   mint's decimals. NULL when the payout could not be observed (RPC failure,
--   missing meta, non-positive delta). NULL is "unknown", never a guess: the
--   earnings read reports `withdrawals_not_valued` for exactly these rows.
--
-- Only a finalized row may carry it: it is a settlement fact. The strict
-- format mirrors 0062's vault amount rule. `amount_settled`, `payout_token`
-- and `fee_amount` keep their existing meanings and CHECKs (0062/0070); a
-- share quantity and a token quantity never share a column.
--
-- No backfill: earlier finalized withdrawals stay NULL and keep reporting
-- `withdrawals_not_valued`, which is the truthful answer for them.

ALTER TABLE earn_movements
  ADD COLUMN IF NOT EXISTS token_amount_settled TEXT
    CONSTRAINT earn_movements_token_amount_settled_check
      CHECK (
        token_amount_settled IS NULL
        OR (
          status = 'finalized'
          AND LENGTH(token_amount_settled) BETWEEN 1 AND 128
          AND token_amount_settled ~ '^\d+(\.\d+)?$'
          AND token_amount_settled ~ '[1-9]'
        )
      );

COMMENT ON COLUMN earn_movements.token_amount_settled IS
  'Settled quantity in the position''s deposit token: the deposit amount, or the observed withdrawal payout from the finalized transaction. NULL when not observed.';
