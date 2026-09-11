-- One audit event per earn withdrawal movement (PRO-1866 review follow-up).
--
-- The replay backfill in routes/earn/handlers/movement-audit.ts checks for an
-- existing 'withdraw' event and then appends one. Every audit write serializes
-- through the ledger's session lock, so two writers cannot interleave, but
-- both can pass the (unlocked) existence check first and append twice. This
-- partial unique index makes the INSERT itself the atomic existence check:
-- the losing writer fails inside the serialized audit transaction, which
-- rolls back cleanly (the checkpoint witness is restored by the writer's
-- rollback path), and the caller treats the unique violation as "already
-- audited" rather than an error.
--
-- Scoped to earn withdraw events only: nothing else on audit_logs promises
-- one-event-per-resource, and deposit events are intent/outcome PAIRS by
-- design (beginCritical/completeCritical), so they must stay out of it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_logs_earn_withdraw_movement
  ON audit_logs (organization_id, resource_id)
  WHERE action = 'withdraw'
    AND resource_type = 'earn_movement'
    AND resource_id IS NOT NULL;
