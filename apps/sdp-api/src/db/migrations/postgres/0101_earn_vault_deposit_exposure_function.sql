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
-- Why a function, and why it sets the isolation identity itself. earn_movements
-- is tenant-owned (0081), so under a request's tenant identity the aggregate
-- would only ever see the caller's own deposits and the cap would be a per-org
-- limit by accident. The admission gate used to widen its read from the
-- application side; the ledger write cannot, because its transaction is already
-- stamped with the tenant identity when the movement row is inserted, and the
-- re-check must run INSIDE that transaction, after the per-vault advisory lock
-- (`ledgerVaultExposureGate`, services/earn/vault-exposure.ts), or two deposits
-- admitted a moment apart can each read the same headroom and together
-- overshoot the cap. Function-level SET scopes the privileged identity to this
-- one aggregate: it is set on entry and restored on exit, the statement
-- collapses into one number, and no other tenant's row can reach the caller.
--
-- The SET clause also keeps the SQL body from being inlined into the calling
-- query, which is what makes the scoping hold.
--
-- Registered in src/db/migrations/tenant-isolation-coverage.test.ts: any other
-- function that sets `app.tenant_isolation_identity` fails that test until a
-- reviewer registers it with a reason.
--
-- Served by idx_earn_movements_vault_exposure (0100).
CREATE OR REPLACE FUNCTION earn_vault_deposit_exposure(
    p_environment TEXT,
    p_provider TEXT,
    p_vault_address TEXT
)
RETURNS NUMERIC
LANGUAGE sql STABLE
SET app.tenant_isolation_identity = 'system'
SET app.tenant_isolation_actor = 'earn:vault-exposure-cap'
AS $$
  SELECT COALESCE(SUM(COALESCE(amount_settled, amount_requested)::numeric), 0)
    FROM earn_movements
   WHERE environment = p_environment
     AND provider = p_provider
     AND vault_address = p_vault_address
     AND execution_model = 'vault_direct'
     AND direction = 'deposit'
     AND status IN ('requested', 'submitted', 'confirmed', 'finalized')
$$;
