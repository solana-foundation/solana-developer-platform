ALTER TABLE payment_transfers
  ADD COLUMN IF NOT EXISTS signed_transaction TEXT,
  ADD COLUMN IF NOT EXISTS last_valid_block_height NUMERIC,
  ADD COLUMN IF NOT EXISTS submission_started_at TEXT;

ALTER TABLE payment_transfers
  ADD CONSTRAINT payment_transfers_signed_outbox_pair_check
  CHECK ((signed_transaction IS NULL) = (last_valid_block_height IS NULL)),
  ADD CONSTRAINT payment_transfers_signed_outbox_signature_check
  CHECK (signed_transaction IS NULL OR signature IS NOT NULL),
  ADD CONSTRAINT payment_transfers_submission_started_check
  CHECK (submission_started_at IS NULL OR signed_transaction IS NOT NULL),
  ADD CONSTRAINT payment_transfers_last_valid_block_height_check
  CHECK (
    last_valid_block_height IS NULL
    OR (
      SCALE(last_valid_block_height) = 0
      AND last_valid_block_height BETWEEN 0 AND 18446744073709551615
    )
  );
