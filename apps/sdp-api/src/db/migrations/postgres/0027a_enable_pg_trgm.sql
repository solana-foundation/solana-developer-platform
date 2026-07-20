-- Install pg_trgm transactionally before the non-transactional concurrent
-- trigram index migrations. This new filename also upgrades databases that
-- already recorded the original 0027 ledger-index migration.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
