-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_earn_withdrawal_action_observation_due
    ON earn_vault_withdrawal_request_actions(environment, observation_due_at ASC NULLS FIRST, id)
    WHERE observation_due_at IS NOT NULL
      AND status IN ('requested', 'submitted', 'confirmed', 'finalized');
