-- Solana Earn: a Hastra par request may redeem wYLDS the owner already holds,
-- such as a cancelled request's, and burn no PRIME. That row records
-- shares = '0'; its non-zero intermediate_amount (0116) is what moves, and
-- its fulfillment is ledgered in the intermediate. Solver queues keep the
-- non-zero share rule. The previous image never writes a zero-share row, so
-- relaxing the check is rollback-compatible.

ALTER TABLE earn_vault_withdrawal_requests
  DROP CONSTRAINT IF EXISTS earn_vault_withdrawal_requests_amounts_check,
  ADD CONSTRAINT earn_vault_withdrawal_requests_amounts_check
    CHECK (
      LENGTH(shares) BETWEEN 1 AND 128
      AND shares ~ '^\d+(\.\d+)?$'
      AND (shares ~ '[1-9]' OR mechanism = 'operator_redemption')
      AND LENGTH(quoted_assets) BETWEEN 1 AND 128
      AND quoted_assets ~ '^\d+(\.\d+)?$'
    );
