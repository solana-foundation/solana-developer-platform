-- sdp:migration-compat: breaking
-- A DvP trade records the environment of the project that created it, so a
-- counterparty acting from another project can be refused a trade from the
-- other environment. Party reads run under the caller's cluster scope, and the
-- creator's projects row is hidden from another organization by row-level
-- security, so the trade itself must carry it.
--
-- dvp_trades.environment is backfilled from the creating project and pinned
-- to it by a composite foreign key to projects (id, environment), as 0126 did
-- for custody configs. ON DELETE CASCADE mirrors dvp_trades_project_id_fkey;
-- ON UPDATE RESTRICT keeps a project that holds trades from changing
-- environment.
--
-- Expand step: the column stays nullable so the deployed image, which does
-- not write it yet, keeps inserting trades (MATCH SIMPLE skips a NULL
-- environment). The DvP code that writes it ships next, and a contract
-- migration then sets NOT NULL in the same deploy, so no NULL row written by
-- the old image outlives the rollout. Marked breaking because the composite
-- foreign key covers the existing project_id column; the schema itself stays
-- rollback-safe.

SET LOCAL lock_timeout = '5s';

LOCK TABLE projects IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE dvp_trades IN ACCESS EXCLUSIVE MODE;

ALTER TABLE dvp_trades ADD COLUMN environment TEXT;

UPDATE dvp_trades trade
   SET environment = project.environment
  FROM projects project
 WHERE project.id = trade.project_id;

ALTER TABLE dvp_trades
    ADD CONSTRAINT dvp_trades_project_environment_fkey
        FOREIGN KEY (project_id, environment)
        REFERENCES projects (id, environment)
        ON UPDATE RESTRICT
        ON DELETE CASCADE;
