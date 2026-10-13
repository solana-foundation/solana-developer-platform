-- sdp:migration-compat: breaking
-- Every payment, counterparty, sponsorship reservation and custody connection
-- belongs to a Project (HOO-1966): project_id becomes NOT NULL on
-- payment_transfers, payment_requests, counterparties,
-- sponsorship_budget_reservations and custody_connections, rows with a NULL
-- project_id are deleted, and sponsorship_budget_reservations gains the
-- CASCADE foreign key to projects its siblings carry. signing_requests is
-- dropped: nothing reads or writes it.
--
-- Production on-chain rows are deleted with no time cutoff. Until Production
-- projects route to mainnet, every Production request ran on the process
-- default cluster, devnet, so each such row describes devnet state a
-- mainnet-cluster tracker would re-read and never find. Pre-mainnet there are
-- no real users. Configuration rows (counterparties, Rings connections,
-- Private Channels instances, channels, users and wallets, KYC wallets) are
-- kept; reservations carry their cluster, so only network = 'devnet' goes.
--
-- Earn is excluded: it has routed by the project's environment since Aug 17
-- 2026, so its Production rows are already mainnet. Instead each Earn table
-- carrying both project_id and environment gets a composite foreign key to
-- projects (id, environment), so a row's environment can never disagree with
-- its project's. A mismatched row aborts this migration. MATCH SIMPLE skips
-- rows whose project was deleted, and ON DELETE SET NULL (project_id) keeps
-- their environment, as the forensic-attribution rule (ADR 0002) requires.
--
-- Rows that can be cleaned deterministically are deleted; a cross-project
-- fulfillment or an Earn environment mismatch aborts, as an invariant a human must see.
--
-- Rollout: an image that writes a NULL project_id to any of these tables
-- fails with 23502; one that touches signing_requests fails with 42P01.

-- Every table the DDL below alters, or whose referential triggers it drops or
-- adds, is locked before the deletes and the guard run, parent before child as
-- in 0126. lock_timeout bounds each wait, including the row locks the deletes
-- take later.
SET LOCAL lock_timeout = '5s';

LOCK TABLE organizations, projects, custody_configs, issuance_transactions,
    signing_requests, counterparties, payment_transfers, payment_requests,
    custody_connections, sponsorship_budget_reservations
    IN ACCESS EXCLUSIVE MODE;

LOCK TABLE earn_provider_wallets, earn_positions,
    earn_vault_withdrawal_requests, earn_vault_withdrawal_request_actions,
    earn_vault_withdrawal_request_reservations, earn_movements,
    earn_split_swap_advisories, earn_external_wallet_transactions,
    earn_external_wallet_withdrawal_request_transactions
    IN SHARE ROW EXCLUSIVE MODE;

-- Fails the migration, rather than deleting or unlinking a kept request, when
-- a request outside the deleted set is fulfilled by a transfer inside it.
-- payment_requests_fulfilled_by_transfer_id_fkey is single-column, so nothing
-- else keeps the two in one project.
DO $$
DECLARE
    cross_project_fulfillment_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO cross_project_fulfillment_count
      FROM payment_requests request
      JOIN projects request_project ON request_project.id = request.project_id
      JOIN payment_transfers transfer ON transfer.id = request.fulfilled_by_transfer_id
      LEFT JOIN projects transfer_project ON transfer_project.id = transfer.project_id
     WHERE request_project.environment <> 'production'
       AND (transfer.project_id IS NULL OR transfer_project.environment = 'production');

    IF cross_project_fulfillment_count > 0 THEN
        RAISE EXCEPTION '% kept payment request(s) are fulfilled by a deleted transfer', cross_project_fulfillment_count;
    END IF;
END;
$$;

DROP TABLE signing_requests;

DELETE FROM payment_requests
 WHERE project_id IS NULL
    OR project_id IN (SELECT id FROM projects WHERE environment = 'production');

-- Cascades payment_transfer_recipients, whose NO ACTION foreign key to
-- payment_transfers would otherwise block the transfer delete.
DELETE FROM payment_transfer_batches
 WHERE project_id IN (SELECT id FROM projects WHERE environment = 'production');

