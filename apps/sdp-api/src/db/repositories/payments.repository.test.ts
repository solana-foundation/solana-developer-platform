import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import { WALLET_TRANSFER_TYPES } from "@sdp/types/payments";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type { MoneyPrincipal } from "@/lib/money-principal";
import { createTenantScope, TenantScopeViolationError } from "@/lib/tenant-scope";
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
import { required } from "@/test/helpers/required";
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
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    projects = await resetPaymentFixtures();
    repo = createPostgresPaymentsRepository(getDb(env));
  });

  it.each<MoneyPrincipal>([
    { kind: "api_key", apiKeyId: "key_initiator" },
    { kind: "member", userId: "user_initiator" },
    { kind: "mandate", recurringPaymentId: "rpmt_initiator" },
    { kind: "payment_request", paymentRequestId: "preq_initiator" },
  ])("keeps the effective $kind identity through reads and status updates", async (principal) => {
    const input = {
      ...transferInput({ suffix: `principal_${principal.kind}` }),
      // A mandate may have been created by a key; that key is not its authority.
      initiatedByKeyId: "audit_creator",
      initiatedByPrincipal: principal,
    };
    const created = required(await repo.createTransfer(input));
    expect(created.initiated_by_principal).toEqual(principal);
    expect(created.initiated_by_key_id).toBe("audit_creator");

    await repo.updateTransfer({
      transferId: input.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "confirmed",
      providerData: { observed: true },
      updatedAt: new Date().toISOString(),
    });
    const replay = required(
      await repo.findTransferByIdempotency({
        organizationId: input.organizationId,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
      })
    );
    expect(replay.initiated_by_principal).toEqual(principal);
    expect(replay.initiated_by_key_id).toBe("audit_creator");
    expect(replay.status).toBe("confirmed");
  });

  it("leaves unrecorded authority null without inferring from an audit identity", async () => {
    const input = {
      ...transferInput({ suffix: "unrecorded_principal" }),
      initiatedByKeyId: "key_or_user_audit_id",
    };
    await repo.createTransfer(input);

    const stored = await repo.findTransferByIdempotency({
      organizationId: input.organizationId,
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
    });
    expect(required(stored)).toMatchObject({
      initiated_by_principal: null,
      initiated_by_key_id: "key_or_user_audit_id",
    });
  });

  it.for([
    { type: "transfer", guard: "unsigned" },
    { type: "transfer_batch", guard: "unsigned" },
    { type: "transfer", guard: "unstarted" },
    { type: "transfer_batch", guard: "unstarted" },
  ] as const)(
    "a stale $guard failure cannot overwrite a $type submission",
    async ({ type, guard }) => {
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
      const persistSigned = () =>
        repo.persistSignedTransfer({
          transferId: input.id,
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          signature: `signature-${type}`,
          signedTransaction: "AQ==",
          lastValidBlockHeight: "1000",
          updatedAt: new Date().toISOString(),
        });
      const startSubmission = () =>
        repo.markTransferSubmissionStarted({
          transferId: input.id,
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          startedAt: new Date().toISOString(),
        });
      if (guard === "unstarted") {
        expect(await persistSigned()).not.toBeNull();
      }
      // Observe before the request advances the state the failure depends on.
      const selected =
        guard === "unstarted"
          ? await repo.listProcessingSignedSubmissions({ environment: "sandbox", limit: 10 })
          : await repo.listTransfersByStatus({
              environment: "sandbox",
              statuses: ["processing"],
              types: WALLET_TRANSFER_TYPES,
              unsigned: true,
              limit: 10,
            });
      expect(selected.map((row) => row.id)).toContain(input.id);
      if (guard === "unstarted") {
        expect(await startSubmission()).not.toBeNull();
      } else {
        expect(await persistSigned()).not.toBeNull();
      }
      const timeout = {
        transferId: input.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        requireUnsigned: guard === "unsigned" ? (true as const) : undefined,
        requireUnstarted: guard === "unstarted" ? (true as const) : undefined,
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
      if (guard === "unsigned") {
        expect(await startSubmission()).not.toBeNull();
      }
    }
  );

  it("settles a batch chunk once, and a later settle neither claims nor overwrites it", async () => {
    const input = { ...transferInput({ suffix: "settle_claim" }), type: "transfer_batch" as const };
    await repo.createTransfer(input);
    await seedProjectCryptoWalletCounterparty(getDb(env), {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      createdBy: TEST_USER.id,
      counterpartyId: "cpty_settle_claim",
      counterpartyAccountId: "cpacct_settle_claim",
      walletAddress: input.destinationAddress,
    });
    const batches = createPostgresPaymentTransferBatchesRepository(getDb(env));
    await batches.createTransferBatchWithRecipients({
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
          counterpartyId: "cpty_settle_claim",
          counterpartyAccountId: "cpacct_settle_claim",
          destinationAddress: input.destinationAddress,
          amount: "1",
          status: "processing",
        },
      ],
    });
    const settle = (transferStatus: "confirmed" | "failed") =>
      batches.settleTransferBatch({
        transferId: input.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        transferStatus,
        error: transferStatus === "failed" ? "Transaction not found on chain" : null,
        slot: null,
        updatedAt: new Date().toISOString(),
      });

    await expect(settle("failed")).resolves.toBe(true);
    await expect(settle("confirmed")).resolves.toBe(false);
    expect(await readStatus(input.id)).toBe("failed");
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

  /** The row's status, or null when no row was written. */
  async function readStatus(id: string): Promise<string | null> {
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    return row === null ? null : row.status;
  }

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
      idempotency: { key: "claim-key", fingerprint: "claim-fp" },
      updatedAt: "2026-08-31T10:00:00.000Z",
    });

    expect(updated).toMatchObject({
      id: transfer.id,
      custody_wallet_id: TEST_CUSTODY_WALLET_ID,
      destination_address: depositAddress,
      initiated_by_key_id: "key_ramp_onchain",
      idempotency_key: "claim-key",
      idempotency_fingerprint: "claim-fp",
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
    expect(await readStatus(transfer.id)).toBe("awaiting_payment");
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
    await expect(
      repo.getTransferById({
        transferId: transfer.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      })
    ).resolves.toMatchObject({ provider: "moonpay", provider_reference: "moonpay-transaction-1" });
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

  it("finds a transfer by its idempotency key only within the project that wrote it", async () => {
    const keyed = (suffix: string, projectId: string) => ({
      ...transferInput({ suffix }),
      projectId,
      idempotencyKey: "shared-key",
      idempotencyFingerprint: `fp-${suffix}`,
    });
    await repo.createTransfer(keyed("production_scoped", projects.production.id));
    await repo.createTransfer(keyed("sandbox_scoped", projects.sandbox.id));

    const find = (projectId: string) =>
      repo.findTransferByIdempotency({
        organizationId: TEST_ORG.id,
        projectId,
        idempotencyKey: "shared-key",
      });
    expect(await find(projects.production.id)).toMatchObject({
      id: "xfr_production_scoped",
      idempotency_fingerprint: "fp-production_scoped",
    });
    expect(await find(projects.sandbox.id)).toMatchObject({
      id: "xfr_sandbox_scoped",
      idempotency_fingerprint: "fp-sandbox_scoped",
    });
  });

  it("rejects a second transfer with the same idempotency key in one project", async () => {
    const keyed = (suffix: string) => ({ ...transferInput({ suffix }), idempotencyKey: "dup-key" });
    await repo.createTransfer(keyed("dup_key_first"));

    await expect(repo.createTransfer(keyed("dup_key_second"))).rejects.toSatisfy((err: unknown) =>
      isPostgresUniqueViolation(err)
    );
    expect(await readStatus("xfr_dup_key_second")).toBeNull();
  });
});

