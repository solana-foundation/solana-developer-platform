-- One sponsored transaction per payment request per blockhash window, held on
-- the request row so the claim survives a Redis reset and every instance sees
-- the same candidate. The claimed account, the unsigned and signed transaction
-- bytes, and the height the claim expires at travel together: a claim exists
-- only with an account and an expiry, and signed bytes only for a claim.
ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS sponsored_tx_account TEXT,
  ADD COLUMN IF NOT EXISTS sponsored_tx_unsigned TEXT,
  ADD COLUMN IF NOT EXISTS sponsored_tx_signed TEXT,
  ADD COLUMN IF NOT EXISTS sponsored_tx_last_valid_block_height BIGINT,
  ADD CONSTRAINT payment_requests_sponsored_tx_claim_shape CHECK (
    (
      (sponsored_tx_account IS NULL)
        = (sponsored_tx_unsigned IS NULL)
    )
    AND (
      (sponsored_tx_account IS NULL)
        = (sponsored_tx_last_valid_block_height IS NULL)
    )
    AND (sponsored_tx_signed IS NULL OR sponsored_tx_account IS NOT NULL)
  );
