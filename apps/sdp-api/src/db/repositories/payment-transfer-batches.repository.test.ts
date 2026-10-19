import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedProjectCryptoWalletCounterparty } from "@/test/helpers/counterparties";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { seedUnreadPrivyWallet } from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import {
  expectProjectScoped,
  type SeededDefaultProjects,
  seedDefaultProjects,
} from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { PaymentTransferBatchesRepository } from "./payment-transfer-batches.repository";
import { createPostgresPaymentTransferBatchesRepository } from "./payment-transfer-batches.repository.postgres";

const TEST_PROJECT_ID = "prj_transfer_batches_repo_test";
const TEST_WALLET_ID = "wallet_transfer_batches_repo_test";
const TEST_CUSTODY_WALLET_ID = "cwlt_transfer_batches_repo_test";

describe("PaymentTransferBatchesRepository idempotency (postgres)", () => {
  let repo: PaymentTransferBatchesRepository;
  let projects: SeededDefaultProjects;

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM payment_transfer_batches").run();
    await db.prepare("DELETE FROM projects").run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    projects = await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
    });
    await seedTestCustodyRows(env, {
      configs: [
        {
          id: "cfg_transfer_batches_exact",
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          provider: "local",
          configEncrypted: "encrypted",
          status: "active",
        },
      ],
      wallets: [
        {
          id: TEST_CUSTODY_WALLET_ID,
          owner: { kind: "config", custodyConfigId: "cfg_transfer_batches_exact" },
          walletId: TEST_WALLET_ID,
          publicKey: "Source111",
          label: null,
          purpose: null,
          status: "active",
        },
      ],
    });

    repo = createPostgresPaymentTransferBatchesRepository(db);
  });

  const baseInput = {
    organizationId: TEST_ORG.id,
    sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
    sourceWalletId: TEST_WALLET_ID,
    sourceAddress: "Source111",
    token: "SOL",
    status: "processing" as const,
    totalAmount: "1",
    recipientCount: 1,
    transactionCount: 1,
    options: {},
    initiatedByKeyId: null,
    idempotencyFingerprint: "fp-1",
  };

  it("persists idempotency metadata and finds a batch by organization, project, and key", async () => {
    const { batch: created } = await repo.createTransferBatchWithRecipients({
      batch: { ...baseInput, projectId: TEST_PROJECT_ID, idempotencyKey: "batch-key-abc" },
      recipients: [],
    });

    expect(created.idempotency_key).toBe("batch-key-abc");
    expect(created.source_custody_wallet_id).toBe(TEST_CUSTODY_WALLET_ID);

    const found = await repo.findTransferBatchByIdempotency({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      idempotencyKey: "batch-key-abc",
    });
    expect(found).toMatchObject({
      id: created.id,
      idempotency_fingerprint: "fp-1",
    });
  });

  it("rejects a second batch with the same organization, project, and idempotency key", async () => {
    await repo.createTransferBatchWithRecipients({
      batch: { ...baseInput, projectId: TEST_PROJECT_ID, idempotencyKey: "duplicate-batch-key" },
      recipients: [],
    });

    await expect(
      repo.createTransferBatchWithRecipients({
        batch: { ...baseInput, projectId: TEST_PROJECT_ID, idempotencyKey: "duplicate-batch-key" },
        recipients: [],
      })
    ).rejects.toSatisfy((error: unknown) => isPostgresUniqueViolation(error));
  });

  it("scopes idempotency keys to the project", async () => {
    await repo.createTransferBatchWithRecipients({
      batch: { ...baseInput, projectId: projects.sandbox.id, idempotencyKey: "shared-batch-key" },
      recipients: [],
    });
    const read = (projectId: string) =>
      repo.findTransferBatchByIdempotency({
        organizationId: TEST_ORG.id,
        projectId,
        idempotencyKey: "shared-batch-key",
      });
    await expectProjectScoped(
      read,
      { own: projects.sandbox, other: projects.production },
      (row) => row === null
    );
    await expect(
      repo.createTransferBatchWithRecipients({
        batch: {
          ...baseInput,
          projectId: projects.production.id,
          idempotencyKey: "shared-batch-key",
        },
        recipients: [],
      })
    ).resolves.toBeDefined();
  });

  it("rolls back the batch row when a recipient insert fails", async () => {
    await expect(
      repo.createTransferBatchWithRecipients({
        batch: { ...baseInput, projectId: TEST_PROJECT_ID, idempotencyKey: "rollback-batch-key" },
        recipients: [
          {
            organizationId: TEST_ORG.id,
            projectId: TEST_PROJECT_ID,
            externalId: null,
            counterpartyId: "cpty_does_not_exist",
            counterpartyAccountId: "cpacct_does_not_exist",
            destinationAddress: "Dest111",
            amount: "1",
            status: "pending",
            error: null,
          },
        ],
      })
    ).rejects.toThrow();

    expect(
      await repo.findTransferBatchByIdempotency({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        idempotencyKey: "rollback-batch-key",
      })
    ).toBeNull();
  });

  it("filters batches by exact wallet and exact-wallet allowlist", async () => {
    const db = getDb(env);
    await repo.createTransferBatchWithRecipients({
      batch: {
        ...baseInput,
        projectId: TEST_PROJECT_ID,
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      },
      recipients: [],
    });
    const { batch: legacy } = await repo.createTransferBatchWithRecipients({
      batch: { ...baseInput, projectId: TEST_PROJECT_ID },
      recipients: [],
    });
    await db
      .prepare("UPDATE payment_transfer_batches SET source_custody_wallet_id = NULL WHERE id = ?")
      .bind(legacy.id)
      .run();

    const selected = await repo.listTransferBatches({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      limit: 20,
      offset: 0,
    });
    const authorized = await repo.listTransferBatches({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      walletAuthorization: {
        custodyWalletIds: [TEST_CUSTODY_WALLET_ID],
        providerWalletIds: [TEST_WALLET_ID],
      },
      limit: 20,
      offset: 0,
    });
    const authorizationDenied = await repo.listTransferBatches({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      walletAuthorization: { custodyWalletIds: [], providerWalletIds: [] },
      limit: 20,
      offset: 0,
    });

    expect(selected.rows).toHaveLength(1);
    expect(selected.rows[0]?.source_custody_wallet_id).toBe(TEST_CUSTODY_WALLET_ID);
    expect(authorized.rows).toHaveLength(2);
    expect(authorized.rows).toContainEqual(
      expect.objectContaining({ source_custody_wallet_id: TEST_CUSTODY_WALLET_ID })
    );
    expect(authorized.rows).toContainEqual(
      expect.objectContaining({
        source_custody_wallet_id: null,
        source_wallet_id: TEST_WALLET_ID,
      })
    );
    expect(authorizationDenied).toEqual({ rows: [], total: 0 });
  });
});

