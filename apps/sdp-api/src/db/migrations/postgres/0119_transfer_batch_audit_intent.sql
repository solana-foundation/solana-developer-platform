-- Transfer batches: link each batch to the audit-ledger intent that admitted it.
--
-- The intent is written before the batch row exists and before any chunk is
-- signed. The writer that settles the batch to a terminal status appends the
-- outcome against this id, so the ledger records the chain verdict rather than
-- the dispatch, and stamps audit_outcome_recorded_at once it is durable. The
-- pending-transfers job re-appends outcomes for terminal batches left without
-- the stamp, so a crash between the terminal write and the outcome cannot
-- leave the intent unresolved. Batches created before the ledger admitted
-- batches keep both columns null.

ALTER TABLE payment_transfer_batches
    ADD COLUMN IF NOT EXISTS audit_intent_id TEXT,
    ADD COLUMN IF NOT EXISTS audit_outcome_recorded_at TEXT;

CREATE INDEX IF NOT EXISTS idx_payment_transfer_batches_audit_outcome_pending
    ON payment_transfer_batches (updated_at)
    WHERE audit_intent_id IS NOT NULL
      AND audit_outcome_recorded_at IS NULL
      AND status IN ('confirmed', 'failed', 'partially_failed');
