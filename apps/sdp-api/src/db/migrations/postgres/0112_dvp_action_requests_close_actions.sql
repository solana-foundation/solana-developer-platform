-- Idempotency-Key for closing a trade, not only for acting on one leg (PRO-1993).
--
-- `dvp_leg_action_requests` (0101) gave fund and reclaim the property that a
-- retry after an ambiguous failure gets the first request's answer instead of
-- sending a second transaction. Settle and cancel had no key at all. Their only
-- protection was the close lock from 0110, which stops two closes overlapping
-- but cannot tell a retry from a new request: a retry while the lock is live is
-- refused with 409 and never learns the signature that did settle the trade,
-- and a retry after the lock expired on a close that DID land signs and
-- sponsors a second close against an escrow the chain has already emptied.
--
-- So the same table now records a close. A close is a TRADE-level action, so its
-- row carries no side, and it moves both legs, so it carries no single amount.
-- The constraints below make those two absences exact rather than optional:
-- a leg action must name its side and a close must not, and only a leg action
-- may record an amount.
--
-- The table keeps its name. Renaming it (and the repository, service and types
-- that spell "leg action") is mechanical churn that would bury the behaviour
-- change under it; it is tracked separately.

ALTER TABLE dvp_leg_action_requests
  ALTER COLUMN side DROP NOT NULL;

ALTER TABLE dvp_leg_action_requests
  DROP CONSTRAINT IF EXISTS dvp_leg_action_requests_action_check;
ALTER TABLE dvp_leg_action_requests
  ADD CONSTRAINT dvp_leg_action_requests_action_check
  CHECK (action IN ('fund', 'reclaim', 'settle', 'cancel'));

ALTER TABLE dvp_leg_action_requests
  DROP CONSTRAINT IF EXISTS dvp_leg_action_requests_side_check;
ALTER TABLE dvp_leg_action_requests
  ADD CONSTRAINT dvp_leg_action_requests_side_check
  CHECK (side IS NULL OR side IN ('a', 'b'));

-- A leg action names its side; a close has none to name. Written as an equality
-- so neither a sideless fund nor a close carrying a side can be stored.
ALTER TABLE dvp_leg_action_requests
  DROP CONSTRAINT IF EXISTS dvp_leg_action_requests_side_presence_check;
ALTER TABLE dvp_leg_action_requests
  ADD CONSTRAINT dvp_leg_action_requests_side_presence_check
  CHECK ((side IS NOT NULL) = (action IN ('fund', 'reclaim')));

-- Replaces 0101's inline pairing of signature/amount/expiry_height, which
-- required an amount alongside every recorded signature. The signature and the
-- height it expires at are still written together, because a retry needs both
-- to ask the chain what the transaction did. The amount is now a leg action's
-- alone: it is that action's answer, and a close does not have one.
ALTER TABLE dvp_leg_action_requests
  DROP CONSTRAINT IF EXISTS dvp_leg_action_requests_check;
ALTER TABLE dvp_leg_action_requests
  DROP CONSTRAINT IF EXISTS dvp_leg_action_requests_attempt_complete_check;
ALTER TABLE dvp_leg_action_requests
  ADD CONSTRAINT dvp_leg_action_requests_attempt_complete_check
  CHECK (
    (signature IS NULL) = (expiry_height IS NULL)
    AND (amount IS NULL OR action IN ('fund', 'reclaim'))
    AND (action NOT IN ('fund', 'reclaim') OR (signature IS NULL) = (amount IS NULL))
  );

COMMENT ON COLUMN dvp_leg_action_requests.side IS
  'The leg a fund or reclaim acts on. NULL for a settle or cancel, which close the whole trade.';
COMMENT ON COLUMN dvp_leg_action_requests.amount IS
  'Base units a fund or reclaim moved, replayed to a retry. NULL for a close, which moves both legs.';
