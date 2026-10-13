import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SdpEnvironment } from "@sdp/types";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SponsorshipNetwork } from "@/db/repositories/sponsorship-budget.repository";
import { adminDatabaseUrl as databaseUrl, env } from "@/test/helpers/env";
import { FK_VIOLATION, NOT_NULL_VIOLATION, seedOrgProject } from "@/test/helpers/migration-db";
import { seedTestDatabase } from "@/test/mocks/db";
import { runPostgresMigrations } from "../../../scripts/lib/run-postgres-migrations.mjs";
import {
  PROJECT_ID_NOT_NULL_MIGRATION,
  restorePreProjectIdNotNullSchema,
} from "./project-id-not-null-schema";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const RAISE_EXCEPTION = "P0001";
let client: Client;

type OrganizationScopedTable =
  | "payment_transfers"
  | "payment_requests"
  | "dvp_trades"
  | "sponsorship_budget_reservations"
  | "payment_subscription_collection_attempts";

interface EarnRow {
  id: string;
  project_id: string | null;
  environment: string;
}

async function seedTransfer(transfer: {
  id: string;
  organizationId: string;
  projectId: string | null;
}): Promise<void> {
  await client.query(
    `INSERT INTO payment_transfers (
       id, organization_id, project_id, wallet_id, source_address, destination_address,
       token, amount, type, direction, status, created_at, updated_at
     ) VALUES ($1, $2, $3, 'wlt_0129', 'PayerAddr', 'OurWallet', 'USDC', '10', 'transfer',
               'inbound', 'completed', sdp_iso_now(), sdp_iso_now())`,
    [transfer.id, transfer.organizationId, transfer.projectId]
  );
}

async function seedRequest(request: {
  id: string;
  organizationId: string;
  projectId: string;
  fulfilledByTransferId: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO payment_requests (
       id, organization_id, project_id, wallet_id, destination_address, token, amount,
       reference, public_token, status, fulfilled_by_transfer_id
     ) VALUES ($1, $2, $3, 'wlt_0129', 'OurWallet', 'USDC', '10', $1, $1, 'paid', $4)`,
    [request.id, request.organizationId, request.projectId, request.fulfilledByTransferId]
  );
}

async function seedDvpTrade(trade: {
  id: string;
  organizationId: string;
  projectId: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO dvp_trades (
       id, organization_id, project_id, swap_dvp, settlement_authority,
       user_a, user_b, mint_a, mint_b, nonce, token_program_a, token_program_b,
       decimals_a, decimals_b, amount_a, amount_b, expiry_timestamp,
       user_a_settlement_destination, user_b_settlement_destination,
       escrow_a, escrow_b, status
     ) VALUES ($1, $2, $3, $1, 'authority_0129', 'user_a_0129', 'user_b_0129', 'mint_a_0129',
               'mint_b_0129', '42', 'program_0129', 'program_0129', 6, 6, '1000', '2000',
               '1900000000', 'destination_a_0129', 'destination_b_0129', 'escrow_a_0129',
               'escrow_b_0129', 'created')`,
    [trade.id, trade.organizationId, trade.projectId]
  );
}

async function seedReservation(reservation: {
  id: string;
  organizationId: string;
  projectId: string | null;
  network: SponsorshipNetwork;
  productEnvironment: SdpEnvironment;
}): Promise<void> {
  await client.query(
    `INSERT INTO sponsorship_budget_reservations (
       id, network, product_environment, organization_id, project_id, actor_type, actor_id,
       transaction_digest, fee_payer, provider_config_fingerprint, recent_blockhash,
       reserved_lamports, hour_bucket, day_bucket, policy_versions, status
     ) VALUES ($1, $2, $3, $4, $5, 'api_key', 'key_0129', $1, 'fee_payer_0129',
               'fingerprint_0129', 'blockhash_0129', 5000, '2026-10-13T00', '2026-10-13',
               '{}', 'reserved')`,
    [
      reservation.id,
      reservation.network,
      reservation.productEnvironment,
      reservation.organizationId,
      reservation.projectId,
    ]
  );
}

