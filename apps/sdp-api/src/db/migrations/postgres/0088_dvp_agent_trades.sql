-- Trades where SDP sets the terms and holds neither leg (PRO-1853).
--
-- The party that submits a trade is not necessarily a party to it. An execution
-- agent setting up the on-chain swap details and having two counterparties do
-- the swaps is the more common arrangement.
--
-- The program never required otherwise. `CreateDvp`'s only signer is the payer;
-- `user_a`, `user_b` and `settlement_authority` are plain non-signer accounts,
-- which is exactly how every counterparty leg has been funded in testing. The
-- assumption was ours, and it lived in this table: `sdp_side NOT NULL` said SDP
-- always holds one of the two legs.
--
-- This does NOT replace that shape. V1 was scoped around SDP optionally holding
-- one side (PRO-1830); principal trades stay exactly as they are, and stay the
-- default. Agent trades are a second kind alongside.
--
-- `sdp_wallet_id` stays NOT NULL for both kinds. On an agent trade that wallet
-- still signs the create, pays the network fee and pays rent for both escrows.
-- It simply delivers nothing.

ALTER TABLE dvp_trades
    ADD COLUMN IF NOT EXISTS trade_kind TEXT NOT NULL DEFAULT 'principal';

-- Written as its own statement rather than inline so re-running is safe.
ALTER TABLE dvp_trades
    DROP CONSTRAINT IF EXISTS dvp_trades_trade_kind_check;
ALTER TABLE dvp_trades
    ADD CONSTRAINT dvp_trades_trade_kind_check
    CHECK (trade_kind IN ('principal', 'agent'));

-- An agent trade has no SDP leg, so the side it would name does not exist.
ALTER TABLE dvp_trades
    ALTER COLUMN sdp_side DROP NOT NULL;

-- The two columns are only meaningful together, so tie them in the schema
-- rather than trusting every writer to remember. A principal trade without a
-- side would make `sdpLegOf` pick leg B by falling through its "a" check, which
-- is how a trade could quietly fund the wrong leg; an agent trade WITH a side
-- would claim SDP holds a leg it holds no key for.
--
-- The original `sdp_side IN ('a','b')` check still stands and still permits
-- NULL, because a CHECK passes on NULL. This adds the part that does not.
ALTER TABLE dvp_trades
    DROP CONSTRAINT IF EXISTS dvp_trades_kind_side_check;
ALTER TABLE dvp_trades
    ADD CONSTRAINT dvp_trades_kind_side_check
    CHECK (
        (trade_kind = 'principal' AND sdp_side IS NOT NULL)
        OR (trade_kind = 'agent' AND sdp_side IS NULL)
    );

-- Discovery reads trades by the addresses that are party to them, which no
-- existing index serves: dvp_trades is indexed by (project_id, status) and
-- (project_id, updated_at). An agent trade names two parties who were not in
-- the room when it was created, so being able to find it by party is what makes
-- it reachable at all (PRO-1855).
CREATE INDEX IF NOT EXISTS dvp_trades_user_a_idx ON dvp_trades(user_a);
CREATE INDEX IF NOT EXISTS dvp_trades_user_b_idx ON dvp_trades(user_b);
