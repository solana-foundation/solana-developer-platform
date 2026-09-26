-- Immutable funding history for a DvP leg (APE-695, Apex SOLA9-352).
--
-- `dvp_leg_funding_claims` is a lock. Its row is deliberately mutable: a
-- sponsored broadcast rebinds its signature, a reclaim whose chain read proved
-- the funding landed takes the row over in place, and a released or swept lock
-- is deleted. Those are the right lifetimes for a LOCK — and the wrong ones for
-- history. Sourcing the unified transaction feed's `fund` rows from the claim
-- table let a reclaim rewrite the feed's funding evidence (the reclaim's
-- signature presented as a funding) and then erase it entirely.
--
-- So the receipt gets a row of its own, written once when the funding transfer
-- is broadcast and never updated afterwards. A reclaim can never touch it, a
-- signature rebind never rewrites it, and releasing the lock never removes it:
-- the feed's `fund` rows are read from here, so funding evidence can no longer
-- be reassigned or withdrawn by later lifecycle actions on the lock. The only
-- deletion is the reconciler's, when the chain itself proves the transfer
-- moved nothing — evidence of nothing is not history.
--
-- Everything else about ownership matches the claim it mirrors (0090): the row
-- belongs to the organization doing the funding, so ordinary tenant isolation
-- applies and no cross-organization read is needed.

CREATE TABLE IF NOT EXISTS dvp_leg_funding_receipts (
    trade_id TEXT NOT NULL REFERENCES dvp_trades(id) ON DELETE CASCADE,
    -- Which leg this receipt funded.
    side TEXT NOT NULL CHECK (side IN ('a', 'b')),

    -- The funder, copied from the claim that held the leg when the transfer
    -- went out. Same ownership domain as 0090's claim rows.
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- The wallet that signed the funding transfer. RESTRICT for the same
    -- reason 0090 gives: the row is evidence about a transfer that may be on
    -- chain; deleting the wallet must not erase it.
    custody_wallet_id TEXT NOT NULL REFERENCES custody_wallets(id) ON DELETE RESTRICT,

    -- The broadcast funding transaction's signature. One receipt per broadcast:
    -- a leg that is reclaimed and funded again accrues one receipt per funding,
    -- each a true record of a transfer that went out.
    signature TEXT NOT NULL,

    -- What THAT transfer sent, in base units, recorded at broadcast. A leg can
    -- be funded again after a reclaim, and each funding sends only the
    -- shortfall it observed, so per-event amounts cannot be derived from the
    -- trade: the trade-level escrow peak is the leg's high-water mark, not what
    -- any one transfer moved. The feed shows this amount per receipt.
    --
    -- Nullable, but only ever NULL for a row the backfill below inserted: a
    -- claim broadcast before this table existed has no recorded amount, and if
    -- its trade's escrow peak was never populated (0092 added the peak columns
    -- without a backfill) the deployed feed showed that fund row with a NULL
    -- amount — the backfill must keep showing exactly that instead of aborting
    -- the deploy over history the feed already showed. Every receipt written
    -- at broadcast carries the transfer's amount, and from this migration
    -- forward no NULL is ever written again.
    amount TEXT,

    created_at TEXT NOT NULL DEFAULT (sdp_iso_now()),

    PRIMARY KEY (trade_id, side, signature)
);

-- The unified transaction feed lists these by tenant, newest first.
CREATE INDEX IF NOT EXISTS idx_dvp_leg_funding_receipts_organization_created
    ON dvp_leg_funding_receipts(organization_id, created_at DESC, trade_id DESC, side DESC);

-- Existing broadcast fundings keep their feed rows: every claim that already
-- carries a receipt becomes a receipt row here, so the deploy changes how
-- funding evidence is stored, never whether it is still shown. `updated_at` is
-- when the claim last changed, which for an untouched receipt is the broadcast.
-- Receipts the chain later proves moved nothing are removed by the reconciler
-- as before.
--
-- The backfilled amount is the side's escrow peak, which is exactly what the
-- deployed feed showed for that row and what the claim alone can still tell
-- about the transfer; per-event amounts are recorded from this migration
-- forward, at broadcast. A trade whose peak was never populated (0092 added
-- the columns without a backfill) showed that row with a NULL amount, so the
-- insert keeps the NULL — requiring a value here would abort the whole deploy
-- over one historical claim, and substituting a guess would change what the
-- feed already showed.
--
-- A funding whose claim was already taken over by a reclaim before this
-- migration ran has NO claim row left to backfill from: the takeover turned the
-- row into the reclaim's lock, and a later release deleted it. The deployed
-- feed sourced fund rows from that same claim row, so those fundings were
-- already absent from the feed before this deploy — this backfill preserves
-- exactly what was shown, and changes nothing about what was not. From here on
-- every broadcast writes a receipt of its own, so the gap cannot grow.
--
-- The escrow movement ledger (0111) cannot fill that gap either: it records the
-- token movement, but its only identity for a mover is the FEE PAYER, and a
-- sponsored funding's fee payer is the sponsor, not the funder. A receipt needs
-- the funder's custody wallet and tenant, and guessing one from an address
-- would fabricate cross-tenant evidence — worse than the honest gap, which the
-- feed had already closed at the takeover.
INSERT INTO dvp_leg_funding_receipts
    (trade_id, side, organization_id, project_id, custody_wallet_id, signature, amount, created_at)
SELECT c.trade_id, c.side, c.organization_id, c.project_id, c.custody_wallet_id, c.funding_tx,
       CASE c.side WHEN 'a' THEN t.escrow_a_peak_amount WHEN 'b' THEN t.escrow_b_peak_amount END,
       c.updated_at
  FROM dvp_leg_funding_claims c
  JOIN dvp_trades t ON t.id = c.trade_id
 WHERE c.funding_tx IS NOT NULL
 ON CONFLICT (trade_id, side, signature) DO NOTHING;

-- Ordinary tenant isolation, exactly as on `dvp_leg_funding_claims`.
ALTER TABLE dvp_leg_funding_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE dvp_leg_funding_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON dvp_leg_funding_receipts;
CREATE POLICY sdp_tenant_isolation ON dvp_leg_funding_receipts
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