async function seedSubscription(subscription: {
  id: string;
  organizationId: string;
  projectId: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
     VALUES ($1, $2, $3, 'individual', $1)`,
    [`cpty_${subscription.id}`, subscription.organizationId, subscription.projectId]
  );
  await client.query(
    `INSERT INTO payment_subscription_plans (
       id, organization_id, project_id, owner_wallet_id, owner_address, token, amount,
       period_hours, program_plan_id
     ) VALUES ($1, $2, $3, 'wlt_0129', 'OwnerAddr', 'USDC', '10', 24, '1')`,
    [`plan_${subscription.id}`, subscription.organizationId, subscription.projectId]
  );
  await client.query(
    `INSERT INTO payment_subscriptions (
       id, organization_id, project_id, plan_id, counterparty_id, subscriber_address
     ) VALUES ($1, $2, $3, $4, $5, 'SubscriberAddr')`,
    [
      subscription.id,
      subscription.organizationId,
      subscription.projectId,
      `plan_${subscription.id}`,
      `cpty_${subscription.id}`,
    ]
  );
}

async function seedCollectionAttempt(attempt: {
  id: string;
  organizationId: string;
  projectId: string;
  subscriptionId: string;
  dueAt: string;
  transferId: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO payment_subscription_collection_attempts (
       id, organization_id, project_id, subscription_id, token, amount, due_at, status,
       transfer_id, metadata
     ) VALUES ($1, $2, $3, $4, 'USDC', '10', $5, 'confirmed', $6,
               '{"source": "linked_transfer"}'::jsonb)`,
    [
      attempt.id,
      attempt.organizationId,
      attempt.projectId,
      attempt.subscriptionId,
      attempt.dueAt,
      attempt.transferId,
    ]
  );
}

async function seedEarnMovement(movement: {
  id: string;
  organizationId: string;
  projectId: string | null;
  environment: SdpEnvironment;
  userId: string;
}): Promise<void> {
  const walletId = `epw_${movement.id}`;
  const positionId = `epos_${movement.id}`;
  await client.query(
    `INSERT INTO earn_provider_wallets (
       id, organization_id, project_id, environment, provider, provider_wallet_ref, created_by
     ) VALUES ($1, $2, $3, $4, 'kamino', $1, $5)`,
    [walletId, movement.organizationId, movement.projectId, movement.environment, movement.userId]
  );
  await client.query(
    `INSERT INTO earn_positions (
       id, organization_id, project_id, environment, provider, kind, provider_wallet_id, label
     ) VALUES ($1, $2, $3, $4, 'kamino', 'custodial', $5, $1)`,
    [positionId, movement.organizationId, movement.projectId, movement.environment, walletId]
  );
  await client.query(
    `INSERT INTO earn_movements (
       id, organization_id, project_id, environment, provider, execution_model, direction,
       position_id, status, denomination, amount_requested, request_id, idempotency_fingerprint
     ) VALUES ($1, $2, $3, $4, 'kamino', 'custodial', 'withdrawal', $5, 'requested', 'usd',
               '10', $1, $1)`,
    [movement.id, movement.organizationId, movement.projectId, movement.environment, positionId]
  );
}

