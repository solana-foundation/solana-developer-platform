-- 0055_drop_payment_wallet_policies.sql
--
-- Drops the legacy payment_wallet_policies table (PRO-1617). Wallet control
-- profiles (0010_wallet_api_key_policy_foundations.sql) are the only policy
-- engine; legacy rows are not converted — pre-mainnet, operators re-author
-- policies as control-profile rules.

DROP TABLE IF EXISTS payment_wallet_policies;

-- Cancel transfer-batch approvals pending at deploy: operations recorded
-- before this release lack resolved recipient destinations in raw_payload,
-- so the stricter approved-replay match would refuse them on approval.
-- Requesters re-submit the batch and approve the fresh operation.
UPDATE approval_requests ar
SET status = 'canceled',
    resolved_at = sdp_iso_now(),
    updated_at = sdp_iso_now()
FROM wallet_operations wo
WHERE ar.wallet_operation_id = wo.id
  AND ar.status = 'pending'
  AND wo.operation_type = 'payment_transfer_batch_execute';

UPDATE wallet_operations
SET status = 'canceled',
    updated_at = sdp_iso_now()
WHERE operation_type = 'payment_transfer_batch_execute'
  AND status = 'pending_approval';
