-- Database-enforced tenant isolation for DvP trades.
--
-- `dvp_trades` was created in 0077, before 0081 established the coverage
-- ratchet, so it is the one money table in the schema that carries no policy.
-- `src/db/migrations/tenant-isolation-coverage.test.ts` fails on exactly this:
-- every table must either force row-level security with a policy, or be
-- registered there as deliberately shared. A trade is neither shared nor
-- harmless — the row names a custody wallet, both parties, the agreed amounts
-- and the escrow addresses a counterparty pays into, so reading one across a
-- tenant boundary is a disclosure of somebody's live settlement instructions.
--
-- Same shape as every other organization_id-scoped table in 0081: the policy
-- delegates to `sdp_tenant_isolation_allows`, which admits the `system` and
-- `operator` identities and otherwise requires the row's organization to match
-- the one stamped on the transaction. With no identity set it fails closed.
--
-- FORCE is not optional here. Without it the table owner bypasses the policy,
-- and the migration role owns this table.

ALTER TABLE dvp_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE dvp_trades FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON dvp_trades;
CREATE POLICY sdp_tenant_isolation ON dvp_trades
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
