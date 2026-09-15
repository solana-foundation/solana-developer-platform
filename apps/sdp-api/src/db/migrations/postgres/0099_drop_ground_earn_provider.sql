-- Remove the Ground Earn provider and all of its data.
--
-- Ground was the one custodial portfolio provider: SDP provisioned an omnibus
-- program wallet, the customer funded it, and the provider rebalanced across
-- yield sources. The product decision is that Ground goes away entirely — no
-- surfaces, and no actions, not even withdrawals — so existing balances are
-- dropped rather than kept payable (ADR 0002, 2026-09 addendum). The code side
-- (client, registry entries, credentials, surfacing) was removed in the same
-- change; this migration is the data half.
--
-- Deleting is ordered by the FK graph: earn_movements → earn_positions →
-- earn_provider_wallets → earn_strategies (none of the FKs cascade). The
-- movement history for Ground programs is deleted with everything else — the
-- ledger rows reference positions that would no longer exist, and per the
-- product decision the history is not kept readable.
--
-- `provider` is open TEXT everywhere (ADR 0001/0002), so these deletes match
-- on the literal and never depended on the registry entry that used to admit
-- it. Any id that is no longer registered fails closed at dispatch
-- (`resolveEarnProviderClient`), so a row that survived this migration could
-- never be served anyway — deleting keeps the read models truthful instead of
-- merely unreachable.
--
-- Organization settings JSONB may still carry a stale
-- `providerOverrides.earn.ground` entitlement flag. That is left alone
-- deliberately: the overrides applier ignores keys outside `EARN_PROVIDERS`,
-- so a stale flag is inert, and rewriting every organization's settings JSONB
-- to delete an inert key is not worth the write amplification.

DELETE FROM earn_movements
 WHERE provider = 'ground';

DELETE FROM earn_positions
 WHERE provider = 'ground';

DELETE FROM earn_provider_wallets
 WHERE provider = 'ground';

DELETE FROM earn_strategies
 WHERE provider = 'ground';