describe("PaymentsRepository.listTransfers token filter (postgres)", () => {
  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    await resetPaymentFixtures();
  });

  async function seedMixedForms() {
    // The same asset is written as a bare symbol on some rows and as its mint
    // on others; a second asset sits beside it.
    const repo = createPostgresPaymentsRepository(getDb(env));
    await repo.createTransfer(transferInput({ token: "SOL", suffix: "sym-1" }));
    await repo.createTransfer(transferInput({ token: "SOL", suffix: "sym-2" }));
    await repo.createTransfer(transferInput({ token: SOL_MINT, suffix: "mint-1" }));
    await repo.createTransfer(transferInput({ token: "USDC", suffix: "usdc-1" }));
    return repo;
  }

  const listArgs = {
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    limit: 50,
    offset: 0,
  };

  async function listIds(repo: PaymentsRepository, token: string): Promise<string[]> {
    const { rows } = await repo.listTransfers({ ...listArgs, token });
    return rows.map((row) => row.id).sort();
  }

  it("answers either spelling of an asset with its symbol and mint rows, and no other asset", async () => {
    const repo = await seedMixedForms();
    const sol = ["xfr_mint-1", "xfr_sym-1", "xfr_sym-2"];

    expect(await listIds(repo, "SOL")).toEqual(sol);
    expect(await listIds(repo, SOL_MINT)).toEqual(sol);
  });

  it("treats a blank token as no filter rather than as a value to match", async () => {
    const repo = await seedMixedForms();

    expect(await listIds(repo, "   ")).toEqual([
      "xfr_mint-1",
      "xfr_sym-1",
      "xfr_sym-2",
      "xfr_usdc-1",
    ]);
  });

  it("returns nothing for a token the organization has never transferred", async () => {
    const repo = await seedMixedForms();

    expect(await listIds(repo, "JUP")).toEqual([]);
  });
});

