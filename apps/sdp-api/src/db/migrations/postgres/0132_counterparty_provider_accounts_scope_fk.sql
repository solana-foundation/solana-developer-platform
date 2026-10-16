-- sdp:migration-compat: breaking
-- A counterparty provider account belongs to its counterparty's organization and
-- project. The single-column foreign key from 0072 checked only that the
-- counterparty exists, so the database never compared the two rows' tenancy.
-- The composite key, the one counterparty_accounts already uses, makes a
-- mismatched row impossible. Delete behavior stays NO ACTION, as before.
-- A mismatched row on a deployed database aborts this migration.
ALTER TABLE counterparty_provider_accounts
    DROP CONSTRAINT counterparty_provider_accounts_counterparty_id_fkey,
    ADD CONSTRAINT counterparty_provider_accounts_counterparty_scope_fkey
        FOREIGN KEY (counterparty_id, organization_id, project_id)
        REFERENCES counterparties (id, organization_id, project_id);
