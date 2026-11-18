-- sdp:migration-mode: non-transactional
-- The rolling bridge scans live legacy intents, including terminal alert rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS payment_transfers_legacy_proposals_idx
  ON payment_transfers (project_id, created_at, id)
  WHERE provider_data->'fireblocksTransfer' IS NOT NULL
    AND (status = 'processing' OR (
      status IN ('completed','confirmed','finalized')
      AND provider_data->'proposalRefusal' IS NOT NULL
      AND provider_data->>'proposalRefusalAlertedAt' IS NULL
    ));
