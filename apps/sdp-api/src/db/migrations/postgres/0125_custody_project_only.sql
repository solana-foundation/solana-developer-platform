-- sdp:migration-compat: breaking
-- Custody is per project (HOO-1970, ADR 0006). Every custody config and custody
-- default belongs to a Project, and nothing can be org-level again. Each
-- org-level row (project_id IS NULL) moves into its organization's active
-- Sandbox project. Wallets reference their config by id, so moving a config
-- moves its wallets, and the config keeps its id, so cached signing adapters
-- stay valid.
--
-- An org-level config for a provider the Sandbox project already holds in a
-- non-archived state (active or inactive) is archived and still takes the
-- Sandbox project_id: the explicit project setup wins and stays untouched, NOT
-- NULL holds, and the archived config's wallets stay on record but refuse to
-- sign. A Sandbox config that is itself archived is no collision; the org-level
-- config moves in with its status unchanged.
--
-- Ordering: ships in a migrations-only PR after the image that stops reading
-- and writing org-level custody is in production. That image's config upsert
-- names `ON CONFLICT (organization_id, project_id, provider) WHERE status <> 'archived'`,
-- which infers both the constraint dropped here and the partial index that
-- replaces it.
--
-- Rollout: an older image cannot run on this schema. Its upsert names no index
-- predicate and cannot infer a partial index, so every custody initialize fails
-- with 42P10; any org-level write fails NOT NULL with 23502.

-- The collision probe and the moves must see the same rows. Every ALTER below
-- takes this lock until commit anyway; taking it first only covers the probe.
-- lock_timeout bounds the wait: a long-running transaction on either table
-- fails the migration instead of queueing all custody traffic behind it.
SET LOCAL lock_timeout = '5s';
LOCK TABLE custody_configs, custody_scope_defaults IN ACCESS EXCLUSIVE MODE;

-- Fails the migration, rather than leaving a row unmoved, when an organization
-- holding org-level custody has no active Sandbox project.
DO $$
DECLARE
    unplaced_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO unplaced_count
      FROM (
          SELECT organization_id FROM custody_configs WHERE project_id IS NULL
          UNION ALL
          SELECT organization_id FROM custody_scope_defaults WHERE project_id IS NULL
      ) org_level
     WHERE NOT EXISTS (
         SELECT 1
           FROM projects p
          WHERE p.organization_id = org_level.organization_id
            AND p.environment = 'sandbox'
            AND p.status = 'active'
     );

    IF unplaced_count > 0 THEN
        RAISE EXCEPTION '% org-level custody row(s) belong to an organization with no active Sandbox project', unplaced_count;
    END IF;
END;
$$;

-- uq_projects_org_environment_active (0096) allows one active Sandbox project
-- per organization, and custody_configs_org_project_provider_key (0056) allows
-- one Sandbox config per provider, so each org-level config yields one row.
CREATE TEMP TABLE org_custody_config_moves ON COMMIT DROP AS
SELECT config.id AS custody_config_id,
       sandbox.id AS sandbox_project_id,
       sandbox_config.id AS colliding_config_id
  FROM custody_configs config
  JOIN projects sandbox
    ON sandbox.organization_id = config.organization_id
   AND sandbox.environment = 'sandbox'
   AND sandbox.status = 'active'
  LEFT JOIN custody_configs sandbox_config
    ON sandbox_config.organization_id = config.organization_id
   AND sandbox_config.project_id = sandbox.id
   AND sandbox_config.provider = config.provider
   AND sandbox_config.status <> 'archived'
 WHERE config.project_id IS NULL;

-- The NULLS NOT DISTINCT key (0056) is non-deferrable and would reject a moved
-- row the moment it shares (organization, project, provider) with a Sandbox
-- row, so it goes before the moves; its replacement is built after them.
ALTER TABLE custody_configs
    DROP CONSTRAINT custody_configs_org_project_provider_key;

-- Neither statement touches id or default_wallet_id, so the deferred
-- custody_configs_default_wallet_fkey (0056) is unaffected.
UPDATE custody_configs config
   SET project_id = move.sandbox_project_id,
       status = 'archived',
       updated_at = sdp_iso_now()
  FROM org_custody_config_moves move
 WHERE config.id = move.custody_config_id
   AND move.colliding_config_id IS NOT NULL;

UPDATE custody_configs config
   SET project_id = move.sandbox_project_id
  FROM org_custody_config_moves move
 WHERE config.id = move.custody_config_id
   AND move.colliding_config_id IS NULL;

-- custody_scope_defaults is a pointer table with no status column: where the
-- Sandbox project already has a default, the org-level pointer is deleted and
-- the Sandbox selection stands.
DELETE FROM custody_scope_defaults org_default
 USING projects sandbox
 WHERE org_default.project_id IS NULL
   AND sandbox.organization_id = org_default.organization_id
   AND sandbox.environment = 'sandbox'
   AND sandbox.status = 'active'
   AND EXISTS (
       SELECT 1
         FROM custody_scope_defaults sandbox_default
        WHERE sandbox_default.organization_id = org_default.organization_id
          AND sandbox_default.project_id = sandbox.id
   );

-- A surviving org-level default that selected a config archived above selects
-- the Sandbox config that config collided with.
UPDATE custody_scope_defaults org_default
   SET default_custody_config_id = move.colliding_config_id,
       updated_at = sdp_iso_now()
  FROM org_custody_config_moves move
 WHERE org_default.project_id IS NULL
   AND org_default.default_custody_config_id = move.custody_config_id
   AND move.colliding_config_id IS NOT NULL;

UPDATE custody_scope_defaults org_default
   SET project_id = sandbox.id
  FROM projects sandbox
 WHERE org_default.project_id IS NULL
   AND sandbox.organization_id = org_default.organization_id
   AND sandbox.environment = 'sandbox'
   AND sandbox.status = 'active';

-- The policy evaluator matches a wallet's profile on the caller's project or
-- NULL, so a profile left on another project would stop governing its moved
-- wallet. idx_wallet_control_profiles_active_wallet (0010) allows one active
-- profile per wallet, so the repoint cannot collide.
UPDATE wallet_control_profiles profile
   SET project_id = move.sandbox_project_id
  FROM custody_wallets wallet
  JOIN org_custody_config_moves move ON move.custody_config_id = wallet.custody_config_id
 WHERE profile.custody_wallet_id = wallet.id
   AND profile.project_id IS DISTINCT FROM move.sandbox_project_id;

-- Mirrors CUSTODY_CONFIG_STATUSES in @sdp/types.
ALTER TABLE custody_configs
    ALTER COLUMN project_id SET NOT NULL,
    ADD CONSTRAINT custody_configs_status_check
        CHECK (status IN ('active', 'inactive', 'archived'));

-- One non-archived config per (organization, project, provider). 'inactive'
-- stays inside the key because the upsert reactivates it in place.
CREATE UNIQUE INDEX idx_custody_configs_org_project_provider_unarchived
    ON custody_configs (organization_id, project_id, provider)
    WHERE status <> 'archived';

ALTER TABLE custody_scope_defaults
    ALTER COLUMN project_id SET NOT NULL,
    DROP CONSTRAINT custody_scope_defaults_connection_project_only;

DROP INDEX idx_custody_scope_defaults_org_null_project;

CREATE UNIQUE INDEX idx_custody_scope_defaults_org_project
    ON custody_scope_defaults (organization_id, project_id);

DROP INDEX idx_custody_scope_defaults_org_project_not_null;
