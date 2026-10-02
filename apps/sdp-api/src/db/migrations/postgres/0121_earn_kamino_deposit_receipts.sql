-- Additive for rolling deployment: old revisions can still write their legacy
-- projections, but new readers ignore them without this receipt provenance.
-- Bounded receipt repair replaces historical guesses with verifiable facts.
ALTER TABLE earn_movements ADD COLUMN IF NOT EXISTS deposit_receipt_observed_at TEXT;

ALTER TABLE earn_movements
  ADD CONSTRAINT earn_movements_kamino_deposit_receipt_check CHECK (
    deposit_receipt_observed_at IS NULL
    OR (
        execution_model = 'vault_direct' AND provider = 'kamino' AND direction = 'deposit'
        AND status = 'finalized'
        AND amount_settled IS NOT NULL AND token_amount_settled IS NOT NULL
        AND amount_settled = token_amount_settled AND shares_out IS NOT NULL
        AND amount_settled::numeric <= amount_requested::numeric
    )
  );

COMMENT ON COLUMN earn_movements.deposit_receipt_observed_at IS
  'When a finalized Kamino deposit CPI receipt established amount_settled and shares_out. NULL means unobserved, including historical requested-amount projections.';
