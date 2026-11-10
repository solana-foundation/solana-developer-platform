-- A verified share return settles a cancelled redemption with no token payout.
-- Expand the existing check; previous revisions continue accepting every old value.
ALTER TABLE earn_movements
  DROP CONSTRAINT earn_movements_token_amount_settled_check,
  ADD CONSTRAINT earn_movements_token_amount_settled_check CHECK (
    token_amount_settled IS NULL OR (
      status = 'finalized'
      AND LENGTH(token_amount_settled) BETWEEN 1 AND 128
      AND token_amount_settled ~ '^\d+(\.\d+)?$'
      AND (
        token_amount_settled ~ '[1-9]'
        OR (token_amount_settled = '0' AND direction = 'withdrawal'
            AND (provider_data->'providerSettlement'->>'outcome') IS NOT DISTINCT FROM 'cancelled')
      )
    )
  ) NOT VALID;
ALTER TABLE earn_movements
  DROP CONSTRAINT earn_movements_vault_amount_format_check,
  ADD CONSTRAINT earn_movements_vault_amount_format_check CHECK (
    execution_model <> 'vault_direct' OR (
      (amount_settled IS NULL OR (
        amount_settled ~ '^\d+(\.\d+)?$' AND (
          amount_settled ~ '[1-9]' OR (
            amount_settled = '0' AND direction = 'withdrawal' AND status = 'finalized'
            AND (provider_data->'providerSettlement'->>'outcome') IS NOT DISTINCT FROM 'cancelled'
          )
        )
      )) AND (
        min_shares_out IS NULL OR (
          LENGTH(min_shares_out) BETWEEN 1 AND 128
          AND min_shares_out ~ '^\d+(\.\d+)?$' AND min_shares_out ~ '[1-9]'
        )
      )
    )
  ) NOT VALID;
