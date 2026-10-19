-- sdp:migration-compat: breaking
-- Mainnet fee sponsorship was seeded disabled in 0055 pending operator
-- approval; this is that approval. Only the seeded row flips: a global policy
-- an operator killed or the sponsorship breaker tripped no longer carries
-- updated_by = 'migration', so it stays disabled. Limits are unchanged, and the
-- next admission syncs the new version into Redis before reserving.
WITH enabled AS (
  UPDATE sponsorship_budget_policies
     SET enabled = TRUE,
         version = version + 1,
         updated_by = 'migration',
         update_reason = 'Mainnet sponsorship approved for launch',
         updated_at = sdp_iso_now()
   WHERE id = 'sbp_mainnet_global'
     AND enabled = FALSE
     AND updated_by = 'migration'
  RETURNING *
)
INSERT INTO sponsorship_budget_policy_revisions (
  id, policy_id, network, scope_type, scope_id, enabled,
  per_transaction_lamports, hourly_lamports, daily_lamports,
  version, changed_by, change_reason
)
SELECT
  'sbpr_' || id || '_' || version, id, network, scope_type, scope_id, enabled,
  per_transaction_lamports, hourly_lamports, daily_lamports,
  version, updated_by, update_reason
FROM enabled;
