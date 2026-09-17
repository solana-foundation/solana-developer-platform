-- One close at a time per trade, and no close while a leg is moving (PRO-1973).
--
-- Settle and cancel each close the trade, and fund and reclaim each move one
-- leg's escrow. Before this, settle and cancel took no lock at all: both could
-- be accepted by the RPC for one trade, and reclaim could go out while a settle
-- was in flight. The program keeps the money consistent (only one close can
-- land, and a transfer into a closed escrow fails), but each loser still spends
-- a sponsored fee, and the status was written from RPC acceptance, so the
-- close that did NOT land could be the one recorded.
--
-- The close lock lives on the trade row, which only the creating organization
-- writes. A leg lock lives on `dvp_leg_funding_claims`, owned by whoever acts on
-- the leg, often another organization. Neither side can write the other's row,
-- so exclusion is claim-then-check: each takes its own lock, then reads the
-- other's and backs off when it finds one still able to land. Whichever commits
-- its lock second always sees the first.

ALTER TABLE dvp_trades
  ADD COLUMN IF NOT EXISTS close_claim_signature TEXT,
  ADD COLUMN IF NOT EXISTS close_claim_action TEXT,
  ADD COLUMN IF NOT EXISTS close_claim_expiry_height TEXT;

ALTER TABLE dvp_trades
  DROP CONSTRAINT IF EXISTS dvp_trades_close_claim_action_check;
ALTER TABLE dvp_trades
  ADD CONSTRAINT dvp_trades_close_claim_action_check
  CHECK (close_claim_action IS NULL OR close_claim_action IN ('settle', 'cancel'));

ALTER TABLE dvp_trades
  DROP CONSTRAINT IF EXISTS dvp_trades_close_claim_complete_check;
ALTER TABLE dvp_trades
  ADD CONSTRAINT dvp_trades_close_claim_complete_check
  CHECK (
    (close_claim_signature IS NULL) = (close_claim_action IS NULL)
    AND (close_claim_signature IS NULL) = (close_claim_expiry_height IS NULL)
  );

COMMENT ON COLUMN dvp_trades.close_claim_signature IS
  'The settle or cancel transaction in flight on this trade, held from before it is sponsored until it lands, is refused, or its blockhash expires. NULL when no close is in flight.';

-- The close has to see leg locks other organizations hold on this trade. Read
-- only, and only the trade's own organization: a party still sees just its own
-- claims.
DROP POLICY IF EXISTS sdp_dvp_trade_owner_reads_leg_claims ON dvp_leg_funding_claims;
CREATE POLICY sdp_dvp_trade_owner_reads_leg_claims ON dvp_leg_funding_claims
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM dvp_trades t
       WHERE t.id = dvp_leg_funding_claims.trade_id
         AND sdp_tenant_isolation_allows(t.organization_id)
    )
  );
