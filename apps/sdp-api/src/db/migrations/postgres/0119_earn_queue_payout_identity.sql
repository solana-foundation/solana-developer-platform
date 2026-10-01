-- A solver transaction may pay several requests. Observed payouts are unique
-- by durable request, while initiated movements retain their existing keys.
-- Nullable for old writers during rollout; their deterministic movement IDs
-- still prevent replay. Deploy this expansion before the new payout writer.
ALTER TABLE earn_movements
  ADD COLUMN withdrawal_request_id TEXT;

ALTER TABLE earn_movements
  ADD CONSTRAINT earn_movements_withdrawal_request_fkey
    FOREIGN KEY (withdrawal_request_id)
    REFERENCES earn_vault_withdrawal_requests(id),
  ADD CONSTRAINT earn_movements_withdrawal_request_shape_check
    CHECK (withdrawal_request_id IS NULL OR (
      id = 'earn_queue_fulfillment_' || withdrawal_request_id
      AND execution_model = 'vault_direct'
      AND direction = 'withdrawal'
      AND status = 'finalized'
      AND signed_transaction IS NULL
      AND signature IS NOT NULL
      AND provider_reference IS NOT NULL
    ));

UPDATE earn_movements AS movement
   SET withdrawal_request_id = request.id
  FROM earn_vault_withdrawal_requests AS request
 WHERE movement.id = 'earn_queue_fulfillment_' || request.id
   AND movement.organization_id = request.organization_id
   AND movement.execution_model = 'vault_direct'
   AND movement.signed_transaction IS NULL
   AND movement.withdrawal_request_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_movements_withdrawal_request
  ON earn_movements(withdrawal_request_id)
  WHERE withdrawal_request_id IS NOT NULL;

DROP INDEX IF EXISTS idx_earn_movements_signature;
CREATE UNIQUE INDEX idx_earn_movements_signature
  ON earn_movements(signature)
  WHERE signature IS NOT NULL AND withdrawal_request_id IS NULL;