-- Cascades the activation, lifecycle and update attempts and update events.
-- Precedes subscriptions and plans, which it references with RESTRICT.
DELETE FROM payment_recurring_payments
 WHERE project_id IN (SELECT id FROM projects WHERE environment = 'production');

-- Cascades payment_subscription_collection_attempts.
DELETE FROM payment_subscriptions
 WHERE project_id IN (SELECT id FROM projects WHERE environment = 'production');

DELETE FROM payment_subscription_plans
 WHERE project_id IN (SELECT id FROM projects WHERE environment = 'production');

DELETE FROM payment_transfers
 WHERE project_id IS NULL
    OR project_id IN (SELECT id FROM projects WHERE environment = 'production');

-- counterparty_provider_accounts_counterparty_id_fkey is NO ACTION, and nothing
-- references counterparty_provider_accounts.
DELETE FROM counterparty_provider_accounts
 WHERE counterparty_id IN (SELECT id FROM counterparties WHERE project_id IS NULL);

DELETE FROM counterparties
 WHERE project_id IS NULL;

-- Cascades dvp_leg_action_requests, dvp_leg_funding_claims, dvp_leg_transfers
-- and dvp_leg_transfer_scans.
DELETE FROM dvp_trades
 WHERE project_id IN (SELECT id FROM projects WHERE environment = 'production');

DELETE FROM dvp_settlement_wallets
 WHERE project_id IN (SELECT id FROM projects WHERE environment = 'production');

-- Cascades issued_token_extensions, issuance_transactions and their statuses,
-- token_allowlists and their statuses, frozen_accounts, asset_profiles and
-- wallet_asset_enrollments.
DELETE FROM issued_tokens
 WHERE project_id IN (SELECT id FROM projects WHERE environment = 'production');

-- Cascades helius_rings_timelocks and helius_rings_events.
DELETE FROM helius_rings_operations
 WHERE project_id IN (SELECT id FROM projects WHERE environment = 'production');

-- Cascades helius_rings_zones.
DELETE FROM helius_rings_wallets
 WHERE project_id IN (SELECT id FROM projects WHERE environment = 'production');

DELETE FROM helius_rings_project_rings
 WHERE project_id IN (SELECT id FROM projects WHERE environment = 'production');

-- Transfer-family events name their intent in the payload, with no foreign key.
DELETE FROM private_channel_events event
 WHERE event.family = 'transfer'
   AND (event.payload ->> 'depositId' IN (
            SELECT deposit.id
              FROM private_channel_deposits deposit
              JOIN projects project ON project.id = deposit.project_id
             WHERE project.environment = 'production')
        OR event.payload ->> 'transferId' IN (
            SELECT transfer.id
              FROM private_channel_transfers transfer
              JOIN projects project ON project.id = transfer.project_id
             WHERE project.environment = 'production')
        OR event.payload ->> 'withdrawalId' IN (
            SELECT withdrawal.id
              FROM private_channel_withdrawals withdrawal
              JOIN projects project ON project.id = withdrawal.project_id
             WHERE project.environment = 'production'));

-- intent_id carries no foreign key, so observations go before their intents.
DELETE FROM private_channel_settlement_observations observation
 WHERE (observation.intent_kind = 'withdrawal'
        AND observation.intent_id IN (
            SELECT withdrawal.id
              FROM private_channel_withdrawals withdrawal
              JOIN projects project ON project.id = withdrawal.project_id
             WHERE project.environment = 'production'))
    OR (observation.intent_kind = 'deposit'
        AND observation.intent_id IN (
            SELECT deposit.id
              FROM private_channel_deposits deposit
              JOIN projects project ON project.id = deposit.project_id
             WHERE project.environment = 'production'));

DELETE FROM private_channel_deposits
 WHERE project_id IN (SELECT id FROM projects WHERE environment = 'production');

DELETE FROM private_channel_transfers
 WHERE project_id IN (SELECT id FROM projects WHERE environment = 'production');

