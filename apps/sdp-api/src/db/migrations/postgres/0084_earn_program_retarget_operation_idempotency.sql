-- One governed operation per Earn program re-target, organization-wide. The
-- sibling of 0082's payout index: `PUT /programs/:programId` re-points the
-- program's whole balance, and the same request id arriving under a sibling
-- project is the SAME re-target intent, so the operation key must be unique
-- per (organization, key) — not per (organization, project, key) — or a retry
-- under another project could open a second approval for one allocation
-- change.
--
-- Safe to add without a backfill: `earn_program_retarget` is introduced by
-- this change, so no existing row can carry the type yet.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_operations_earn_program_retarget_idempotency
    ON wallet_operations (organization_id, idempotency_key)
    WHERE operation_type = 'earn_program_retarget' AND idempotency_key IS NOT NULL;
