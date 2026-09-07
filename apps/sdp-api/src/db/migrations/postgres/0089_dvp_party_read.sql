-- Let a named party read the trade that names it (PRO-1855).
--
-- An agent trade names two parties who were not in the room when it was
-- created, so neither learns it exists unless somebody sends them the address
-- out of band. Discovery needs them to be able to read the row, and today they
-- cannot: 0086 forces row-level security on `dvp_trades` and
-- `sdp_tenant_isolation_allows` fails closed for any organization but the one
-- that created it.
--
-- This discloses nothing. The trade account is public on chain and its parties,
-- mints, amounts and escrow addresses are readable by anyone holding the PDA,
-- with the checked decoders in `@sdp/dvp`. Telling a party about a trade that
-- names it hands over nothing it was not already entitled to read. What is ours
-- rather than the chain's — the creating organization and project, `ref_string`,
-- the creating org's wallet label, the idempotency key, the settlement
-- authority's funding readiness — is withheld by the serializer, not by this
-- policy, because those are columns on a row the party can now see.
--
-- Deliberately FOR SELECT. Policies are OR'd, so this widens reads and leaves
-- writes exactly where 0086 put them: `sdp_tenant_isolation` keeps the only
-- WITH CHECK, and a counterparty still cannot write to a row it does not own.
-- Funding by a second party (PRO-1854) therefore records its claim and receipt
-- on its own table rather than mutating this one, which is also what stops two
-- organizations sharing one funding lock.

-- ---------------------------------------------------------------------------
-- Is the calling tenant a party to this trade?
-- ---------------------------------------------------------------------------
--
-- The organization is matched EXPLICITLY here, against the same parents 0081
-- walks to scope `custody_wallets` (that table carries no `organization_id` of
-- its own; a wallet belongs to an org through its custody config or its
-- connection).
--
-- An earlier version left the scoping entirely to `custody_wallets`' own policy
-- — a policy expression runs as the calling role, so the nested read is
-- filtered and `EXISTS` can only match a wallet the caller owns. That is true,
-- and it was too subtle to rest a cross-organization boundary on: it reads as
-- an unscoped `EXISTS`, it silently widens if that policy is ever relaxed, and
-- under any role holding BYPASSRLS it matches every organization's wallets.
-- Verified by running: as a superuser this predicate answered true for an
-- address belonging to a different tenant entirely.
--
-- So the rule is written twice on purpose, and the duplication is the point:
-- the predicate below is correct on its own, and `custody_wallets`' policy
-- still applies underneath it. Either alone would refuse a stranger.
--
-- Restricted to the `tenant` identity because the privileged identities already
-- pass through `sdp_tenant_isolation_allows` and have no need of this path.
CREATE OR REPLACE FUNCTION sdp_dvp_caller_is_party(trade_user_a TEXT, trade_user_b TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT sdp_tenant_isolation_identity() = 'tenant'
     AND sdp_tenant_isolation_organization_id() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM custody_wallets cw
       LEFT JOIN custody_configs cfg ON cfg.id = cw.custody_config_id
       LEFT JOIN custody_connections conn ON conn.id = cw.custody_connection_id
       WHERE cw.public_key IN (trade_user_a, trade_user_b)
         AND cw.status = 'active'
         AND sdp_tenant_isolation_organization_id()
             IN (cfg.organization_id, conn.organization_id)
     )
$$;

DROP POLICY IF EXISTS sdp_dvp_party_read ON dvp_trades;
CREATE POLICY sdp_dvp_party_read ON dvp_trades
  FOR SELECT
  USING (sdp_dvp_caller_is_party(user_a, user_b));
