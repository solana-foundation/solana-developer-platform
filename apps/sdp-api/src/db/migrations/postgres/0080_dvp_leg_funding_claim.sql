-- The signature of the transfer that funded SDP's leg, claimed before it is
-- broadcast.
--
-- Reading the escrow balance and then transferring is not atomic: two funding
-- requests seconds apart both see the same shortfall and both send, and the
-- escrow ends up over-funded. A surplus is not harmless, because settlement
-- refunds it and on a transfer-hook mint that refund can revert the whole
-- settlement. So the claim is taken in the database first, as a
-- compare-and-swap, and only the winner broadcasts.
ALTER TABLE dvp_trades
    ADD COLUMN IF NOT EXISTS sdp_leg_funding_signature TEXT;
