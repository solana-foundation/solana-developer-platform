-- sdp:migration-compat: breaking
-- Custody has no defaults, Managed custody configs are Sandbox-only, and BYOK
-- custody connections are project-scoped (HOO-1970, ADR 0006). The schema can
-- no longer express a default, and the database itself rejects a Managed
-- config on a Production project and a connection bound to an
-- organization-scoped credential, so each rule holds even where an application
-- check is missed.
--
-- 1. custody_scope_defaults is dropped, with its RLS policy and foreign keys.
-- 2. custody_configs.default_wallet_id is dropped, with its deferrable
--    (id, default_wallet_id) foreign key from 0056.
-- 3. custody_connections.default_custody_wallet_id stays for now. The deployed
--    image still writes it once in recordInstallationSuccess, solely because
--    the 0051 active-lifecycle CHECK requires it. Here that CHECK loses its
--    default-wallet clause and the 0046 default-wallet ownership foreign key is
--    dropped; the column (and idx_custody_connections_default_wallet from 0023)
--    goes in a follow-up migration once that write is removed (ticket 11).
-- 4. custody_configs.project_environment carries its project's environment
--    through a composite foreign key to projects (id, environment), pinned to
--    'sandbox' by a CHECK. ON UPDATE RESTRICT keeps a project that holds
--    Managed configs from being switched to Production. The foreign key
--    counts archived configs too, so a project that ever held a Managed
--    config can never move to Production. Nothing in the application changes
--    a project's environment today, so this is accepted.
-- 5. custody_connections_credential_scope_check drops both '__organization__'
--    arms: a connection is project-scoped and its credential's scope key is
--    its own project.
--
-- Archived configs never reactivate: idx_custody_configs_org_project_provider_unarchived
-- (0125) is partial on status <> 'archived' and is the custody config upsert's
-- conflict target, so this file leaves it unchanged.
--
-- Ordering: ships in a migrations-only PR after the images from tickets 05
-- (stops reading and writing custody defaults) and 06 (refuses Managed custody
-- in Production projects) are in production.
--
-- Rollout: that image runs unchanged on this schema. Its config upsert names no
-- project_environment, so the 'sandbox' default fills it and the foreign key
-- checks it; its connection insert is always project-scoped against a project
-- credential. An older image cannot run on this schema: any custody default
-- read or write fails with 42P01 (custody_scope_defaults) or 42703
-- (default_wallet_id).

-- The guards and the constraints they protect must see the same rows, so every
-- table the DDL below locks is locked before the guards run. The DDL takes
-- ACCESS EXCLUSIVE until commit on each table it names, and also on every
-- table a dropped foreign key references: dropping a foreign key drops its
-- referential triggers on the referenced table, and dropping a trigger
-- exclusive-locks that table (RemoveTriggerById). That adds organizations
-- (custody_scope_defaults_organization_id_fkey) and custody_wallets
-- (custody_configs_default_wallet_fkey,
-- custody_connections_default_wallet_owner_fkey). The list runs parent before
-- child, as in 0125, so this migration never holds a child while queueing for
-- its parent. lock_timeout bounds each wait: a long-running transaction on any
-- of these tables fails the migration instead of queueing all traffic on them
-- behind it.
SET LOCAL lock_timeout = '5s';

LOCK TABLE organizations, projects, custody_configs, custody_connections,
    custody_wallets, custody_scope_defaults
    IN ACCESS EXCLUSIVE MODE;

-- Fails the migration, rather than deleting or moving anything, when a custody
-- config belongs to a Production project.
DO $$
DECLARE
    production_config_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO production_config_count
      FROM custody_configs config
      JOIN projects project ON project.id = config.project_id
     WHERE project.environment <> 'sandbox';

    IF production_config_count > 0 THEN
        RAISE EXCEPTION '% custody config(s) belong to a Production project', production_config_count;
    END IF;
END;
$$;

-- Fails the migration, rather than deleting anything, when a custody
-- connection is organization-scoped or bound to a credential outside its own
-- project.
DO $$
DECLARE
    organization_scoped_connection_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO organization_scoped_connection_count
      FROM custody_connections
     WHERE scope <> 'project'
        OR provider_credential_scope_key IS DISTINCT FROM project_id;

    IF organization_scoped_connection_count > 0 THEN
        RAISE EXCEPTION '% custody connection(s) are not bound to a credential scoped to their own project', organization_scoped_connection_count;
    END IF;
END;
$$;

DROP TABLE custody_scope_defaults;

ALTER TABLE custody_configs
    DROP CONSTRAINT custody_configs_default_wallet_fkey,
    DROP COLUMN default_wallet_id;

-- Every clause except the default wallet is 0051's, unchanged.
ALTER TABLE custody_connections
    DROP CONSTRAINT custody_connections_default_wallet_owner_fkey,
    DROP CONSTRAINT custody_connections_active_lifecycle_check,
    ADD CONSTRAINT custody_connections_active_lifecycle_check
        CHECK (
            status <> 'active'
            OR (
                last_check_status IS NOT NULL
                AND last_check_status = 'success'
                AND last_check_at IS NOT NULL
                AND activated_at IS NOT NULL
            )
        );

-- custody_connections_scope_check makes project_id NOT NULL whenever scope is
-- 'project', so the equality below cannot pass on NULL.
ALTER TABLE custody_connections
    DROP CONSTRAINT custody_connections_credential_scope_check,
    ADD CONSTRAINT custody_connections_credential_scope_check
        CHECK (
            scope = 'project'
            AND provider_credential_scope_key = project_id
        );

-- Referenced by custody_configs_project_environment_fkey.
ALTER TABLE projects
    ADD CONSTRAINT projects_id_environment_unique UNIQUE (id, environment);

-- Managed custody is Sandbox-only. ON DELETE CASCADE mirrors
-- custody_configs_project_id_fkey.
ALTER TABLE custody_configs
    ADD COLUMN project_environment TEXT NOT NULL DEFAULT 'sandbox',
    ADD CONSTRAINT custody_configs_project_environment_check
        CHECK (project_environment = 'sandbox'),
    ADD CONSTRAINT custody_configs_project_environment_fkey
        FOREIGN KEY (project_id, project_environment)
        REFERENCES projects (id, environment)
        ON UPDATE RESTRICT
        ON DELETE CASCADE;
