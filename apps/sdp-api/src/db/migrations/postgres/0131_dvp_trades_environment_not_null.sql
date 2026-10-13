-- sdp:migration-compat: breaking
-- Contract step for 0130: every DvP trade records its project's environment.
-- A trade the previous image inserted without one is backfilled from its
-- project first, then the column becomes NOT NULL. Ships in the same deploy as
-- 0130 and the DvP code that writes the column, so no NULL row outlives the
-- rollout. Rollout: an image that inserts a trade without environment fails
-- with 23502.

SET LOCAL lock_timeout = '5s';

LOCK TABLE dvp_trades IN ACCESS EXCLUSIVE MODE;

UPDATE dvp_trades trade
   SET environment = project.environment
  FROM projects project
 WHERE project.id = trade.project_id
   AND trade.environment IS NULL;

ALTER TABLE dvp_trades ALTER COLUMN environment SET NOT NULL;