async function idsOf(table: OrganizationScopedTable, organizationId: string): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM ${table} WHERE organization_id = $1 ORDER BY id`,
    [organizationId]
  );
  return result.rows.map((row) => row.id);
}

async function earnMovementsOf(organizationId: string): Promise<EarnRow[]> {
  const result = await client.query<EarnRow>(
    `SELECT id, project_id, environment FROM earn_movements
      WHERE organization_id = $1 ORDER BY id`,
    [organizationId]
  );
  return result.rows;
}

async function earnLineageOf(organizationId: string): Promise<EarnRow[]> {
  const result = await client.query<EarnRow>(
    `SELECT id, project_id, environment FROM earn_provider_wallets WHERE organization_id = $1
     UNION ALL
     SELECT id, project_id, environment FROM earn_positions WHERE organization_id = $1
     UNION ALL
     SELECT id, project_id, environment FROM earn_movements WHERE organization_id = $1
     ORDER BY id`,
    [organizationId]
  );
  return result.rows;
}

async function appliedProjectIdNotNull(): Promise<{ version: string }[]> {
  const result = await client.query<{ version: string }>(
    "SELECT version FROM schema_migrations WHERE version = $1",
    [PROJECT_ID_NOT_NULL_MIGRATION]
  );
  return result.rows;
}

beforeAll(async () => {
  client = new Client({ connectionString: databaseUrl });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe("0129 project_id NOT NULL migration", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await restorePreProjectIdNotNullSchema(client);
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [
      PROJECT_ID_NOT_NULL_MIGRATION,
    ]);
  });

  afterEach(async () => {
    await seedTestDatabase(env);
    await runPostgresMigrations({ databaseUrl, migrationsDir });
  });

  it("deletes a Production project's transfer, request and DvP trade and keeps the Sandbox project's", async () => {
    const tenant = await seedOrgProject(client, "0129_production_rows");
    const productionProjectId = `${tenant.projectId}_production`;
    for (const { suffix, projectId } of [
      { suffix: "sandbox", projectId: tenant.projectId },
      { suffix: "production", projectId: productionProjectId },
    ]) {
      await seedTransfer({
        id: `xfr_0129_${suffix}`,
        organizationId: tenant.organizationId,
        projectId,
      });
      await seedRequest({
        id: `preq_0129_${suffix}`,
        organizationId: tenant.organizationId,
        projectId,
        fulfilledByTransferId: `xfr_0129_${suffix}`,
      });
      await seedDvpTrade({
        id: `dvp_0129_${suffix}`,
        organizationId: tenant.organizationId,
        projectId,
      });
    }

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect(await idsOf("payment_transfers", tenant.organizationId)).toEqual(["xfr_0129_sandbox"]);
    expect(await idsOf("payment_requests", tenant.organizationId)).toEqual(["preq_0129_sandbox"]);
    expect(await idsOf("dvp_trades", tenant.organizationId)).toEqual(["dvp_0129_sandbox"]);
    expect(await appliedProjectIdNotNull()).toEqual([{ version: PROJECT_ID_NOT_NULL_MIGRATION }]);
  });

  it("deletes a NULL-project transfer and then rejects a NULL project_id", async () => {
    const tenant = await seedOrgProject(client, "0129_null_transfer");
    await seedTransfer({
      id: "xfr_0129_null_project",
      organizationId: tenant.organizationId,
      projectId: null,
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect(await idsOf("payment_transfers", tenant.organizationId)).toEqual([]);
    await expect(
      seedTransfer({
        id: "xfr_0129_null_project_after",
        organizationId: tenant.organizationId,
        projectId: null,
      })
    ).rejects.toMatchObject({ code: NOT_NULL_VIOLATION });
  });

  it("deletes orphan, NULL-project and Production devnet reservations, keeps Production mainnet and Sandbox devnet ones, and then rejects an orphan", async () => {
    const tenant = await seedOrgProject(client, "0129_reservations");
    const productionProjectId = `${tenant.projectId}_production`;
    await seedReservation({
      id: "sbr_0129_orphan",
      organizationId: tenant.organizationId,
      projectId: "proj_0129_deleted",
      network: "devnet",
      productEnvironment: "sandbox",
    });
    await seedReservation({
      id: "sbr_0129_null_project",
      organizationId: tenant.organizationId,
      projectId: null,
      network: "devnet",
      productEnvironment: "sandbox",
    });
    await seedReservation({
      id: "sbr_0129_production_devnet",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
      network: "devnet",
      productEnvironment: "production",
    });
    await seedReservation({
      id: "sbr_0129_production_mainnet",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
      network: "mainnet",
      productEnvironment: "production",
    });
    await seedReservation({
      id: "sbr_0129_sandbox_devnet",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      network: "devnet",
      productEnvironment: "sandbox",
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect(await idsOf("sponsorship_budget_reservations", tenant.organizationId)).toEqual([
      "sbr_0129_production_mainnet",
      "sbr_0129_sandbox_devnet",
    ]);
    await expect(
      seedReservation({
        id: "sbr_0129_orphan_after",
        organizationId: tenant.organizationId,
        projectId: "proj_0129_deleted",
        network: "devnet",
        productEnvironment: "sandbox",
      })
    ).rejects.toMatchObject({ code: FK_VIOLATION });
  });

  it("fails the migration and leaves it unrecorded when a Sandbox request is fulfilled by a Production or NULL-project transfer", async () => {
    const tenant = await seedOrgProject(client, "0129_fulfillment_guard");
    await seedTransfer({
      id: "xfr_0129_guard_production",
      organizationId: tenant.organizationId,
      projectId: `${tenant.projectId}_production`,
    });
    await seedTransfer({
      id: "xfr_0129_guard_null_project",
      organizationId: tenant.organizationId,
      projectId: null,
    });
    await seedRequest({
      id: "preq_0129_guard_production",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      fulfilledByTransferId: "xfr_0129_guard_production",
    });
    await seedRequest({
      id: "preq_0129_guard_null_project",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      fulfilledByTransferId: "xfr_0129_guard_null_project",
    });

    await expect(runPostgresMigrations({ databaseUrl, migrationsDir })).rejects.toMatchObject({
      code: RAISE_EXCEPTION,
      message: "2 kept payment request(s) are fulfilled by a deleted transfer",
    });

    expect(await idsOf("payment_transfers", tenant.organizationId)).toEqual([
      "xfr_0129_guard_null_project",
      "xfr_0129_guard_production",
    ]);
    expect(await idsOf("payment_requests", tenant.organizationId)).toEqual([
      "preq_0129_guard_null_project",
      "preq_0129_guard_production",
    ]);
    expect(await appliedProjectIdNotNull()).toEqual([]);
  });

  it("fails the migration and leaves it unrecorded when a Sandbox collection attempt is settled by a Production or NULL-project transfer", async () => {
    const tenant = await seedOrgProject(client, "0129_collection_guard");
    await seedTransfer({
      id: "xfr_0129_collection_production",
      organizationId: tenant.organizationId,
      projectId: `${tenant.projectId}_production`,
    });
    await seedTransfer({
      id: "xfr_0129_collection_null_project",
      organizationId: tenant.organizationId,
      projectId: null,
    });
    await seedSubscription({
      id: "psub_0129_collection",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
    });
    await seedCollectionAttempt({
      id: "psca_0129_collection_production",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      subscriptionId: "psub_0129_collection",
      dueAt: "2026-10-01T00:00:00.000Z",
      transferId: "xfr_0129_collection_production",
    });
    await seedCollectionAttempt({
      id: "psca_0129_collection_null_project",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      subscriptionId: "psub_0129_collection",
      dueAt: "2026-10-02T00:00:00.000Z",
      transferId: "xfr_0129_collection_null_project",
    });

    await expect(runPostgresMigrations({ databaseUrl, migrationsDir })).rejects.toMatchObject({
      code: RAISE_EXCEPTION,
      message: "2 kept subscription collection attempt(s) are settled by a deleted transfer",
    });

    expect(await idsOf("payment_transfers", tenant.organizationId)).toEqual([
      "xfr_0129_collection_null_project",
      "xfr_0129_collection_production",
    ]);
    expect(await idsOf("payment_subscription_collection_attempts", tenant.organizationId)).toEqual([
      "psca_0129_collection_null_project",
      "psca_0129_collection_production",
    ]);
    expect(await appliedProjectIdNotNull()).toEqual([]);
  });

  it("fails the migration and leaves it unrecorded when an Earn row's environment differs from its project's", async () => {
    const tenant = await seedOrgProject(client, "0129_earn_mismatch");
    await seedEarnMovement({
      id: "emov_0129_mismatch",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      environment: "production",
      userId: tenant.userId,
    });

    await expect(runPostgresMigrations({ databaseUrl, migrationsDir })).rejects.toMatchObject({
      code: FK_VIOLATION,
      constraint: "earn_provider_wallets_project_environment_fkey",
    });

    expect(await earnMovementsOf(tenant.organizationId)).toEqual([
      { id: "emov_0129_mismatch", project_id: tenant.projectId, environment: "production" },
    ]);
    expect(await appliedProjectIdNotNull()).toEqual([]);
  });

  it("keeps a Production Earn movement and a deleted project's Earn history", async () => {
    const tenant = await seedOrgProject(client, "0129_earn_kept");
    const productionProjectId = `${tenant.projectId}_production`;
    await seedEarnMovement({
      id: "emov_0129_kept_deleted_project",
      organizationId: tenant.organizationId,
      projectId: null,
      environment: "production",
      userId: tenant.userId,
    });
    await seedEarnMovement({
      id: "emov_0129_kept_production",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
      environment: "production",
      userId: tenant.userId,
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect(await earnMovementsOf(tenant.organizationId)).toEqual([
      { id: "emov_0129_kept_deleted_project", project_id: null, environment: "production" },
      {
        id: "emov_0129_kept_production",
        project_id: productionProjectId,
        environment: "production",
      },
    ]);
    expect(await appliedProjectIdNotNull()).toEqual([{ version: PROJECT_ID_NOT_NULL_MIGRATION }]);
  });

  it("refuses to change the environment of a project holding Earn rows, and deleting it nulls their project_id and keeps their environment", async () => {
    const tenant = await seedOrgProject(client, "0129_earn_project_delete");
    const productionProjectId = `${tenant.projectId}_production`;
    await runPostgresMigrations({ databaseUrl, migrationsDir });
    await seedEarnMovement({
      id: "emov_0129_project_delete",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
      environment: "production",
      userId: tenant.userId,
    });
    await client.query("UPDATE projects SET status = 'archived' WHERE id = $1", [tenant.projectId]);

    await expect(
      client.query("UPDATE projects SET environment = 'sandbox' WHERE id = $1", [
        productionProjectId,
      ])
    ).rejects.toMatchObject({ code: FK_VIOLATION });
    await client.query("DELETE FROM projects WHERE id = $1", [productionProjectId]);

    expect(await earnLineageOf(tenant.organizationId)).toEqual([
      { id: "emov_0129_project_delete", project_id: null, environment: "production" },
      { id: "epos_emov_0129_project_delete", project_id: null, environment: "production" },
      { id: "epw_emov_0129_project_delete", project_id: null, environment: "production" },
    ]);
  });
});
