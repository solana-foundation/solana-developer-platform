import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import { WALLET_TRANSFER_TYPES } from "@sdp/types/payments";
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
import { createPostgresPaymentTransferBatchesRepository } from "./payment-transfer-batches.repository.postgres";
import type { PaymentsRepository } from "./payments.repository";
import { createPostgresPaymentsRepository } from "./payments.repository.postgres";

const TEST_PROJECT_ID = "prj_payments_repo_test";
const TEST_WALLET_ID = "wallet_payments_repo_test";
const TEST_CUSTODY_WALLET_ID = "cwlt_payments_repo_test";

async function resetPaymentFixtures(): Promise<SeededDefaultProjects> {
  const db = getDb(env);
  await db.prepare("DELETE FROM payment_transfer_batches").run();
  await db.prepare("DELETE FROM payment_transfers").run();
  await db.prepare("DELETE FROM custody_wallets").run();
  await db.prepare("DELETE FROM custody_configs").run();
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
  const projects = await seedDefaultProjects(db, {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [],
    ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
  });
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: "cfg_payments_repo_exact",
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
        owner: { kind: "config", custodyConfigId: "cfg_payments_repo_exact" },
        walletId: TEST_WALLET_ID,
        publicKey: "Source111",
        label: null,
        purpose: null,
        status: "active",
      },
    ],
  });
  return projects;
}

function transferInput(overrides: {
  suffix: string;
  token?: string;
  custodyWalletId?: string;
  walletId?: string;
}) {
  const {
    suffix,
    token = "SOL",
    custodyWalletId = TEST_CUSTODY_WALLET_ID,
    walletId = TEST_WALLET_ID,
  } = overrides;
  return {
    id: `xfr_${suffix}`,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    custodyWalletId,
    walletId,
    counterpartyId: null,
    sourceAddress: `Source${suffix}`,
    destinationAddress: `Dest${suffix}`,
    token,
    amount: "1",
    memo: null,
    type: "transfer" as const,
    direction: "outbound" as const,
    status: "processing" as const,
    provider: null,
    providerReference: null,
    deliveryMode: null,
    fiatCurrency: null,
    fiatAmount: null,
    providerData: {},
    serializedTx: null,
    signature: null,
    slot: null,
    initiatedByKeyId: null,
    idempotencyKey: `fixture-${suffix}`,
    idempotencyFingerprint: `fp-${suffix}`,
  };
}

