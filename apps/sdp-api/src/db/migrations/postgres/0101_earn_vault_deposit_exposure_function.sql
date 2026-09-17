-- Solana Earn: the SDP-wide vault exposure aggregate as a function (ADR 0004
-- layer 1, PRO-1934).
--
-- `earn_vault_deposit_exposure` is the ONE definition of "money SDP customers
-- have collectively put into this vault": the sum of non-failed vault deposits
-- (in-flight included) across every organization on the environment, in the
-- vault's deposit-token units. It is the figure both halves of the cap read:
-- the admission gate before a deposit is built, and the ledger write that
-- records the deposit's `requested` row.
--
-- Why a function, and why it widens its own identity. earn_movements is
-- tenant-owned (0081), so under a request's tenant identity the aggregate
-- would only ever see the caller's own deposits and the cap would be a per-org
-- limit by accident. The admission gate used to widen its read from the
-- application side; the ledger write cannot, because its transaction is already
-- stamped with the tenant identity when the movement row is inserted, and the
-- re-check must run INSIDE that transaction, after the per-vault advisory lock
-- (`ledgerVaultExposureGate`, services/earn/vault-exposure.ts), or two deposits
-- admitted a moment apart can each read the same headroom and together
-- overshoot the cap.
--
-- Why set_config and not a function-level `SET` clause. Postgres only lets a
-- SUPERUSER (or a role granted SET ON PARAMETER) store `SET app.x = ...` in a
-- function definition; Cloud SQL never hands out either, so the first version
-- of this migration died on stage with "permission denied to set parameter"
-- (2026-09-16). It is edited in place rather than re-numbered: a transactional
-- migration that fails is rolled back unrecorded, so no Cloud SQL database has
-- 0101 applied and this body is the first one they see. set_config() on a
-- placeholder is allowed for every role. The body therefore
-- saves the caller's identity, stamps `system` transaction-locally, runs the
-- one aggregate, and puts the caller's identity back. plpgsql is never inlined
-- into the calling statement, so the widened identity cannot reach it, and an
-- error inside the body aborts the (sub)transaction, which discards the
-- transaction-local change with it. '' and unset are the same identity to
-- `sdp_tenant_isolation_identity()` (0081), which is what makes the restore
-- exact when the caller had none.
--
-- Guarded by src/db/migrations/tenant-isolation-coverage.test.ts: no function
-- may carry a function-level `SET app.*`, because it cannot be applied on
-- Cloud SQL.
--
-- Served by idx_earn_movements_vault_exposure (0100).
CREATE OR REPLACE FUNCTION earn_vault_deposit_exposure(
    p_environment TEXT,
    p_provider TEXT,
    p_vault_address TEXT
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_prior_identity TEXT := COALESCE(current_setting('app.tenant_isolation_identity', true), '');
    v_prior_actor    TEXT := COALESCE(current_setting('app.tenant_isolation_actor', true), '');
    v_total          NUMERIC;
BEGIN
    PERFORM set_config('app.tenant_isolation_identity', 'system', true);
    PERFORM set_config('app.tenant_isolation_actor', 'earn:vault-exposure-cap', true);

    SELECT COALESCE(SUM(COALESCE(amount_settled, amount_requested)::numeric), 0)
      INTO v_total
      FROM earn_movements
     WHERE environment = p_environment
       AND provider = p_provider
       AND vault_address = p_vault_address
       AND execution_model = 'vault_direct'
       AND direction = 'deposit'
       AND status IN ('requested', 'submitted', 'confirmed', 'finalized');

    PERFORM set_config('app.tenant_isolation_identity', v_prior_identity, true);
    PERFORM set_config('app.tenant_isolation_actor', v_prior_actor, true);

    RETURN v_total;
END
$$;