describe("PaymentTransferBatchesRepository.listStrandedTransferBatches (postgres)", () => {
  const PROJECT_IDS = {
    sandbox: TEST_PROJECT_ID,
    production: `${TEST_PROJECT_ID}_production`,
  } as const satisfies Record<SdpEnvironment, string>;
  const SOURCE_WALLETS = {
    sandbox: { custodyWalletId: TEST_CUSTODY_WALLET_ID, walletId: TEST_WALLET_ID },
    production: {
      custodyWalletId: "cwlt_transfer_batches_repo_production",
      walletId: "wallet_transfer_batches_repo_production",
    },
  } as const satisfies Record<SdpEnvironment, { custodyWalletId: string; walletId: string }>;
  const strandedBatchIds = new Map<SdpEnvironment, string>();
  let repo: PaymentTransferBatchesRepository;

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: PROJECT_IDS,
    });
    await seedTestCustodyRows(env, {
      configs: [
        {
          id: "cfg_transfer_batches_stranded",
          organizationId: TEST_ORG.id,
          projectId: PROJECT_IDS.sandbox,
          provider: "local",
          configEncrypted: "encrypted",
          status: "active",
        },
      ],
      wallets: [
        {
          id: SOURCE_WALLETS.sandbox.custodyWalletId,
          owner: { kind: "config", custodyConfigId: "cfg_transfer_batches_stranded" },
          walletId: SOURCE_WALLETS.sandbox.walletId,
          publicKey: "Source111",
          label: null,
          purpose: null,
          status: "active",
        },
      ],
    });
    await seedUnreadPrivyWallet(db, {
      organizationId: TEST_ORG.id,
      projectId: PROJECT_IDS.production,
      createdBy: TEST_USER.id,
      custodyWalletId: SOURCE_WALLETS.production.custodyWalletId,
      walletId: SOURCE_WALLETS.production.walletId,
      publicKey: "Production111",
    });
    repo = createPostgresPaymentTransferBatchesRepository(db);
    strandedBatchIds.clear();
    for (const environment of SDP_ENVIRONMENTS) {
      await seedProjectCryptoWalletCounterparty(db, {
        organizationId: TEST_ORG.id,
        projectId: PROJECT_IDS[environment],
        createdBy: TEST_USER.id,
        counterpartyId: `cpty_stranded_${environment}`,
        counterpartyAccountId: `cpacct_stranded_${environment}`,
        walletAddress: "Dest111",
      });
      const { batch } = await repo.createTransferBatchWithRecipients({
        batch: {
          organizationId: TEST_ORG.id,
          projectId: PROJECT_IDS[environment],
          sourceCustodyWalletId: SOURCE_WALLETS[environment].custodyWalletId,
          sourceWalletId: SOURCE_WALLETS[environment].walletId,
          sourceAddress: "Source111",
          token: "SOL",
          status: "processing",
          totalAmount: "1",
          recipientCount: 1,
          transactionCount: 1,
          options: {},
          initiatedByKeyId: null,
          idempotencyKey: `stranded-${environment}`,
          idempotencyFingerprint: `fp-stranded-${environment}`,
        },
        recipients: [
          {
            organizationId: TEST_ORG.id,
            projectId: PROJECT_IDS[environment],
            externalId: null,
            counterpartyId: `cpty_stranded_${environment}`,
            counterpartyAccountId: `cpacct_stranded_${environment}`,
            destinationAddress: "Dest111",
            amount: "1",
            status: "pending",
            error: null,
          },
        ],
      });
      strandedBatchIds.set(environment, batch.id);
    }
    await db
      .prepare("UPDATE payment_transfer_batches SET created_at = ?")
      .bind(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
      .run();
  });

  it.each(SDP_ENVIRONMENTS)(
    "lists only %s stranded batches for that environment's sweep",
    async (environment) => {
      const stranded = await repo.listStrandedTransferBatches({
        environment,
        createdBefore: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        limit: 50,
      });

      expect(stranded).toEqual([
        {
          batchId: strandedBatchIds.get(environment),
          organizationId: TEST_ORG.id,
          projectId: PROJECT_IDS[environment],
        },
      ]);
    }
  );
});
