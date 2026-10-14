import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PaymentRequestStatus, ProviderCredentialStatus } from "@sdp/types";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl as databaseUrl, env } from "@/test/helpers/env";
import {
  CHECK_VIOLATION,
  expectSqlstate,
  FK_VIOLATION,
  NOT_NULL_VIOLATION,
  RAISE_EXCEPTION,
  seedCounterparty,
  seedCustomerLink,
  seedOrgProject,
  seedStoredProviderCredential,
} from "@/test/helpers/migration-db";
import { seedTestDatabase } from "@/test/mocks/db";
import { runPostgresMigrations } from "../../../scripts/lib/run-postgres-migrations.mjs";
import { restorePreCounterpartyProviderAccountsScopeSchema } from "./counterparty-provider-accounts-scope-schema";
import {
  PROJECT_ID_NOT_NULL_MIGRATION,
  restorePreProjectIdNotNullSchema,
} from "./project-id-not-null-schema";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const seededAt = "2026-01-01T00:00:00.000Z";
const organizationSecretRef = "projects/p/secrets/pcred_0129_org_gcp";
const organizationSecretVersionRef = `${organizationSecretRef}/versions/1`;
const projectSecretRef = "projects/p/secrets/pcred_0129_project_gcp";
const projectSecretVersionRef = `${projectSecretRef}/versions/1`;
let client: Client;

type CredentialScope = "organization" | "project";

type TenantTable =
  | "payment_transfers"
  | "payment_requests"
  | "counterparties"
  | "counterparty_provider_accounts"
  | "sponsorship_budget_reservations"
  | "provider_credentials"
  | "helius_rings_connections";

interface RetirementRow {
  id: string;
  organization_id: string;
  source_id: string;
  storage_backend: string;
  secret_ref: string;
  secret_version_ref: string;
  attempt_count: number;
  last_error: string;
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
     ) VALUES ($1, $2, $3, 'wlt_0129', 'source_0129', 'destination_0129', 'USDC', '10',
               'transfer', 'inbound', 'processing', $4, $4)`,
    [transfer.id, transfer.organizationId, transfer.projectId, seededAt]
  );
}

async function seedPaymentRequest(request: {
  id: string;
  organizationId: string;
  projectId: string | null;
  status: PaymentRequestStatus;
  fulfilledByTransferId: string | null;
}): Promise<void> {
  await client.query(
    `INSERT INTO payment_requests (
       id, organization_id, project_id, wallet_id, destination_address, token, amount,
       reference, public_token, status, fulfilled_by_transfer_id
     ) VALUES ($1, $2, $3, 'wlt_0129', 'destination_0129', 'USDC', '10', $1, $1, $4, $5)`,
    [
      request.id,
      request.organizationId,
      request.projectId,
      request.status,
      request.fulfilledByTransferId,
    ]
  );
}

async function seedReservation(reservation: {
  id: string;
  organizationId: string;
  projectId: string | null;
}): Promise<void> {
  await client.query(
    `INSERT INTO sponsorship_budget_reservations (
       id, network, product_environment, organization_id, project_id, actor_type, actor_id,
       transaction_digest, fee_payer, provider_config_fingerprint, recent_blockhash,
       reserved_lamports, hour_bucket, day_bucket, policy_versions, status
     ) VALUES ($1, 'devnet', 'sandbox', $2, $3, 'api_key', 'key_0129', $1, 'fee_payer_0129',
               'fingerprint_0129', 'blockhash_0129', 5000, '2026-01-01T00', '2026-01-01',
               '{}', 'reserved')`,
    [reservation.id, reservation.organizationId, reservation.projectId]
  );
}

async function seedEncryptedCredential(credential: {
  id: string;
  organizationId: string;
  projectId: string | null;
  scope: CredentialScope;
  userId: string;
  provider: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO provider_credentials (
       id, organization_id, project_id, provider, label, scope, source,
       storage_backend, encrypted_secret_payload, status, created_by
     ) VALUES ($1, $2, $3, $4, $1, $5, 'stored', 'encrypted_db', 'test-only', 'active', $6)`,
    [
      credential.id,
      credential.organizationId,
      credential.projectId,
      credential.provider,
      credential.scope,
      credential.userId,
    ]
  );
}

