-- sdp:migration-mode: non-transactional
-- Due-time ordering keeps 250 ms scans bounded by due work. Removing this key
-- would scan/sort unresolved history, including delayed or parked obligations.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_earn_movement_observation_due
    ON earn_movements(environment, observation_due_at ASC NULLS FIRST, id)
    WHERE execution_model = 'vault_direct'
      AND status IN ('requested', 'submitted', 'confirmed')
      AND chain_finalized_at IS NULL;
