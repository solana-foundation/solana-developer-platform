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
-- lock_timeout bounds the wait: a long-running transaction on any locked table
-- fails the migration instead of queueing all custody traffic behind it.
SET LOCAL lock_timeout = '5s';
LOCK TABLE custody_configs, custody_scope_defaults IN ACCESS EXCLUSIVE MODE;
-- The approval-group probe reads profiles, their revisions, and the groups;
-- SHARE ROW EXCLUSIVE holds writes to them off until commit and leaves reads.
LOCK TABLE approval_groups,
           wallet_control_profiles,
           wallet_control_profile_revisions,
           api_key_control_profiles,
           api_key_control_profile_revisions
    IN SHARE ROW EXCLUSIVE MODE;

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

-- Approval groups are project-scoped: an approver can act on a request only
-- when the request's group sits in the caller's project. A profile repointed
-- into the Sandbox project below keeps its rules, so every group those rules
-- name (approvalGroupId on a rule in any revision) must sit in the Sandbox
-- project too. Archived profiles never evaluate and are left out.
CREATE TEMP TABLE moved_profile_approval_groups ON COMMIT DROP AS
SELECT DISTINCT profile.organization_id,
       move.sandbox_project_id,
       rule ->> 'approvalGroupId' AS approval_group_id
  FROM wallet_control_profiles profile
  JOIN custody_wallets wallet ON wallet.id = profile.custody_wallet_id
  JOIN org_custody_config_moves move ON move.custody_config_id = wallet.custody_config_id
  JOIN wallet_control_profile_revisions revision ON revision.profile_id = profile.id
 CROSS JOIN LATERAL jsonb_array_elements(revision.rules) rule
 WHERE profile.status <> 'archived'
   AND rule ->> 'approvalGroupId' IS NOT NULL;

-- Every non-archived wallet or API key profile that is not repointed below,
-- with the groups its rules name.
CREATE TEMP TABLE staying_profile_approval_groups ON COMMIT DROP AS
SELECT profile.project_id,
       rule ->> 'approvalGroupId' AS approval_group_id
  FROM wallet_control_profiles profile
  JOIN wallet_control_profile_revisions revision ON revision.profile_id = profile.id
 CROSS JOIN LATERAL jsonb_array_elements(revision.rules) rule
 WHERE profile.status <> 'archived'
   AND rule ->> 'approvalGroupId' IS NOT NULL
   AND NOT EXISTS (
       SELECT 1
         FROM custody_wallets wallet
         JOIN org_custody_config_moves move ON move.custody_config_id = wallet.custody_config_id
        WHERE wallet.id = profile.custody_wallet_id
   )
UNION ALL
SELECT profile.project_id,
       rule ->> 'approvalGroupId' AS approval_group_id
  FROM api_key_control_profiles profile
  JOIN api_key_control_profile_revisions revision ON revision.profile_id = profile.id
 CROSS JOIN LATERAL jsonb_array_elements(revision.rules) rule
 WHERE profile.status <> 'archived'
   AND rule ->> 'approvalGroupId' IS NOT NULL;

-- An org-level group named by a moved profile follows it into the Sandbox
-- project; its members reference the group by id and follow with it.
CREATE TEMP TABLE approval_group_moves ON COMMIT DROP AS
SELECT DISTINCT grp.id AS approval_group_id,
       ref.sandbox_project_id
  FROM moved_profile_approval_groups ref
  JOIN approval_groups grp
    ON grp.id = ref.approval_group_id
   AND grp.organization_id = ref.organization_id
 WHERE grp.project_id IS NULL;

-- Fails the migration, rather than stranding approvals or moving a group out
-- from under a profile that keeps using it, when a moved profile names a group
-- held by another project or organization, or an org-level group that a
-- profile staying outside that Sandbox project also names.
DO $$
DECLARE
    foreign_group_count BIGINT;
    shared_group_count BIGINT;
BEGIN
    SELECT COUNT(DISTINCT grp.id) INTO foreign_group_count
      FROM moved_profile_approval_groups ref
      JOIN approval_groups grp ON grp.id = ref.approval_group_id
     WHERE grp.organization_id <> ref.organization_id
        OR (grp.project_id IS NOT NULL AND grp.project_id <> ref.sandbox_project_id);

    SELECT COUNT(DISTINCT move.approval_group_id) INTO shared_group_count
      FROM approval_group_moves move
      JOIN staying_profile_approval_groups ref
        ON ref.approval_group_id = move.approval_group_id
     WHERE ref.project_id IS DISTINCT FROM move.sandbox_project_id;

    IF foreign_group_count > 0 THEN
        RAISE EXCEPTION '% approval group(s) named by moved custody profiles belong to another project', foreign_group_count;
    END IF;

    IF shared_group_count > 0 THEN
        RAISE EXCEPTION '% org-level approval group(s) named by moved custody profiles are also named by profiles outside the Sandbox project', shared_group_count;
    END IF;
END;
$$;

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

-- approval_group_members carries no project column, so the members move with
-- their group.
UPDATE approval_groups grp
   SET project_id = move.sandbox_project_id
  FROM approval_group_moves move
 WHERE grp.id = move.approval_group_id;

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