async function seedGcpCredential(credential: {
  id: string;
  organizationId: string;
  projectId: string | null;
  scope: CredentialScope;
  userId: string;
  status: ProviderCredentialStatus;
  secretRef: string;
  secretVersionRef: string | null;
}): Promise<void> {
  await client.query(
    `INSERT INTO provider_credentials (
       id, organization_id, project_id, provider, label, scope, source,
       storage_backend, secret_ref, secret_version_ref, status, created_by
     ) VALUES ($1, $2, $3, 'privy', $1, $4, 'stored', 'gcp_secret_manager', $5, $6, $7, $8)`,
    [
      credential.id,
      credential.organizationId,
      credential.projectId,
      credential.scope,
      credential.secretRef,
      credential.secretVersionRef,
      credential.status,
      credential.userId,
    ]
  );
}

async function seedCustodyConnection(connection: {
  id: string;
  organizationId: string;
  projectId: string | null;
  scope: CredentialScope;
  credentialId: string;
  credentialScopeKey: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO custody_connections (
       id, organization_id, project_id, provider, scope, provider_credential_id,
       provider_credential_scope_key, status
     ) VALUES ($1, $2, $3, 'privy', $4, $5, $6, 'pending')`,
    [
      connection.id,
      connection.organizationId,
      connection.projectId,
      connection.scope,
      connection.credentialId,
      connection.credentialScopeKey,
    ]
  );
}

async function idsOf(table: TenantTable, organizationId: string): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM ${table} WHERE organization_id = $1 ORDER BY id`,
    [organizationId]
  );
  return result.rows.map((row) => row.id);
}

async function retirementsOf(sourceIds: string[]): Promise<RetirementRow[]> {
  const result = await client.query<RetirementRow>(
    `SELECT id, organization_id, source_id, storage_backend, secret_ref, secret_version_ref,
            attempt_count, last_error
       FROM secret_retirements
      WHERE source_id = ANY($1) OR secret_version_ref = ANY($2)
      ORDER BY source_id`,
    [sourceIds, [organizationSecretVersionRef, projectSecretVersionRef]]
  );
  return result.rows;
}

