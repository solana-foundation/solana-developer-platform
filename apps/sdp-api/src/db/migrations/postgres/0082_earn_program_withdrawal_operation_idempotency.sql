-- One governed operation per Earn program payout, organization-wide (HOO-1559).
--
-- The general wallet-operation key is unique per (organization, project, key),
-- which is right for operations a project owns. An Earn program is a provider
-- account addressed per (organization, environment), and its payout ledger is
-- keyed by organization + provider wallet + request id — so the same request
-- id arriving under a sibling project is the SAME payout, and a project-scoped
-- key let it open a second governed operation and a second approval request.
--
-- The route already refuses a retry that finds a prior operation, but that
-- check cannot bind concurrent first attempts: both read no prior record, and
-- only a database constraint decides. This partial index is that constraint;
-- the insert takes it as ON CONFLICT DO NOTHING, so the loser answers with the
-- winner's held operation instead of minting its own.
--
-- Safe to add without a backfill: `earn_program_withdrawal` is introduced by
-- this change, so no existing row can violate it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_operations_earn_program_withdrawal_idempotency
    ON wallet_operations (organization_id, idempotency_key)
    WHERE operation_type = 'earn_program_withdrawal' AND idempotency_key IS NOT NULL;
