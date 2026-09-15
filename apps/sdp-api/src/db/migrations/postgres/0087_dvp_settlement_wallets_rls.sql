-- Database-enforced tenant isolation for the per-project settlement authority.
--
-- Companion to 0086, which covered `dvp_trades`. This table was created in
-- 0079, also before 0081 established the coverage ratchet, so it carries no
-- policy either and `tenant-isolation-coverage.test.ts` fails on it.
--
-- Worth isolating on its own terms rather than by rule. The row maps a project
-- to the address holding the ONLY key that can settle or cancel that project's
-- trades. Reading it across a tenant boundary tells you which account to watch,
-- or to fund-grief; writing across one would repoint a project's settlements at
-- an authority it does not own.
--
-- `organization_id` is carried directly, so this is the plain 0081 shape.

ALTER TABLE dvp_settlement_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE dvp_settlement_wallets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON dvp_settlement_wallets;
CREATE POLICY sdp_tenant_isolation ON dvp_settlement_wallets
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
