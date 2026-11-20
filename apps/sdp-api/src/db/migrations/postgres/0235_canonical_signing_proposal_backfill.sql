-- The preceding migration installs the old-image write bridge first. Historical
-- reads do not hold its DDL locks, and a concurrent bridged write wins conflicts.
INSERT INTO custody_proposals
  (id, organization_id, project_id, custody_wallet_id, payment_transfer_id, provider,
   binding, kind, operation, request_id, provider_phase, authorization_state,
   provider_transaction_id, provider_status, submission_started_at,
   refused_at, refusal_reason, refusal_message, finished_at, last_polled_at,
   next_check_at, created_at, updated_at)
SELECT id, organization_id, project_id, custody_wallet_id, payment_transfer_id, provider,
   binding, kind, operation, request_id, provider_phase, authorization_state,
   provider_transaction_id, provider_status, submission_started_at,
   refused_at, refusal_reason, refusal_message, finished_at, last_polled_at,
   next_check_at, created_at, updated_at
FROM sdp_legacy_signing_proposals
ON CONFLICT (id) DO NOTHING;

-- Validate after the additive migration releases its ALTER TABLE lock.
ALTER TABLE custody_proposals VALIDATE CONSTRAINT custody_proposals_kind_check;
