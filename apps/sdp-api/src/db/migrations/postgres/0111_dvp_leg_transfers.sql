-- Every token movement in and out of a leg's escrow (PRO-1941).
--
-- A leg's funding signature is the transfer SDP itself sent, and nothing else:
-- anyone can pay an escrow with a plain transfer, and settle, cancel and reclaim
-- move tokens out without SDP recording which. The chain already holds the
-- whole history of the escrow account, so the reconciler reads it and writes
-- one row per transaction that changed the escrow's balance, from that
-- transaction's pre and post token balances. What SDP sent and what anybody
-- else sent arrive through the same read.
--
-- A row is recorded once its transaction is confirmed, and stays provisional
-- until the reconciler sees it finalized. A confirmed transaction the cluster
-- later drops is deleted on the next sweep: the ledger holds what landed.
-- History is read back no further than the trade's creation. Nothing is
-- backfilled: a trade gets a ledger only while the reconciler still sweeps it.
--
-- Written only by the reconciler, a system workload. Read by whoever can read
-- the trade: its own organization, and a party named on it (0089). The escrow's
-- history is public on chain, so this discloses nothing a party could not
-- already read.

CREATE TABLE IF NOT EXISTS dvp_leg_transfers (
    trade_id TEXT NOT NULL REFERENCES dvp_trades(id) ON DELETE CASCADE,
    side TEXT NOT NULL CHECK (side IN ('a', 'b')),
    signature TEXT NOT NULL,
    -- Into the escrow or out of it, from the sign of post minus pre.
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    -- Base units moved, always positive. A u64, so text.
    amount TEXT NOT NULL CHECK (amount ~ '^[1-9][0-9]*$'),
    slot TEXT NOT NULL CHECK (slot ~ '^[0-9]+$'),
    -- Unix seconds, or NULL when the cluster did not record a time for the block.
    block_time TEXT CHECK (block_time IS NULL OR block_time ~ '^[0-9]+$'),
    fee_payer TEXT NOT NULL,
    -- False while the transaction is confirmed but not yet finalized. Only a
    -- provisional row can be deleted, and only when the chain no longer knows
    -- its transaction.
    finalized BOOLEAN NOT NULL,
    created_at TEXT NOT NULL DEFAULT (sdp_iso_now()),

    -- One row per transaction per leg, so re-reading history never duplicates.
    PRIMARY KEY (trade_id, side, signature)
);

-- How far each leg's history has been read: the newest finalized signature
-- every older one was resolved behind. The next read stops there, so a
-- confirmed transaction that is not final yet is read again until it is.
CREATE TABLE IF NOT EXISTS dvp_leg_transfer_scans (
    trade_id TEXT NOT NULL REFERENCES dvp_trades(id) ON DELETE CASCADE,
    side TEXT NOT NULL CHECK (side IN ('a', 'b')),
    -- NULL until a first read resolved anything.
    cursor_signature TEXT,
    -- The cursor's slot. Two overlapping sweeps never move the cursor back
    -- behind a slot the other already passed.
    cursor_slot TEXT CHECK (cursor_slot IS NULL OR cursor_slot ~ '^[0-9]+$'),
    CHECK ((cursor_signature IS NULL) = (cursor_slot IS NULL)),
    -- When a read last got through to the newest signature with nothing left
    -- provisional. NULL otherwise, which makes the leg due on the next sweep.
    scanned_at TEXT,
    PRIMARY KEY (trade_id, side)
);

ALTER TABLE dvp_leg_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE dvp_leg_transfers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_dvp_leg_transfers_system_writes ON dvp_leg_transfers;
CREATE POLICY sdp_dvp_leg_transfers_system_writes ON dvp_leg_transfers
  USING (sdp_tenant_isolation_is_privileged())
  WITH CHECK (sdp_tenant_isolation_is_privileged());
-- The trade's readers, stated outright rather than left to the nested read of
-- `dvp_trades`, for the reason 0089 gives about resting a boundary on a
-- policy underneath: either predicate alone refuses a stranger.
DROP POLICY IF EXISTS sdp_dvp_leg_transfers_trade_readers ON dvp_leg_transfers;
CREATE POLICY sdp_dvp_leg_transfers_trade_readers ON dvp_leg_transfers
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM dvp_trades t
       WHERE t.id = dvp_leg_transfers.trade_id
         AND (sdp_tenant_isolation_allows(t.organization_id)
              OR sdp_dvp_caller_is_party(t.user_a, t.user_b))
    )
  );

-- Bookkeeping for the sweep alone.
ALTER TABLE dvp_leg_transfer_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE dvp_leg_transfer_scans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_dvp_leg_transfer_scans_system ON dvp_leg_transfer_scans;
CREATE POLICY sdp_dvp_leg_transfer_scans_system ON dvp_leg_transfer_scans
  USING (sdp_tenant_isolation_is_privileged())
  WITH CHECK (sdp_tenant_isolation_is_privileged());
