-- A funding claim that belongs to the party doing the funding (PRO-1854).
--
-- `dvp_trades.sdp_leg_funding_signature` (0080) and `sdp_leg_funding_tx` (0085)
-- are single columns on the trade, and they describe ONE leg: the creating
-- organization's. They were correct while that org was the only party who could
-- ever fund through SDP.
--
-- PRO-1853 broke that. An agent trade names two parties and the creating org
-- holds neither leg, so if either party banks with SDP they have to be able to
-- fund their own escrow. Two funders sharing one signature column would share
-- one lock: the second party's claim would collide with the first's on a
-- different leg entirely, and whichever lost would be told its leg was "already
-- being funded" when nothing of the sort was happening.
--
-- So the lock is keyed by (trade, side) rather than by trade, and the row is
-- owned by the organization DOING the funding rather than the one that created
-- the trade. That second part is what keeps this inside ordinary tenant
-- isolation: 0089 lets a party READ the trade and deliberately does not let it
-- write, so a cross-org funder records its claim here, on a row of its own,
-- and never mutates a row belonging to somebody else.
--
-- The creating org's own leg keeps using the columns on `dvp_trades`. The two
-- mechanisms can never contend, because a party funds the leg its address is
-- named on and the creating org funds `sdp_side`, and on a principal trade
-- those are different legs by construction while on an agent trade `sdp_side`
-- is null and the columns are never touched at all.

CREATE TABLE IF NOT EXISTS dvp_leg_funding_claims (
    trade_id TEXT NOT NULL REFERENCES dvp_trades(id) ON DELETE CASCADE,
    -- Which leg this claim locks. The other half of the key, and the whole
    -- reason this table exists rather than two more columns on the trade.
    side TEXT NOT NULL CHECK (side IN ('a', 'b')),

    -- The funder, not the trade's author. Everything about tenant isolation on
    -- this table follows from that: the row is the funding org's own record.
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- The wallet that signed, which is also the wallet whose public key matched
    -- the party address. RESTRICT because the claim is evidence about a
    -- transfer that may be on chain; deleting the wallet must not erase it.
    custody_wallet_id TEXT NOT NULL REFERENCES custody_wallets(id) ON DELETE RESTRICT,

    -- Claimed before broadcast, exactly like 0080: reading the escrow and then
    -- transferring is not atomic, so the claim is taken first as a
    -- compare-and-swap and only the winner sends.
    signature TEXT NOT NULL,
    -- Past this height the signed transaction can never be accepted, which is
    -- what lets a sweep release a claim left behind by a failure the funding
    -- code could not classify.
    expiry_height TEXT NOT NULL,
    -- Written once the transfer is on the wire, so the receipt outlives the
    -- claim that produced it. Separate from the claim for the reason 0085 gives:
    -- a receipt and a lock want opposite lifetimes.
    funding_tx TEXT,

    created_at TEXT NOT NULL DEFAULT (sdp_iso_now()),
    updated_at TEXT NOT NULL DEFAULT (sdp_iso_now()),

    -- One live claim per leg. This is the lock.
    PRIMARY KEY (trade_id, side)
);

-- The sweep that releases dead claims walks by expiry, not by trade.
CREATE INDEX IF NOT EXISTS dvp_leg_funding_claims_expiry_idx
    ON dvp_leg_funding_claims(expiry_height)
    WHERE funding_tx IS NULL;

-- Ordinary tenant isolation, which is the point: the row belongs to the funder,
-- so no cross-organization policy is needed here at all. 0089's read widening
-- covers the trade; nothing widens this.
ALTER TABLE dvp_leg_funding_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE dvp_leg_funding_claims FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON dvp_leg_funding_claims;
CREATE POLICY sdp_tenant_isolation ON dvp_leg_funding_claims
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