describe("PaymentsRepository.listTransfers wallet allowlist (postgres)", () => {
  const WALLET_A = "wallet_allowlist_a";
  const WALLET_B = "wallet_allowlist_b";
  const CUSTODY_WALLET_A = "cwlt_allowlist_a";
  const CUSTODY_WALLET_B = "cwlt_allowlist_b";

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    await resetPaymentFixtures();
  });

  async function seedTwoWallets() {
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

    expect(selected.rows.map((row) => row.id)).toEqual(["xfr_a-1"]);
  });
});

describe("PaymentsRepository pending-transfer job reads (postgres)", () => {
  const PRODUCTION_PROJECT_ID = `${TEST_PROJECT_ID}_production`;
  const TRANSFER_ID_BY_ENVIRONMENT = {
    sandbox: "xfr_job_sandbox",
    production: "xfr_job_production",
  } as const satisfies Record<SdpEnvironment, string>;

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    await seedTestDatabase(env);
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

describe("PaymentsRepository.listProcessingSignedSubmissions (postgres)", () => {
  const PRODUCTION_PROJECT_ID = `${TEST_PROJECT_ID}_production`;
  const PRODUCTION_CUSTODY = {
    custodyWalletId: "cwlt_payments_repo_production",
    walletId: "wallet_payments_repo_production",
  };
  let repo: PaymentsRepository;

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    await seedTestDatabase(env);
    await resetPaymentFixtures();
    await seedUnreadPrivyWallet(getDb(env), {
      organizationId: TEST_ORG.id,
      projectId: PRODUCTION_PROJECT_ID,
      createdBy: TEST_USER.id,
      ...PRODUCTION_CUSTODY,
      publicKey: "Production111",
    });
    repo = createPostgresPaymentsRepository(getDb(env));
  });

  async function seedSignedSubmission(seed: {
    suffix: string;
    projectId: string;
    custody: { custodyWalletId: string; walletId: string };
    signedAt: string;
  }): Promise<string> {
    const transfer = {
      ...transferInput({ suffix: seed.suffix, ...seed.custody }),
      projectId: seed.projectId,
    };
    await repo.createTransfer(transfer);
    await repo.persistSignedTransfer({
      transferId: transfer.id,
      organizationId: TEST_ORG.id,
      projectId: seed.projectId,
      signature: `sig_${seed.suffix}`,
      signedTransaction: "AQ==",
      lastValidBlockHeight: "1000",
      updatedAt: seed.signedAt,
    });
    return transfer.id;
  }

  const sandboxCustody = { custodyWalletId: TEST_CUSTODY_WALLET_ID, walletId: TEST_WALLET_ID };

  it("selects only the run environment's processing rows with a saved signed submission", async () => {
    const signedAt = new Date().toISOString();
    const queued = await seedSignedSubmission({
      suffix: "queued",
      projectId: TEST_PROJECT_ID,
      custody: sandboxCustody,
      signedAt,
    });
    await repo.createTransfer(transferInput({ suffix: "unsigned" }));
    const settled = await seedSignedSubmission({
      suffix: "settled",
      projectId: TEST_PROJECT_ID,
      custody: sandboxCustody,
      signedAt,
    });
    await repo.updateTransfer({
      transferId: settled,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      expectedStatus: "processing",
      status: "confirmed",
      updatedAt: signedAt,
    });
    await seedSignedSubmission({
      suffix: "production",
      projectId: PRODUCTION_PROJECT_ID,
      custody: PRODUCTION_CUSTODY,
      signedAt,
    });

    const rows = await repo.listProcessingSignedSubmissions({ environment: "sandbox", limit: 10 });

    expect(rows).toMatchObject([
      {
        id: queued,
        status: "processing",
        signature: "sig_queued",
        signed_transaction: "AQ==",
        last_valid_block_height: "1000",
      },
    ]);
  });

  it("queues the least recently updated row first", async () => {
    const newer = await seedSignedSubmission({
      suffix: "newer",
      projectId: TEST_PROJECT_ID,
      custody: sandboxCustody,
      signedAt: new Date().toISOString(),
    });
    const older = await seedSignedSubmission({
      suffix: "older",
      projectId: TEST_PROJECT_ID,
      custody: sandboxCustody,
      signedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const rows = await repo.listProcessingSignedSubmissions({ environment: "sandbox", limit: 10 });

    expect(rows.map((row) => row.id)).toEqual([older, newer]);
  });

  it("refuses a tenant-scoped repository", async () => {
    const tenantRepo = createPostgresPaymentsRepository(
      getDb(env),
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
    );

    await expect(
      tenantRepo.listProcessingSignedSubmissions({ environment: "sandbox", limit: 10 })
    ).rejects.toThrow(TenantScopeViolationError);
  });
});