async function recordedMigrations(): Promise<{ version: string }[]> {
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

describe("0129 project_id not null migration", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await restorePreCounterpartyProviderAccountsScopeSchema(client);
    await restorePreProjectIdNotNullSchema(client);
  });

  afterEach(async () => {
    await seedTestDatabase(env);
    await runPostgresMigrations({ databaseUrl, migrationsDir });
  });

  it("deletes NULL-project payment requests, transfers, counterparties with their provider accounts, and reservations, and keeps project-owned rows", async () => {
    const tenant = await seedOrgProject(client, "0129_null_rows");
    await seedTransfer({
      id: "xfr_0129_null",
      organizationId: tenant.organizationId,
      projectId: null,
    });
    await seedTransfer({
      id: "xfr_0129_kept",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
    });
    await seedPaymentRequest({
      id: "preq_0129_null",
      organizationId: tenant.organizationId,
      projectId: null,
      status: "paid",
      fulfilledByTransferId: "xfr_0129_null",
    });
    await seedPaymentRequest({
      id: "preq_0129_kept",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      status: "awaiting_payment",
      fulfilledByTransferId: null,
    });
    await seedCounterparty(client, {
      id: "cpty_0129_null",
      organizationId: tenant.organizationId,
      projectId: null,
    });
    await seedCustomerLink(client, {
      id: "cpa_0129_null",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      counterpartyId: "cpty_0129_null",
    });
    await seedCounterparty(client, {
      id: "cpty_0129_kept",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
    });
    await seedCustomerLink(client, {
      id: "cpa_0129_kept",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      counterpartyId: "cpty_0129_kept",
    });
    await seedReservation({
      id: "sbr_0129_null",
      organizationId: tenant.organizationId,
      projectId: null,
    });
    await seedReservation({
      id: "sbr_0129_kept",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect({
      transfers: await idsOf("payment_transfers", tenant.organizationId),
      requests: await idsOf("payment_requests", tenant.organizationId),
      counterparties: await idsOf("counterparties", tenant.organizationId),
      providerAccounts: await idsOf("counterparty_provider_accounts", tenant.organizationId),
      reservations: await idsOf("sponsorship_budget_reservations", tenant.organizationId),
    }).toEqual({
      transfers: ["xfr_0129_kept"],
      requests: ["preq_0129_kept"],
      counterparties: ["cpty_0129_kept"],
      providerAccounts: ["cpa_0129_kept"],
      reservations: ["sbr_0129_kept"],
    });
    expect(await recordedMigrations()).toEqual([{ version: PROJECT_ID_NOT_NULL_MIGRATION }]);
  });

  it("deletes a reservation whose project no longer exists", async () => {
    const tenant = await seedOrgProject(client, "0129_orphan");
    await seedReservation({
      id: "sbr_0129_orphan",
      organizationId: tenant.organizationId,
      projectId: "proj_0129_orphan_removed",
    });
    await seedReservation({
      id: "sbr_0129_orphan_kept",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect(await idsOf("sponsorship_budget_reservations", tenant.organizationId)).toEqual([
      "sbr_0129_orphan_kept",
    ]);
  });

  it("fails the migration and leaves it unrecorded when a kept payment request is fulfilled by a NULL-project transfer", async () => {
    const tenant = await seedOrgProject(client, "0129_fulfilled");
    await seedTransfer({
      id: "xfr_0129_fulfilled",
      organizationId: tenant.organizationId,
      projectId: null,
    });
    await seedPaymentRequest({
      id: "preq_0129_fulfilled",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      status: "paid",
      fulfilledByTransferId: "xfr_0129_fulfilled",
    });

    await expect(runPostgresMigrations({ databaseUrl, migrationsDir })).rejects.toMatchObject({
      code: FK_VIOLATION,
      constraint: "payment_requests_fulfilled_by_transfer_id_fkey",
    });

    expect({
      transfers: await idsOf("payment_transfers", tenant.organizationId),
      requests: await idsOf("payment_requests", tenant.organizationId),
    }).toEqual({
      transfers: ["xfr_0129_fulfilled"],
      requests: ["preq_0129_fulfilled"],
    });
    expect(await recordedMigrations()).toEqual([]);
  });

  it("queues each organization-scoped GCP secret version for retirement, deletes every organization-scoped credential, and keeps project credentials", async () => {
    const tenant = await seedOrgProject(client, "0129_credentials");
    await seedGcpCredential({
      id: "pcred_0129_org_gcp",
      organizationId: tenant.organizationId,
      projectId: null,
      scope: "organization",
      userId: tenant.userId,
      status: "active",
      secretRef: organizationSecretRef,
      secretVersionRef: organizationSecretVersionRef,
    });
    await seedEncryptedCredential({
      id: "pcred_0129_org_encrypted",
      organizationId: tenant.organizationId,
      projectId: null,
      scope: "organization",
      userId: tenant.userId,
      provider: "privy",
    });
    await seedGcpCredential({
      id: "pcred_0129_project_gcp",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      scope: "project",
      userId: tenant.userId,
      status: "active",
      secretRef: projectSecretRef,
      secretVersionRef: projectSecretVersionRef,
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect(await idsOf("provider_credentials", tenant.organizationId)).toEqual([
      "pcred_0129_project_gcp",
    ]);
    expect(
      await retirementsOf([
        "pcred_0129_org_gcp",
        "pcred_0129_org_encrypted",
        "pcred_0129_project_gcp",
      ])
    ).toEqual([
      {
        id: expect.stringMatching(/^wf_secret_retirement_/),
        organization_id: tenant.organizationId,
        source_id: "pcred_0129_org_gcp",
        storage_backend: "gcp_secret_manager",
        secret_ref: organizationSecretRef,
        secret_version_ref: organizationSecretVersionRef,
        attempt_count: 0,
        last_error: "organization-scoped provider credential removed (0129)",
      },
    ]);
  });

  it("fails the migration and leaves it unrecorded when an organization-scoped GCP credential has a secret but no recorded version", async () => {
    const tenant = await seedOrgProject(client, "0129_unversioned");
    await seedTransfer({
      id: "xfr_0129_unversioned",
      organizationId: tenant.organizationId,
      projectId: null,
    });
    await seedGcpCredential({
      id: "pcred_0129_unversioned",
      organizationId: tenant.organizationId,
      projectId: null,
      scope: "organization",
      userId: tenant.userId,
      status: "creating",
      secretRef: "projects/p/secrets/pcred_0129_unversioned",
      secretVersionRef: null,
    });
    await seedGcpCredential({
      id: "pcred_0129_unversioned_versioned",
      organizationId: tenant.organizationId,
      projectId: null,
      scope: "organization",
      userId: tenant.userId,
      status: "active",
      secretRef: organizationSecretRef,
      secretVersionRef: organizationSecretVersionRef,
    });

    await expect(runPostgresMigrations({ databaseUrl, migrationsDir })).rejects.toMatchObject({
      code: RAISE_EXCEPTION,
      message: expect.stringContaining(
        "1 organization-scoped GCP credential(s) have a secret but no recorded version"
      ),
    });

    expect({
      transfers: await idsOf("payment_transfers", tenant.organizationId),
      credentials: await idsOf("provider_credentials", tenant.organizationId),
      retirements: await retirementsOf([
        "pcred_0129_unversioned",
        "pcred_0129_unversioned_versioned",
      ]),
    }).toEqual({
      transfers: ["xfr_0129_unversioned"],
      credentials: ["pcred_0129_unversioned", "pcred_0129_unversioned_versioned"],
      retirements: [],
    });
    expect(await recordedMigrations()).toEqual([]);
  });

  it("applies the migration and keeps a project-scoped GCP credential whose version is not yet recorded", async () => {
    const tenant = await seedOrgProject(client, "0129_project_unversioned");
    await seedGcpCredential({
      id: "pcred_0129_project_unversioned",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      scope: "project",
      userId: tenant.userId,
      status: "creating",
      secretRef: projectSecretRef,
      secretVersionRef: null,
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect({
      credentials: await idsOf("provider_credentials", tenant.organizationId),
      retirements: await retirementsOf(["pcred_0129_project_unversioned"]),
    }).toEqual({
      credentials: ["pcred_0129_project_unversioned"],
      retirements: [],
    });
    expect(await recordedMigrations()).toEqual([{ version: PROJECT_ID_NOT_NULL_MIGRATION }]);
  });

  it("fails the migration and leaves it unrecorded when a Helius Rings connection is bound to an organization-scoped credential", async () => {
    const tenant = await seedOrgProject(client, "0129_rings");
    await seedEncryptedCredential({
      id: "pcred_0129_rings",
      organizationId: tenant.organizationId,
      projectId: null,
      scope: "organization",
      userId: tenant.userId,
      provider: "helius_rings",
    });
    await client.query(
      `INSERT INTO helius_rings_connections (
         id, organization_id, project_id, name, provider_credential_id,
         provider_credential_scope_key, status, is_default, activated_at, created_by
       ) VALUES ('hrconn_0129_rings', $1, $2, 'hrconn_0129_rings', 'pcred_0129_rings',
                 '__organization__', 'active', TRUE, sdp_iso_now(), $3)`,
      [tenant.organizationId, tenant.projectId, tenant.userId]
    );

    await expect(runPostgresMigrations({ databaseUrl, migrationsDir })).rejects.toMatchObject({
      code: FK_VIOLATION,
      message: expect.stringContaining('on table "helius_rings_connections"'),
    });

    expect({
      credentials: await idsOf("provider_credentials", tenant.organizationId),
      connections: await idsOf("helius_rings_connections", tenant.organizationId),
    }).toEqual({
      credentials: ["pcred_0129_rings"],
      connections: ["hrconn_0129_rings"],
    });
    expect(await recordedMigrations()).toEqual([]);
  });
});

describe("0129 project_id not null constraints", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await client.query("BEGIN");
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  it("rejects a NULL project_id on every project-owned table it tightened", async () => {
    const tenant = await seedOrgProject(client, "0129_not_null");
    await seedStoredProviderCredential(client, {
      id: "pcred_0129_not_null",
      label: "0129_not_null",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      userId: tenant.userId,
      provider: "privy",
    });

    await expectSqlstate(
      client,
      () =>
        seedTransfer({
          id: "xfr_0129_not_null",
          organizationId: tenant.organizationId,
          projectId: null,
        }),
      NOT_NULL_VIOLATION
    );
    await expectSqlstate(
      client,
      () =>
        seedPaymentRequest({
          id: "preq_0129_not_null",
          organizationId: tenant.organizationId,
          projectId: null,
          status: "awaiting_payment",
          fulfilledByTransferId: null,
        }),
      NOT_NULL_VIOLATION
    );
    await expectSqlstate(
      client,
      () =>
        seedCounterparty(client, {
          id: "cpty_0129_not_null",
          organizationId: tenant.organizationId,
          projectId: null,
        }),
      NOT_NULL_VIOLATION
    );
    await expectSqlstate(
      client,
      () =>
        seedReservation({
          id: "sbr_0129_not_null",
          organizationId: tenant.organizationId,
          projectId: null,
        }),
      NOT_NULL_VIOLATION
    );
    await expectSqlstate(
      client,
      () =>
        seedEncryptedCredential({
          id: "pcred_0129_not_null_organization",
          organizationId: tenant.organizationId,
          projectId: null,
          scope: "organization",
          userId: tenant.userId,
          provider: "privy",
        }),
      NOT_NULL_VIOLATION
    );
    await expectSqlstate(
      client,
      () =>
        seedCustodyConnection({
          id: "cconn_0129_not_null",
          organizationId: tenant.organizationId,
          projectId: null,
          scope: "project",
          credentialId: "pcred_0129_not_null",
          credentialScopeKey: tenant.projectId,
        }),
      NOT_NULL_VIOLATION
    );
  });

  it("rejects an organization scope on a provider credential or custody connection that names a project", async () => {
    const tenant = await seedOrgProject(client, "0129_scope");
    await seedStoredProviderCredential(client, {
      id: "pcred_0129_scope",
      label: "0129_scope",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      userId: tenant.userId,
      provider: "privy",
    });

    await expectSqlstate(
      client,
      () =>
        seedEncryptedCredential({
          id: "pcred_0129_scope_organization",
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          scope: "organization",
          userId: tenant.userId,
          provider: "privy",
        }),
      CHECK_VIOLATION
    );
    await expectSqlstate(
      client,
      () =>
        seedCustodyConnection({
          id: "cconn_0129_scope_organization",
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          scope: "organization",
          credentialId: "pcred_0129_scope",
          credentialScopeKey: tenant.projectId,
        }),
      CHECK_VIOLATION
    );
  });

  it("binds a reservation to an existing project and refuses to delete a project that holds one", async () => {
    const tenant = await seedOrgProject(client, "0129_restrict");

    await expectSqlstate(
      client,
      () =>
        seedReservation({
          id: "sbr_0129_restrict_missing",
          organizationId: tenant.organizationId,
          projectId: "proj_0129_restrict_missing",
        }),
      FK_VIOLATION
    );
    await seedReservation({
      id: "sbr_0129_restrict",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
    });
    await expectSqlstate(
      client,
      () => client.query("DELETE FROM projects WHERE id = $1", [tenant.projectId]),
      FK_VIOLATION
    );

    expect(await idsOf("sponsorship_budget_reservations", tenant.organizationId)).toEqual([
      "sbr_0129_restrict",
    ]);
  });
});

describe("0130 drop signing_requests", () => {
  it("leaves no signing_requests table", async () => {
    const relation = await client.query("SELECT to_regclass('signing_requests') AS relation");

    expect(relation.rows).toEqual([{ relation: null }]);
  });
});

describe("0131 drop dead auth tables", () => {
  it("leaves no sessions or magic_links table", async () => {
    const relations = await client.query(
      "SELECT to_regclass('sessions') AS sessions, to_regclass('magic_links') AS magic_links"
    );

    expect(relations.rows).toEqual([{ sessions: null, magic_links: null }]);
  });

  it("leaves users without login_count or last_login_at", async () => {
    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'users'
          AND column_name = ANY($1)`,
      [["login_count", "last_login_at"]]
    );

    expect(columns.rows).toEqual([]);
  });
});