DELETE FROM private_channel_withdrawals
 WHERE project_id IN (SELECT id FROM projects WHERE environment = 'production');

DELETE FROM sponsorship_budget_reservations
 WHERE project_id IS NULL
    OR project_id NOT IN (SELECT id FROM projects)
    OR (network = 'devnet'
        AND project_id IN (SELECT id FROM projects WHERE environment = 'production'));

ALTER TABLE payment_transfers ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE payment_requests ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE counterparties ALTER COLUMN project_id SET NOT NULL;

-- custody_connections_credential_scope_check (0126) already rejects a NULL
-- project_id, so no row needs deleting first.
ALTER TABLE custody_connections ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE sponsorship_budget_reservations
    ALTER COLUMN project_id SET NOT NULL,
    ADD CONSTRAINT sponsorship_budget_reservations_project_id_fkey
        FOREIGN KEY (project_id)
        REFERENCES projects (id)
        ON DELETE CASCADE;

-- Each composite key sits beside the table's ON DELETE SET NULL project_id
-- foreign key; both null only project_id, so they never conflict. ON UPDATE
-- RESTRICT keeps a project holding Earn rows from changing environment, as in
-- custody_configs_project_environment_fkey (0126).
ALTER TABLE earn_provider_wallets
    ADD CONSTRAINT earn_provider_wallets_project_environment_fkey
        FOREIGN KEY (project_id, environment)
        REFERENCES projects (id, environment)
        ON UPDATE RESTRICT
        ON DELETE SET NULL (project_id);

ALTER TABLE earn_positions
    ADD CONSTRAINT earn_positions_project_environment_fkey
        FOREIGN KEY (project_id, environment)
        REFERENCES projects (id, environment)
        ON UPDATE RESTRICT
        ON DELETE SET NULL (project_id);

ALTER TABLE earn_vault_withdrawal_requests
    ADD CONSTRAINT earn_vault_withdrawal_requests_project_environment_fkey
        FOREIGN KEY (project_id, environment)
        REFERENCES projects (id, environment)
        ON UPDATE RESTRICT
        ON DELETE SET NULL (project_id);

ALTER TABLE earn_vault_withdrawal_request_actions
    ADD CONSTRAINT earn_vault_withdrawal_request_actions_project_environment_fkey
        FOREIGN KEY (project_id, environment)
        REFERENCES projects (id, environment)
        ON UPDATE RESTRICT
        ON DELETE SET NULL (project_id);

ALTER TABLE earn_vault_withdrawal_request_reservations
    ADD CONSTRAINT earn_vault_withdrawal_reservations_project_environment_fkey
        FOREIGN KEY (project_id, environment)
        REFERENCES projects (id, environment)
        ON UPDATE RESTRICT
        ON DELETE SET NULL (project_id);

ALTER TABLE earn_movements
    ADD CONSTRAINT earn_movements_project_environment_fkey
        FOREIGN KEY (project_id, environment)
        REFERENCES projects (id, environment)
        ON UPDATE RESTRICT
        ON DELETE SET NULL (project_id);

ALTER TABLE earn_split_swap_advisories
    ADD CONSTRAINT earn_split_swap_advisories_project_environment_fkey
        FOREIGN KEY (project_id, environment)
        REFERENCES projects (id, environment)
        ON UPDATE RESTRICT
        ON DELETE SET NULL (project_id);

ALTER TABLE earn_external_wallet_transactions
    ADD CONSTRAINT earn_external_wallet_transactions_project_environment_fkey
        FOREIGN KEY (project_id, environment)
        REFERENCES projects (id, environment)
        ON UPDATE RESTRICT
        ON DELETE SET NULL (project_id);

ALTER TABLE earn_external_wallet_withdrawal_request_transactions
    ADD CONSTRAINT earn_external_wallet_withdrawal_txns_project_environment_fkey
        FOREIGN KEY (project_id, environment)
        REFERENCES projects (id, environment)
        ON UPDATE RESTRICT
        ON DELETE SET NULL (project_id);
