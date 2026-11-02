-- sdp:migration-mode: non-transactional
-- A correlated delivery cannot settle two intents. Old revisions ignore this
-- new JSON member, so this expand-only index is safe while they serve traffic.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS earn_provider_settlement_delivery_unique
  ON earn_movements (environment, provider, (provider_data -> 'providerSettlement' ->> 'destinationSignature'))
  WHERE provider_data -> 'providerSettlement' ->> 'destinationSignature' IS NOT NULL;
