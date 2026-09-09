-- The transaction that funded SDP's leg, kept as a receipt.
--
-- `sdp_leg_funding_signature` looks like a record of the funding transfer and
-- is not one. It is a LOCK: funding takes it before broadcasting so two
-- overlapping requests cannot both send, and it is cleared on a released claim
-- and by the expiry sweep in 0084. So the signature is present for the minute
-- or so a claim lives and then becomes NULL — on a leg that funded perfectly.
--
-- The detail page reads it to link the funding transaction. That link therefore
-- appeared briefly and then vanished, leaving a funded leg whose only evidence
-- was a changed number. Somebody who funds a leg, sees a confirmation and then
-- finds nothing on the page pointing at a transaction has no way to tell a
-- successful transfer from one that never happened, and the reasonable
-- conclusion is that it did not work.
--
-- A receipt and a lock want opposite lifetimes, so they cannot be one column.
-- This one is written once the transfer is broadcast and never cleared.
ALTER TABLE dvp_trades ADD COLUMN IF NOT EXISTS sdp_leg_funding_tx TEXT;

-- A leg funded before this migration keeps whatever claim it still holds, so an
-- in-flight funding does not lose its link at deploy time. A claim that has
-- already expired is gone and cannot be recovered from here; those legs show
-- their funded amount without a transaction, which is what they show today.
UPDATE dvp_trades
   SET sdp_leg_funding_tx = sdp_leg_funding_signature
 WHERE sdp_leg_funding_tx IS NULL
   AND sdp_leg_funding_signature IS NOT NULL;
