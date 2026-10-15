-- sdp:migration-compat: breaking
-- Every payment, payment request, counterparty, sponsorship reservation,
-- custody connection and provider credential belongs to a Project, so
-- projects.environment is the only source of a row's environment (HOO-1966).
-- No writer on main passes a NULL project_id to these tables, so a row without
-- one is leftover data and is deleted.
--
-- Only the tables written below are locked; projects and organizations are not,
-- because every tenant RLS policy reads projects (0081).
--
-- Deleting a NULL-project transfer or counterparty sets NULL on
-- payment_subscription_collection_attempts.transfer_id and
-- kyc_wallets.counterparty_id of any row that pointed at it. A kept payment
-- request fulfilled by a NULL-project transfer aborts this migration through its
-- NO ACTION foreign key.
--
-- Provider credentials become project-only: no writer creates an
-- organization-scoped one. Each GCP Secret Manager version outlives its row, so
-- it is queued for the retire-orphaned-secrets sweeper first; encrypted_db
-- ciphertext dies with the row. A Helius Rings connection still bound to an
-- organization-scoped credential aborts this migration through its RESTRICT
-- foreign key.
--
-- sponsorship_budget_reservations gains its foreign key to projects with
-- ON DELETE RESTRICT, not CASCADE: organization and global budget windows sum
-- reservations across every project, so deleting a project's rows would
-- un-count lamports already spent. Rows whose project no longer exists are
-- deleted first; 0096 removed projects while this table had no foreign key.
SET LOCAL lock_timeout = '5s';

LOCK TABLE counterparties, counterparty_provider_accounts, payment_transfers,
    payment_requests, sponsorship_budget_reservations, provider_credentials,
    custody_connections
    IN ACCESS EXCLUSIVE MODE;

DELETE FROM payment_requests
 WHERE project_id IS NULL;

DELETE FROM payment_transfers
 WHERE project_id IS NULL;

DELETE FROM counterparty_provider_accounts
 WHERE counterparty_id IN (SELECT id FROM counterparties WHERE project_id IS NULL);

DELETE FROM counterparties
 WHERE project_id IS NULL;

DELETE FROM sponsorship_budget_reservations
 WHERE project_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM projects WHERE projects.id = sponsorship_budget_reservations.project_id);

-- A GCP secret with no recorded version cannot be queued by version, and once
-- its row is gone nothing scans its container, so it aborts here for a human.
DO $$
DECLARE
    unversioned_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO unversioned_count
      FROM provider_credentials
     WHERE project_id IS NULL
       AND storage_backend = 'gcp_secret_manager'
       AND secret_ref IS NOT NULL
       AND secret_version_ref IS NULL;

    IF unversioned_count > 0 THEN
        RAISE EXCEPTION '% organization-scoped GCP credential(s) have a secret but no recorded version', unversioned_count;
    END IF;
END;
$$;

INSERT INTO secret_retirements
    (id, organization_id, source_id, storage_backend, secret_ref, secret_version_ref, last_error)
SELECT 'wf_secret_retirement_' || gen_random_uuid(),
       organization_id,
       id,
       storage_backend,
       secret_ref,
       secret_version_ref,
       'organization-scoped provider credential removed (0129)'
  FROM provider_credentials
 WHERE project_id IS NULL
   AND storage_backend = 'gcp_secret_manager'
   AND secret_version_ref IS NOT NULL
ON CONFLICT (secret_version_ref) DO NOTHING;

DELETE FROM provider_credentials
 WHERE project_id IS NULL;

ALTER TABLE payment_transfers ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE payment_requests ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE counterparties ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE sponsorship_budget_reservations
    ALTER COLUMN project_id SET NOT NULL,
    ADD CONSTRAINT sponsorship_budget_reservations_project_id_fkey
        FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT;

ALTER TABLE provider_credentials
    ALTER COLUMN project_id SET NOT NULL,
    DROP CONSTRAINT provider_credentials_scope_check,
    ADD CONSTRAINT provider_credentials_scope_check CHECK (scope = 'project');

ALTER TABLE custody_connections
    ALTER COLUMN project_id SET NOT NULL,
    DROP CONSTRAINT custody_connections_scope_check,
    ADD CONSTRAINT custody_connections_scope_check CHECK (scope = 'project');
