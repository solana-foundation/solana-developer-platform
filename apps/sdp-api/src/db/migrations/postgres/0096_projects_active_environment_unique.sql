-- PLANNED DELETION — project consolidation.
-- Every organization has exactly two projects, both active: default-sandbox
-- and default-production. There is no legacy shape. Any other row — a project
-- created through the removed POST /v1/projects, or a default archived through
-- the removed DELETE /v1/projects — is consolidated away: dropped outright,
-- and its data with it. Every foreign key to projects cascades or nulls except
-- api_keys (RESTRICT), whose rows go first and whose own dependents cascade.
-- Pre-mainnet, no production funds; anything worth keeping is moved onto the
-- default projects before this runs, never reconciled here.
-- wallet_operations.project_id and .api_key_id are ON DELETE SET NULL, and
-- the family check (rebuilt NOT VALID in 0058/0060) re-fires on those updates,
-- so historical rows carrying retired families abort either DELETE below.
-- Lift the check first and restore it NOT VALID, exactly as 0060 left it.
ALTER TABLE wallet_operations
    DROP CONSTRAINT wallet_operations_family_check;

-- The project cascade cannot run unattended: NO ACTION references from
-- surviving tables, RESTRICT references whose firing depends on cascade
-- order, and CHECK constraints that an FK-driven SET NULL would break all
-- abort it against historical data. Consolidated rows are removed in
-- dependency order; nullable custody references on rows that outlive their
-- wallet are detached. Temp views keep the predicates single-sourced.
CREATE TEMP VIEW doomed_projects AS
SELECT id FROM projects
 WHERE NOT (status = 'active'
            AND slug = CASE environment
                         WHEN 'sandbox' THEN 'default-sandbox'
                         ELSE 'default-production'
                       END);

CREATE TEMP VIEW doomed_custody_wallets AS
SELECT cw.id
  FROM custody_wallets cw
LEFT JOIN custody_configs cc ON cc.id = cw.custody_config_id
LEFT JOIN custody_connections cn ON cn.id = cw.custody_connection_id
 WHERE cc.project_id IN (SELECT id FROM doomed_projects)
    OR cn.project_id IN (SELECT id FROM doomed_projects);

DELETE FROM api_keys
 WHERE project_id IN (SELECT id FROM doomed_projects);

DELETE FROM counterparty_provider_accounts
 WHERE counterparty_id IN (SELECT id FROM counterparties WHERE project_id IN (SELECT id FROM doomed_projects))
    OR project_id IN (SELECT id FROM doomed_projects);

DELETE FROM payment_transfer_recipients
 WHERE project_id IN (SELECT id FROM doomed_projects);

DELETE FROM payment_recurring_payments
 WHERE project_id IN (SELECT id FROM doomed_projects)
    OR source_custody_wallet_id IN (SELECT id FROM doomed_custody_wallets);

DELETE FROM dvp_leg_funding_claims
 WHERE project_id IN (SELECT id FROM doomed_projects)
    OR custody_wallet_id IN (SELECT id FROM doomed_custody_wallets);

DELETE FROM dvp_settlement_wallets
 WHERE project_id IN (SELECT id FROM doomed_projects)
    OR custody_wallet_id IN (SELECT id FROM doomed_custody_wallets);

DELETE FROM dvp_trades
 WHERE project_id IN (SELECT id FROM doomed_projects);

DELETE FROM helius_rings_operations
 WHERE project_id IN (SELECT id FROM doomed_projects);

DELETE FROM helius_rings_wallets
 WHERE project_id IN (SELECT id FROM doomed_projects)
    OR custody_wallet_id IN (SELECT id FROM doomed_custody_wallets);

DELETE FROM helius_rings_connections
 WHERE project_id IN (SELECT id FROM doomed_projects);

-- Detached wallet operations would be picked up by the policy inventory's
-- legacy wallet_id fallback join and misattributed to surviving wallets, so
-- rows of dying wallets are dropped rather than detached.
DELETE FROM wallet_operations
 WHERE custody_wallet_id IN (SELECT id FROM doomed_custody_wallets);