describe("PaymentsRepository transfer writes (postgres)", () => {
  let projects: SeededDefaultProjects;
  let repo: PaymentsRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    projects = await resetPaymentFixtures();
    repo = createPostgresPaymentsRepository(getDb(env));
  });

  it.for(["transfer", "transfer_batch"] as const)(
    "a stale unsigned timeout cannot fail a signed %s or prevent its submission",
    async (type) => {
      const input = { ...transferInput({ suffix: `timeout_${type}` }), type };
      await repo.createTransfer(input);
      const batches = createPostgresPaymentTransferBatchesRepository(getDb(env));
      let batchId: string | null = null;
      if (type === "transfer_batch") {
        await seedProjectCryptoWalletCounterparty(getDb(env), {
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          createdBy: TEST_USER.id,
          counterpartyId: "cpty_timeout",
          counterpartyAccountId: "cpacct_timeout",
          walletAddress: input.destinationAddress,
        });
        const created = await batches.createTransferBatchWithRecipients({
          batch: {
            organizationId: TEST_ORG.id,
            projectId: TEST_PROJECT_ID,
            sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            sourceWalletId: TEST_WALLET_ID,
            sourceAddress: input.sourceAddress,
            token: input.token,
            status: "processing",
          },
          recipients: [
            {
              organizationId: TEST_ORG.id,
              projectId: TEST_PROJECT_ID,
              transferId: input.id,
              counterpartyId: "cpty_timeout",
              counterpartyAccountId: "cpacct_timeout",
              destinationAddress: input.destinationAddress,
              amount: "1",
              status: "processing",
            },
          ],
        });
        batchId = created.batch.id;
      }
      // The timeout observed an unsigned row before the request saved its submission.
      const selected = await repo.listTransfersByStatus({
        environment: "sandbox",
        statuses: ["processing"],
        types: WALLET_TRANSFER_TYPES,
        hasSignature: false,
        limit: 10,
      });
      expect(selected.map((row) => row.id)).toContain(input.id);
      expect(
        await repo.persistSignedTransfer({
          transferId: input.id,
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          signature: `signature-${type}`,
          signedTransaction: "AQ==",
          lastValidBlockHeight: "1000",
          updatedAt: new Date().toISOString(),
        })
      ).not.toBeNull();
      const timeout = {
        transferId: input.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        requireUnsigned: true as const,
        error: "Transfer processing timed out",
        updatedAt: new Date().toISOString(),
      };
      if (type === "transfer_batch") {
        await batches.settleTransferBatch({
          ...timeout,
          transferStatus: "failed",
          slot: null,
        });
      } else {
        expect(
          await repo.updateTransfer({ ...timeout, expectedStatus: "processing", status: "failed" })
        ).toBeNull();
      }

      expect(await readStatus(input.id)).toBe("processing");
      if (batchId !== null) {
        expect(
          await batches.getTransferBatchById({
            batchId,
            organizationId: TEST_ORG.id,
            projectId: TEST_PROJECT_ID,
          })
        ).toMatchObject({ status: "processing" });
        expect(
          await batches.listTransferRecipientsByBatch({
            batchId,
            organizationId: TEST_ORG.id,
            projectId: TEST_PROJECT_ID,
            limit: 10,
            offset: 0,
          })
        ).toMatchObject({ rows: [{ status: "processing" }] });
      }
      expect(
        await repo.markTransferSubmissionStarted({
          transferId: input.id,
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          startedAt: new Date().toISOString(),
        })
      ).not.toBeNull();
    }
  );

  it("installs the indexed payment-ledger search plan", async () => {
    const extension = await getDb(env)
      .prepare("SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'")
      .first<{ extname: string }>();
    const indexes = await getDb(env)
      .prepare(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE indexname IN (
           'idx_payment_transfers_project_source_created_id',
           'idx_payment_transfers_project_destination_created_id',
           'idx_payment_transfers_search_trgm',
           'idx_counterparties_display_name_trgm'
         )`
      )
      .all<{ indexdef: string; indexname: string }>();

    expect(extension?.extname).toBe("pg_trgm");
    expect(indexes.results.map((index) => index.indexname).sort()).toEqual([
      "idx_counterparties_display_name_trgm",
      "idx_payment_transfers_project_destination_created_id",
      "idx_payment_transfers_project_source_created_id",
      "idx_payment_transfers_search_trgm",
    ]);
    expect(
      indexes.results
        .filter((index) => index.indexname.endsWith("_trgm"))
        .every((index) => index.indexdef.includes("gin_trgm_ops"))
    ).toBe(true);
  });

  async function seedTransfer(input: { id: string; status: string }): Promise<void> {
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, token, type, direction, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        TEST_WALLET_ID,
        "USDC",
        "offramp",
        "outbound",
        input.status,
        now,
        now
      )
      .run();
  }

  async function readStatus(id: string): Promise<string | null> {
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    return row?.status ?? null;
  }

  it("applies a transition from one of its source statuses", async () => {
    await seedTransfer({ id: "xfr_guard_ok", status: "awaiting_payment" });

    const updated = await repo.transitionRampTransfer({
      transferId: "xfr_guard_ok",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      transition: "canceled",
      updatedAt: new Date().toISOString(),
    });

    expect(updated?.status).toBe("canceled");
    expect(await readStatus("xfr_guard_ok")).toBe("canceled");
  });

  it("claims an unoccupied off-ramp row for its on-chain deposit", async () => {
    const depositAddress = "DepositAddress111";
    const transfer = await repo.createTransfer({
      ...transferInput({ suffix: "ramp-onchain" }),
      destinationAddress: null,
      type: "offramp",
      status: "awaiting_payment",
      provider: "moonpay",
      providerData: {
        cryptoDeposit: { destinationAddress: depositAddress, amount: "1.0" },
      },
    });
    if (!transfer) throw new Error("Expected off-ramp transfer creation to succeed");

    await expect(
      repo.updateOnchainTransferForRamp({
        transferId: transfer.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        custodyWalletId: "cwlt_other",
        walletId: TEST_WALLET_ID,
        sourceAddress: "Sourceramp-onchain",
        destinationAddress: depositAddress,
        token: "SOL",
        amount: "1",
        initiatedByKeyId: "key_ramp_onchain",
        idempotency: null,
        updatedAt: "2026-08-31T10:00:00.000Z",
      })
    ).resolves.toBeNull();

    const updated = await repo.updateOnchainTransferForRamp({
      transferId: transfer.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      sourceAddress: "Sourceramp-onchain",
      destinationAddress: depositAddress,
      token: "SOL",
      amount: "1",
      initiatedByKeyId: "key_ramp_onchain",
      idempotency: null,
      updatedAt: "2026-08-31T10:00:00.000Z",
    });

    expect(updated).toMatchObject({
      id: transfer.id,
      destination_address: depositAddress,
      initiated_by_key_id: "key_ramp_onchain",
      status: "processing",
    });
  });

  it("does not claim an off-ramp row whose on-chain fields are occupied", async () => {
    const depositAddress = "DepositAddress222";
    const transfer = await repo.createTransfer({
      ...transferInput({ suffix: "ramp-occupied" }),
      destinationAddress: null,
      type: "offramp",
      status: "awaiting_payment",
      provider: "moonpay",
      providerData: {
        cryptoDeposit: { destinationAddress: depositAddress, amount: "1" },
      },
      signature: "existing-ramp-signature",
    });
    if (!transfer) throw new Error("Expected off-ramp transfer creation to succeed");

    await expect(
      repo.updateOnchainTransferForRamp({
        transferId: transfer.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        walletId: TEST_WALLET_ID,
        sourceAddress: "Sourceramp-occupied",
        destinationAddress: depositAddress,
        token: "SOL",
        amount: "1",
        initiatedByKeyId: "key_ramp_occupied",
        idempotency: null,
        updatedAt: "2026-08-31T10:00:00.000Z",
      })
    ).resolves.toBeNull();
  });

  it("sets a provider reference once and permits only an exact replay", async () => {
    const transfer = await repo.createTransfer({
      ...transferInput({ suffix: "provider-reference-binding" }),
      type: "offramp",
      status: "pending",
      provider: "moonpay",
      providerReference: null,
    });
    if (!transfer) throw new Error("Expected MoonPay transfer creation to succeed");

    const input = {
      transferId: transfer.id,
      provider: "moonpay" as const,
      providerReference: "moonpay-transaction-1",
      environment: "sandbox" as const,
      updatedAt: "2026-08-31T11:00:00.000Z",
    };
    await expect(
      repo.claimProviderReference({ ...input, environment: "production" })
    ).resolves.toBeNull();
    await expect(
      repo.getTransferProjectEnvironment({ transferId: transfer.id, provider: "moonpay" })
    ).resolves.toBe("sandbox");
    await expect(repo.claimProviderReference(input)).resolves.toMatchObject({
      provider_reference: "moonpay-transaction-1",
    });
    await expect(repo.claimProviderReference(input)).resolves.toMatchObject({
      provider_reference: "moonpay-transaction-1",
    });
    await expect(
      repo.claimProviderReference({
        ...input,
        providerReference: "moonpay-transaction-2",
        updatedAt: "2026-08-31T11:01:00.000Z",
      })
    ).resolves.toBeNull();
    await expect(
      repo.claimProviderReference({
        ...input,
        provider: "stripe",
      })
    ).resolves.toBeNull();
  });

  it("is a no-op returning null when the status left the sources (the race)", async () => {
    await seedTransfer({ id: "xfr_guard_race", status: "settling" });

    const updated = await repo.transitionRampTransfer({
      transferId: "xfr_guard_race",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      transition: "canceled",
      updatedAt: new Date().toISOString(),
    });

    expect(updated).toBeNull();
    expect(await readStatus("xfr_guard_race")).toBe("settling");
  });

  it("returns null for a transfer that does not exist", async () => {
    const updated = await repo.transitionRampTransfer({
      transferId: "xfr_missing",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      transition: "canceled",
      updatedAt: new Date().toISOString(),
    });

    expect(updated).toBeNull();
  });

  it("does not transition a transfer owned by a different organization", async () => {
    await seedTransfer({ id: "xfr_guard_org", status: "awaiting_payment" });

    const updated = await repo.transitionRampTransfer({
      transferId: "xfr_guard_org",
      organizationId: "org_someone_else",
      projectId: TEST_PROJECT_ID,
      transition: "canceled",
      updatedAt: new Date().toISOString(),
    });

    expect(updated).toBeNull();
    expect(await readStatus("xfr_guard_org")).toBe("awaiting_payment");
  });

  it("does not transition a transfer scoped to another project", async () => {
    await seedTransfer({ id: "xfr_guard_project", status: "awaiting_payment" });
    const transition = (projectId: string) =>
      repo.transitionRampTransfer({
        transferId: "xfr_guard_project",
        organizationId: TEST_ORG.id,
        projectId,
        transition: "canceled",
        updatedAt: new Date().toISOString(),
      });
    await expectProjectScoped(
      transition,
      { own: projects.sandbox, other: projects.production },
      (row) => row === null
    );
  });

  it("persists idempotency metadata and looks it up by (org, key)", async () => {
    const repo = createPostgresPaymentsRepository(getDb(env));
    const created = await repo.createTransfer({
      id: "xfr_idempotency_metadata",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      counterpartyId: null,
      sourceAddress: "Source111",
      destinationAddress: "Dest111",
      token: "SOL",
      amount: "1",
      memo: null,
      type: "transfer",
      direction: "outbound",
      status: "processing",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: {},
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: null,
      idempotencyKey: "key-abc",
      idempotencyFingerprint: "fp-1",
    });
    expect(created?.idempotency_key).toBe("key-abc");
    expect(created?.custody_wallet_id).toBe(TEST_CUSTODY_WALLET_ID);

    const found = await repo.findTransferByIdempotency({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      idempotencyKey: "key-abc",
    });
    expect(found?.id).toBe(created?.id);
    expect(found?.idempotency_fingerprint).toBe("fp-1");
  });

  it("persists a signed transfer before submission starts", async () => {
    const transfer = await repo.createTransfer(transferInput({ suffix: "signed-outbox" }));
    if (!transfer) throw new Error("Expected transfer creation to succeed");

    const signed = await repo.persistSignedTransfer({
      transferId: transfer.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      signature: "signed-outbox-signature",
      signedTransaction: "AQID",
      lastValidBlockHeight: "18446744073709551615",
      updatedAt: "2026-08-21T10:00:00.000Z",
    });

    expect(signed).toMatchObject({
      signature: "signed-outbox-signature",
      signed_transaction: "AQID",
      last_valid_block_height: "18446744073709551615",
      submission_started_at: null,
    });
  });

  it.each([
    ["a scaled integer", "1234.0", "scaled"],
    ["a fractional value", "1234.5", "fractional"],
    ["a negative value", "-1", "negative"],
    ["a value above u64", "18446744073709551616", "above-u64"],
  ])("rejects %s as a last valid block height", async (_label, height, suffix) => {
    const transfer = await repo.createTransfer(transferInput({ suffix: `height-${suffix}` }));
    if (!transfer) throw new Error("Expected transfer creation to succeed");

    await expect(
      repo.persistSignedTransfer({
        transferId: transfer.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        signature: `height-${suffix}-signature`,
        signedTransaction: "AQID",
        lastValidBlockHeight: height,
        updatedAt: "2026-08-21T10:00:00.000Z",
      })
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "payment_transfers_last_valid_block_height_check",
    });

    await expect(
      repo.getTransferById({
        transferId: transfer.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      })
    ).resolves.toMatchObject({
      signature: null,
      signed_transaction: null,
      last_valid_block_height: null,
      submission_started_at: null,
    });
  });

  it("marks submission started only after the signed transfer is persisted", async () => {
    const transfer = await repo.createTransfer(transferInput({ suffix: "submission-start" }));
    if (!transfer) throw new Error("Expected transfer creation to succeed");

    await expect(
      repo.markTransferSubmissionStarted({
        transferId: transfer.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        startedAt: "2026-08-21T10:01:00.000Z",
      })
    ).resolves.toBeNull();

    await repo.persistSignedTransfer({
      transferId: transfer.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      signature: "submission-start-signature",
      signedTransaction: "BAUG",
      lastValidBlockHeight: "1000",
      updatedAt: "2026-08-21T10:00:00.000Z",
    });
    const started = await repo.markTransferSubmissionStarted({
      transferId: transfer.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      startedAt: "2026-08-21T10:01:00.000Z",
    });

    expect(started).toMatchObject({
      signature: "submission-start-signature",
      signed_transaction: "BAUG",
      last_valid_block_height: "1000",
      submission_started_at: "2026-08-21T10:01:00.000Z",
      updated_at: "2026-08-21T10:01:00.000Z",
    });
  });

  it("does not overwrite an already persisted signed transfer", async () => {
    const transfer = await repo.createTransfer(transferInput({ suffix: "signed-cas" }));
    if (!transfer) throw new Error("Expected transfer creation to succeed");
    const scope = {
      transferId: transfer.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
    };

    await repo.persistSignedTransfer({
      ...scope,
      signature: "original-signature",
      signedTransaction: "BwgJ",
      lastValidBlockHeight: "2000",
      updatedAt: "2026-08-21T10:02:00.000Z",
    });
    const replacement = await repo.persistSignedTransfer({
      ...scope,
      signature: "replacement-signature",
      signedTransaction: "CgsM",
      lastValidBlockHeight: "3000",
      updatedAt: "2026-08-21T10:03:00.000Z",
    });
    const persisted = await repo.getTransferById(scope);

    expect(replacement).toBeNull();
    expect(persisted).toMatchObject({
      signature: "original-signature",
      signed_transaction: "BwgJ",
      last_valid_block_height: "2000",
      updated_at: "2026-08-21T10:02:00.000Z",
    });
  });

  it("does not change submission state after the transfer leaves processing", async () => {
    const unsigned = await repo.createTransfer(transferInput({ suffix: "terminal-unsigned" }));
    const signed = await repo.createTransfer(transferInput({ suffix: "terminal-signed" }));
    if (!unsigned || !signed) throw new Error("Expected transfer creation to succeed");

    await repo.updateTransfer({
      transferId: unsigned.id,
      status: "failed",
      updatedAt: "2026-08-21T10:04:00.000Z",
    });
    await expect(
      repo.persistSignedTransfer({
        transferId: unsigned.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        signature: "too-late-signature",
        signedTransaction: "DQ4P",
        lastValidBlockHeight: "4000",
        updatedAt: "2026-08-21T10:05:00.000Z",
      })
    ).resolves.toBeNull();

    await repo.persistSignedTransfer({
      transferId: signed.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      signature: "signed-before-terminal",
      signedTransaction: "EBES",
      lastValidBlockHeight: "5000",
      updatedAt: "2026-08-21T10:06:00.000Z",
    });
    await repo.updateTransfer({
      transferId: signed.id,
      status: "failed",
      updatedAt: "2026-08-21T10:07:00.000Z",
    });
    await expect(
      repo.markTransferSubmissionStarted({
        transferId: signed.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        startedAt: "2026-08-21T10:08:00.000Z",
      })
    ).resolves.toBeNull();
  });

  it("keeps legacy transfers without signed-outbox fields valid", async () => {
    const legacy = await repo.createTransfer({
      ...transferInput({ suffix: "legacy-submission" }),
      signature: "legacy-signature",
      serializedTx: "legacy-serialized-transaction",
    });
    if (!legacy) throw new Error("Expected transfer creation to succeed");

    const confirmed = await repo.updateTransfer({
      transferId: legacy.id,
      status: "confirmed",
      updatedAt: "2026-08-21T10:09:00.000Z",
    });

    expect(confirmed).toMatchObject({
      signature: "legacy-signature",
      serialized_tx: "legacy-serialized-transaction",
      signed_transaction: null,
      last_valid_block_height: null,
      submission_started_at: null,
      status: "confirmed",
    });
  });

  it("scopes idempotency to project — same org+key in different projects do not collide", async () => {
    const repo = createPostgresPaymentsRepository(getDb(env));
    const base = {
      organizationId: TEST_ORG.id,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      counterpartyId: null,
      sourceAddress: "Source111",
      destinationAddress: "Dest111",
      token: "SOL",
      amount: "1",
      memo: null,
      type: "transfer" as const,
      direction: "outbound" as const,
      status: "processing" as const,
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: {},
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: null,
      idempotencyFingerprint: "fp-1",
      idempotencyKey: "shared-key",
    };
    const productionScoped = await repo.createTransfer({
      ...base,
      id: "xfr_production_scoped",
      projectId: projects.production.id,
    });
    const sandboxScoped = await repo.createTransfer({
      ...base,
      id: "xfr_sandbox_scoped",
      projectId: projects.sandbox.id,
    });
    expect(productionScoped?.id).not.toBe(sandboxScoped?.id);

    const foundProduction = await repo.findTransferByIdempotency({
      organizationId: TEST_ORG.id,
      projectId: projects.production.id,
      idempotencyKey: "shared-key",
    });
    const foundSandbox = await repo.findTransferByIdempotency({
      organizationId: TEST_ORG.id,
      projectId: projects.sandbox.id,
      idempotencyKey: "shared-key",
    });
    expect(foundProduction?.id).toBe(productionScoped?.id);
    expect(foundSandbox?.id).toBe(sandboxScoped?.id);
  });

  it("rejects a second transfer with the same (org, idempotency_key)", async () => {
    const repo = createPostgresPaymentsRepository(getDb(env));
    const base = {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      counterpartyId: null,
      sourceAddress: "Source111",
      destinationAddress: "Dest111",
      token: "SOL",
      amount: "1",
      memo: null,
      type: "transfer" as const,
      direction: "outbound" as const,
      status: "processing" as const,
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: {},
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: null,
      idempotencyFingerprint: "fp-1",
    };
    await repo.createTransfer({ ...base, id: "xfr_dup_key_first", idempotencyKey: "dup-key" });
    await expect(
      repo.createTransfer({ ...base, id: "xfr_dup_key_second", idempotencyKey: "dup-key" })
    ).rejects.toSatisfy((err: unknown) => isPostgresUniqueViolation(err));
  });
});

describe("PaymentsRepository.listTransfers token filter (postgres)", () => {
  const SOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    await resetPaymentFixtures();
  });

  async function seedMixedForms() {
    // Exactly the shape the local ledger holds: the same asset written as a bare
    // symbol on some rows and as its mint on others, all with type = transfer.
    const repo = createPostgresPaymentsRepository(getDb(env));
    await repo.createTransfer(transferInput({ token: "SOL", suffix: "sym-1" }));
    await repo.createTransfer(transferInput({ token: "SOL", suffix: "sym-2" }));
    await repo.createTransfer(transferInput({ token: SOL_MINT_ADDRESS, suffix: "mint-1" }));
    return repo;
  }

  const listArgs = {
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    limit: 50,
    offset: 0,
  };

  it("returns the mint rows and the symbol rows for one filter", async () => {
    const repo = await seedMixedForms();

    // An exact match returned 2 for the symbol and 1 for the mint. Both are the
    // same asset, so either spelling has to answer with all three.
    const bySymbol = await repo.listTransfers({ ...listArgs, token: "SOL" });
    const byMint = await repo.listTransfers({ ...listArgs, token: SOL_MINT_ADDRESS });

    expect(bySymbol.rows).toHaveLength(3);
    expect(byMint.rows).toHaveLength(3);
  });

  it("does not pull in a different asset that happens to share the catalogue", async () => {
    const repo = await seedMixedForms();
    await repo.createTransfer(transferInput({ token: "USDC", suffix: "usdc-1" }));

    const bySymbol = await repo.listTransfers({ ...listArgs, token: "SOL" });

    expect(bySymbol.rows).toHaveLength(3);
    expect(bySymbol.rows.every((row) => row.token !== "USDC")).toBe(true);
  });

  it("treats a blank token as no filter rather than as a value to match", async () => {
    const repo = await seedMixedForms();

    // The query schema takes `token` as a bare optional string, so whitespace
    // reaches the repository truthy. Matching it literally returned zero rows for
    // what is really an absent filter.
    const blank = await repo.listTransfers({ ...listArgs, token: "   " });

    expect(blank.rows).toHaveLength(3);
  });

  it("returns nothing for a token the organization has never transferred", async () => {
    const repo = await seedMixedForms();

    const none = await repo.listTransfers({ ...listArgs, token: "JUP" });

    expect(none.rows).toHaveLength(0);
  });
});

describe("PaymentsRepository.listTransfers wallet allowlist (postgres)", () => {
  const WALLET_A = "wallet_allowlist_a";
  const WALLET_B = "wallet_allowlist_b";
  const CUSTODY_WALLET_A = "cwlt_allowlist_a";
  const CUSTODY_WALLET_B = "cwlt_allowlist_b";

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    await resetPaymentFixtures();
  });

  async function seedTwoWallets() {
    const db = getDb(env);
    await seedTestCustodyRows(env, {
      configs: [
        {
          id: "cfg_payments_exact_allowlist",
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          provider: "privy",
          configEncrypted: "encrypted",
          status: "active",
        },
      ],
      wallets: [
        {
          id: CUSTODY_WALLET_A,
          owner: { kind: "config", custodyConfigId: "cfg_payments_exact_allowlist" },
          walletId: WALLET_A,
          publicKey: "Sourcea-1",
          label: null,
          purpose: null,
          status: "active",
        },
        {
          id: CUSTODY_WALLET_B,
          owner: { kind: "config", custodyConfigId: "cfg_payments_exact_allowlist" },
          walletId: WALLET_B,
          publicKey: "Sourceb-1",
          label: null,
          purpose: null,
          status: "active",
        },
      ],
    });
    const repo = createPostgresPaymentsRepository(getDb(env));
    await repo.createTransfer(
      transferInput({ custodyWalletId: CUSTODY_WALLET_A, walletId: WALLET_A, suffix: "a-1" })
    );
    const legacy = await repo.createTransfer(
      transferInput({ custodyWalletId: CUSTODY_WALLET_A, walletId: WALLET_A, suffix: "a-2" })
    );
    if (!legacy) throw new Error("Expected legacy transfer fixture creation to succeed");
    await db
      .prepare("UPDATE payment_transfers SET custody_wallet_id = NULL WHERE id = ?")
      .bind(legacy.id)
      .run();
    await repo.createTransfer(
      transferInput({ custodyWalletId: CUSTODY_WALLET_B, walletId: WALLET_B, suffix: "b-1" })
    );
    return repo;
  }

  const listArgs = {
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    limit: 50,
    offset: 0,
  };

  it("filters by one exact wallet", async () => {
    const repo = await seedTwoWallets();

    const selected = await repo.listTransfers({
      ...listArgs,
      custodyWalletId: CUSTODY_WALLET_A,
    });

    expect(selected.rows.map((row) => row.id)).toHaveLength(1);
    expect(selected.rows[0]?.custody_wallet_id).toBe(CUSTODY_WALLET_A);
  });
});

describe("PaymentsRepository pending-transfer job reads (postgres)", () => {
  const PRODUCTION_PROJECT_ID = `${TEST_PROJECT_ID}_production`;
  const TRANSFER_ID_BY_ENVIRONMENT = {
    sandbox: "xfr_job_sandbox",
    production: "xfr_job_production",
  } as const satisfies Record<SdpEnvironment, string>;

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    await resetPaymentFixtures();
    await seedUnreadPrivyWallet(getDb(env), {
      organizationId: TEST_ORG.id,
      projectId: PRODUCTION_PROJECT_ID,
      createdBy: TEST_USER.id,
      custodyWalletId: "cwlt_payments_repo_production",
      walletId: "wallet_payments_repo_production",
      publicKey: "Production111",
    });
    const repo = createPostgresPaymentsRepository(getDb(env));
    await repo.createTransfer({
      ...transferInput({ suffix: "job_sandbox" }),
      signature: "sig_job_sandbox",
    });
    await repo.createTransfer({
      ...transferInput({
        suffix: "job_production",
        custodyWalletId: "cwlt_payments_repo_production",
        walletId: "wallet_payments_repo_production",
      }),
      projectId: PRODUCTION_PROJECT_ID,
      signature: "sig_job_production",
    });
  });

  it.each(SDP_ENVIRONMENTS)(
    "selects only %s processing transfers for that environment's run",
    async (environment) => {
      const rows = await createPostgresPaymentsRepository(getDb(env)).listTransfersByStatus({
        environment,
        statuses: ["processing"],
        types: WALLET_TRANSFER_TYPES,
        hasSignature: true,
        limit: 50,
      });

      expect(rows.map((row) => row.id)).toEqual([TRANSFER_ID_BY_ENVIRONMENT[environment]]);
    }
  );

  it.each(SDP_ENVIRONMENTS)(
    "polls only %s confirmed transfers for that environment's run",
    async (environment) => {
      const confirmedAt = new Date().toISOString();
      await getDb(env)
        .prepare("UPDATE payment_transfers SET status = 'confirmed', confirmed_at = ?")
        .bind(confirmedAt)
        .run();

      const rows = await createPostgresPaymentsRepository(getDb(env)).listConfirmedTransfersToPoll({
        environment,
        confirmedAfter: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        limit: 50,
      });

      expect(rows.map((row) => row.id)).toEqual([TRANSFER_ID_BY_ENVIRONMENT[environment]]);
    }
  );
});
