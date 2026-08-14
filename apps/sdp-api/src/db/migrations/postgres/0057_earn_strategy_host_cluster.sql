-- Earn strategies: record the cluster the INSTRUMENT lives on.
--
-- Until now the environment implied the cluster: Ground's catalogue gate only
-- admits a yield source hosted on that environment's own Solana chain, so a
-- sandbox row was devnet by construction. Kamino breaks that implication. Its
-- K-Vaults are deployed on mainnet only (`/kvaults/*` takes no env parameter,
-- and there is no devnet deployment), and SDP catalogues the mainnet shelf into
-- BOTH environments so sandbox integrators can browse the real vaults.
--
-- Those sandbox rows name a live mainnet vault and a mainnet mint. Everything
-- about them is true and none of it is fundable from devnet, and no existing
-- column can say so: `status` is the operator's stop switch, and reusing it
-- would both misstate the reason and collide with the sync's refusal to
-- overwrite an operator pause. So the row states the cluster, and the gates
-- read it — `assertKnownYieldSources` before any provider mutation, the derived
-- `fundable` on the strategies wire shape, and the dashboard's strategy filter.
--
-- Open TEXT with the closed union in code, per ADR 0001.
--
-- EXPAND ONLY — the column stays NULLABLE in this release, deliberately.
-- deploy-sdp-api-gcp.yml runs this migration BEFORE it updates the service and
-- the cron image, and a rollback restores the previous image without reverting
-- the schema. The previous catalogue writer's INSERT does not list
-- `host_cluster`, so a NOT NULL here would fail every upsert made in that
-- window — and permanently after a rollback, leaving the restored job unable to
-- refresh the shelf. The CONTRACT half (SET NOT NULL) belongs in a later
-- release, once no deployable writer predates this column.
--
-- Nullability is not a hole in the invariant: `UpsertEarnStrategyInput.hostCluster`
-- is required, so every writer on this release states it, and the repository's
-- read derives the environment's own cluster for any row an older writer left
-- NULL — the same rule as the backfill below, so such a row stays correct and
-- fundable rather than silently dropping out of the catalogue.

ALTER TABLE earn_strategies ADD COLUMN IF NOT EXISTS host_cluster TEXT;

-- Backfill is exact rather than a guess: every row predating this migration was
-- written by the Ground sync (or the local dev seed, which mirrors it), and both
-- only ever catalogue a source hosted on the environment's own chain.
UPDATE earn_strategies
   SET host_cluster = CASE environment
                        WHEN 'production' THEN 'mainnet-beta'
                        ELSE 'devnet'
                      END
 WHERE host_cluster IS NULL;