DELETE FROM earn_movements
 WHERE custody_wallet_id IN (SELECT id FROM doomed_custody_wallets);

DELETE FROM earn_positions
 WHERE custody_wallet_id IN (SELECT id FROM doomed_custody_wallets);

DELETE FROM api_key_wallet_policy_bindings
 WHERE custody_wallet_id IN (SELECT id FROM doomed_custody_wallets);

UPDATE payment_transfers SET custody_wallet_id = NULL
 WHERE custody_wallet_id IN (SELECT id FROM doomed_custody_wallets);

UPDATE payment_transfer_batches SET source_custody_wallet_id = NULL
 WHERE source_custody_wallet_id IN (SELECT id FROM doomed_custody_wallets);

UPDATE payment_requests SET custody_wallet_id = NULL
 WHERE custody_wallet_id IN (SELECT id FROM doomed_custody_wallets);

UPDATE payment_recurring_payment_update_attempts SET new_source_custody_wallet_id = NULL
 WHERE new_source_custody_wallet_id IN (SELECT id FROM doomed_custody_wallets);

UPDATE issued_tokens SET signing_custody_wallet_id = NULL
 WHERE signing_custody_wallet_id IN (SELECT id FROM doomed_custody_wallets);

UPDATE issuance_transactions SET custody_wallet_id = NULL
 WHERE custody_wallet_id IN (SELECT id FROM doomed_custody_wallets);

DELETE FROM custody_wallets
 WHERE id IN (SELECT id FROM doomed_custody_wallets);

DELETE FROM projects
 WHERE NOT (status = 'active'
            AND slug = CASE environment
                         WHEN 'sandbox' THEN 'default-sandbox'
                         ELSE 'default-production'
                       END);

DROP VIEW doomed_custody_wallets;
DROP VIEW doomed_projects;

ALTER TABLE wallet_operations
    ADD CONSTRAINT wallet_operations_family_check
        CHECK (operation_family IN ('transfer', 'payment', 'ramp', 'issuance', 'program'))
        NOT VALID;

-- Every organization with an active member gets both defaults; an organization
-- with none is provisioned on its first authenticated request, as today.
INSERT INTO projects (
    id, organization_id, name, slug, description,
    environment, settings, status, created_by, created_at, updated_at
)
SELECT
    'prj_' || gen_random_uuid(),
    o.id,
    d.name,
    d.slug,
    d.description,
    d.environment,
    NULL,
    'active',
    first_member.user_id,
    sdp_datetime_now(),
    sdp_datetime_now()
FROM   organizations o
CROSS JOIN (VALUES
    ('Default Sandbox Project',    'default-sandbox',    'Default sandbox project',    'sandbox'),
    ('Default Production Project', 'default-production', 'Default production project', 'production')
) AS d(name, slug, description, environment)
JOIN LATERAL (
    SELECT user_id
    FROM   organization_members
    WHERE  organization_id = o.id
      AND  status          = 'active'
    ORDER  BY created_at ASC
    LIMIT  1
) first_member ON true
WHERE NOT EXISTS (
    SELECT 1
    FROM   projects p
    WHERE  p.organization_id = o.id
      AND  p.slug            = d.slug
)
ON CONFLICT (organization_id, slug) DO NOTHING;

-- Every active organization member belongs to both default projects.
INSERT INTO project_members (id, project_id, user_id, role, created_at)
SELECT
    'pm_' || gen_random_uuid(),
    p.id,
    om.user_id,
    'admin',
    sdp_datetime_now()
FROM   projects             p
JOIN   organization_members om
       ON  om.organization_id = p.organization_id
       AND om.status          = 'active'
WHERE  p.slug IN ('default-sandbox', 'default-production')
ON CONFLICT (project_id, user_id) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_org_environment_active
  ON projects (organization_id, environment)
  WHERE status = 'active';
