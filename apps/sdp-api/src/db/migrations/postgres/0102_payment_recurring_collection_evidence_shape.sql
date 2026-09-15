DELETE FROM payment_subscription_collection_attempts
WHERE jsonb_typeof(metadata->'source') IS DISTINCT FROM 'string'
   OR metadata->>'source' NOT IN ('manual', 'automated', 'retry', 'linked_transfer');

DELETE FROM payment_transfers
WHERE type = 'transfer'
  AND provider IS NULL
  AND provider_data ? 'recurringPaymentId'
  AND NOT (
    provider_data ? 'subscriptionId'
    AND provider_data ? 'collectionDueAt'
  );

ALTER TABLE payment_subscription_collection_attempts
    ADD CONSTRAINT payment_subscription_collection_attempts_metadata_source_check
    CHECK (
      metadata ? 'source'
      AND jsonb_typeof(metadata->'source') = 'string'
      AND metadata->>'source' IN ('manual', 'automated', 'retry', 'linked_transfer')
    );

ALTER TABLE payment_transfers
    ADD CONSTRAINT payment_transfers_recurring_collection_evidence_check
    CHECK (
      type <> 'transfer'
      OR provider IS NOT NULL
      OR NOT (provider_data ? 'recurringPaymentId')
      OR (
        provider_data ? 'subscriptionId'
        AND provider_data ? 'collectionDueAt'
      )
    );
