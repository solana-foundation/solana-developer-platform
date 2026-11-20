import assert from "node:assert/strict";
import { SigningError } from "@sdp/custody/signing";
import { FeePaymentError } from "@sdp/fee-payment/port";
import { hashString } from "@sdp/payments/hash";
import * as solanaRpc from "@sdp/rpc/solana";
import {
  PAYMENT_TRANSFER_BATCH_RECIPIENT_STATUSES,
  PAYMENT_TRANSFER_BATCH_STATUSES,
  PAYMENT_TRANSFER_STATUSES,
} from "@sdp/types/payments";
import { SOL_MINT, SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  type Address,
  address,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
} from "@solana/kit";
import {
  getTransferCheckedInstructionDataDecoder,
  TOKEN_2022_PROGRAM_ADDRESS,
  TRANSFER_CHECKED_DISCRIMINATOR,
} from "@solana-program/token-2022";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import * as batchesRepositoryPostgres from "@/db/repositories/payment-transfer-batches.repository.postgres";
import * as paymentsRepositoryPostgres from "@/db/repositories/payments.repository.postgres";
import { createSystemPaymentTransferBatchesRepository } from "@/db/repositories/repository-factory";
import { app } from "@/index";
import { AppError } from "@/lib/errors";
import { deriveProviderRequestId } from "@/lib/idempotency";
import { requestFingerprint } from "@/middleware/idempotency";
import { runInEachClusterScope } from "@/runtime/cluster-scope-runs";
import { AuditService } from "@/services/audit.service";
import { admittedSigner } from "@/services/domain/signing/admitted-signer";
import { SigningService } from "@/services/domain/signing.service";
import { INSUFFICIENT_FUNDS_MESSAGE } from "@/services/fee-payment-errors";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcResponder, tokenAccountsByOwnerResult } from "@/test/helpers/cluster-rpc";
import { deferred } from "@/test/helpers/deferred";
import { env } from "@/test/helpers/env";
import { recordLoggedEvents } from "@/test/helpers/log-events";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import {
  createKoraAdapterMock,
  createOrgSignerForCustodyWalletMock,
  DEVNET_USDC_MINT,
  enableMainnetSponsorship,
  getAccountInfoMock,
  getRecentBlockhashMock,
  installPaymentsRouteTestHooks,
  MAINNET_USDC_MINT,
  rehomeTestApiKeyToProduction,
  seedCounterparty,
  seedProductionPrivyWallet,
  sendTransactionMock,
  TEST_API_KEY,
  TEST_CONFIG_ID,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PRODUCTION_PROJECT_ID,
  TEST_PROJECT,
  TEST_SPONSORSHIP_PROVIDER_CONFIG,
  TEST_WALLET_ID,
  testKoraAdapter,
  updateSeededWalletPublicKey,
} from "@/test/helpers/payments-routes";
import {
  readErrorResponse,
  seedConnectionOwnedDuplicateProviderWallet,
  seedSelectedApiKeyWallets,
} from "@/test/helpers/payments-transfers";
import { setDisabledMovements } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { sendTransactionPreflightError } from "@/test/helpers/rpc-errors";
import { fullySignTestTransaction, TEST_MOCK_FEE_PAYER } from "@/test/helpers/sponsor-signing";
import {
  respondMintAccounts,
  respondTokenAccounts,
  scaledUiAmountConfig,
} from "@/test/helpers/token-mints";
import { fullChunkOf } from "@/test/helpers/transfer-batches";
import { seedApiKeyRow } from "@/test/mocks/db";
import { canonicalizeTransferBatchBody, previousCanonicalTransferBatchBody } from "./idempotency";
import { createTransferBatchSchema, MAX_TRANSFER_BATCH_RECIPIENTS } from "./schemas";
import { MAX_RECIPIENTS_PER_TRANSACTION } from "./transaction";

const getMultipleAccountsLamportsMock = vi.spyOn(solanaRpc, "getMultipleAccountsLamports");
const getSignatureStatusesMock = vi.spyOn(solanaRpc, "getSignatureStatuses");

const WALLET_A = TEST_SOLANA_ADDRESSES.wallet2;
const WALLET_B = TEST_SOLANA_ADDRESSES.wallet3;
/** The rent-exempt minimum for a 0-byte account, in lamports (0.00089088 SOL). */
const SYSTEM_ACCOUNT_RENT_MINIMUM = 890_880;
const BATCHES_PATH = "/v1/payments/transfer-batches";
const EXECUTE_PATH = `${BATCHES_PATH}/execute`;

const batchSchema = z.object({
  id: z.string(),
  status: z.enum(PAYMENT_TRANSFER_BATCH_STATUSES),
  externalId: z.string().nullable(),
  sourceCustodyWalletId: z.string().nullable(),
  sourceAddress: z.string(),
  token: z.string(),
  totalAmount: z.string().nullable(),
  recipientCount: z.number(),
  transactionCount: z.number(),
});
const recipientSchema = z.object({
  id: z.string(),
  transferId: z.string().nullable(),
  externalId: z.string().nullable(),
  counterpartyId: z.string(),
  counterpartyAccountId: z.string(),
  destination: z.string(),
  amount: z.string(),
  status: z.enum(PAYMENT_TRANSFER_BATCH_RECIPIENT_STATUSES),
  error: z.string().nullable(),
});
const chunkTransferSchema = z.object({
  id: z.string(),
  custodyWalletId: z.string().nullable(),
  type: z.string(),
  status: z.enum(PAYMENT_TRANSFER_STATUSES),
  signature: z.string().nullable(),
  serializedTx: z.string().nullable(),
  fee: z.number().nullable(),
  error: z.string().nullable(),
  token: z.string(),
  amount: z.string(),
});
const batchResponseSchema = z.object({
  data: z.object({
    batch: batchSchema,
    recipients: z.array(recipientSchema),
    transfers: z.array(chunkTransferSchema),
  }),
});
const batchListSchema = z.object({ data: z.array(batchSchema) });
const estimateResponseSchema = z.object({
  data: z.object({
    estimate: z.object({
      recipientCount: z.number(),
      transactionCount: z.number(),
      estimatedFees: z.object({
        networkFeeLamports: z.string(),
        priorityFeeLamports: z.string(),
        tokenAccountRentLamports: z.string(),
        sponsored: z.boolean(),
      }),
      warnings: z.array(z.record(z.string(), z.unknown())),
    }),
  }),
});
type BatchResponse = z.infer<typeof batchResponseSchema>["data"];

async function readBatch(response: Response): Promise<BatchResponse> {
  expect(response.status).toBe(200);
  return batchResponseSchema.parse(await response.json()).data;
}

async function readError(response: Response, status: number) {
  expect(response.status).toBe(status);
  return (await readErrorResponse(response)).error;
}

/** The payout run every batch a test sends belongs to, unless the test names another. */
function testRunId(): string {
  return `run-${required(expect.getState().currentTestName)}`.slice(0, 256);
}

interface BatchRecipient {
  externalId?: string;
  counterpartyId?: string;
  counterpartyAccountId: string;
  amount: string;
}

interface SendOptions {
  /** Omitted: a fresh Idempotency-Key per call. */
  key?: string;
  apiKey?: string;
  /** Fields that replace the default body's: this test's run, the seeded wallet, SOL. */
  body?: Record<string, unknown>;
}

function postBatchRequest(
  path: string,
  recipients: readonly BatchRecipient[],
  options: SendOptions
) {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey === undefined ? TEST_API_KEY.raw : options.apiKey}`,
        "Idempotency-Key": options.key === undefined ? crypto.randomUUID() : options.key,
      },
      body: JSON.stringify({
        externalId: testRunId(),
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        token: "SOL",
        recipients,
        ...options.body,
      }),
    },
    env
  );
}

function sendBatch(recipients: readonly BatchRecipient[], options: SendOptions = {}) {
  return postBatchRequest(EXECUTE_PATH, recipients, options);
}

function estimateBatch(recipients: readonly BatchRecipient[], options: SendOptions = {}) {
  return postBatchRequest(`${BATCHES_PATH}/estimate`, recipients, options);
}

function getBatch(batchId: string) {
  return app.request(
    `${BATCHES_PATH}/${batchId}`,
    { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
    env
  );
}

/** One counterparty holding an active Solana account per address, in the given project. */
async function seedRecipientAccounts(
  addresses: readonly string[],
  projectId: string = TEST_PROJECT.id
): Promise<{ counterpartyId: string; counterpartyAccountId: string }[]> {
  const counterpartyId = await seedCounterparty({ projectId });
  const now = new Date().toISOString();
  const ids = addresses.map(() => `counterparty_account_${crypto.randomUUID()}`);
  await getDb(env)
    .prepare(
      `INSERT INTO counterparty_accounts (
         id, organization_id, project_id, counterparty_id, account_kind, label,
         details, provider_account_data, status, created_at, updated_at
       ) VALUES ${addresses.map(() => "(?, ?, ?, ?, 'crypto_wallet', 'Batch wallet', ?, '{}', 'active', ?, ?)").join(", ")}`
    )
    .bind(
      ...addresses.flatMap((walletAddress, index) => [
        ids[index],
        TEST_ORG.id,
        projectId,
        counterpartyId,
        JSON.stringify({ network: "solana", address: walletAddress }),
        now,
        now,
      ])
    )
    .run();
  return ids.map((counterpartyAccountId) => ({ counterpartyId, counterpartyAccountId }));
}

async function seedRecipientAccount(walletAddress: string) {
  const [account] = await seedRecipientAccounts([walletAddress]);
  return required(account);
}

/** Two full chunks of SOL: `first` paid 0.1 each, `second` 0.2 each. */
async function seedTwoChunkRecipients(): Promise<BatchRecipient[]> {
  const [first, second] = await seedRecipientAccounts([WALLET_A, WALLET_B]);
  return [
    ...fullChunkOf({ ...required(first), amount: "0.1" }),
    ...fullChunkOf({ ...required(second), amount: "0.2" }),
  ];
}

async function countBatches(): Promise<number> {
  const row = await getDb(env)
    .prepare(
      "SELECT COUNT(*)::int AS count FROM payment_transfer_batches WHERE organization_id = ? AND project_id = ?"
    )
    .bind(TEST_ORG.id, TEST_PROJECT.id)
    .first<{ count: number }>();
  return required(row).count;
}

async function readBatchStatus(batchId: string): Promise<string> {
  const row = await getDb(env)
    .prepare("SELECT status FROM payment_transfer_batches WHERE id = ?")
    .bind(batchId)
    .first<{ status: string }>();
  return required(row).status;
}

async function readRecipientRows(batchId: string) {
  const result = await getDb(env)
    .prepare(
      "SELECT status, error, transfer_id FROM payment_transfer_recipients WHERE batch_id = ? ORDER BY created_at, id"
    )
    .bind(batchId)
    .all();
  return z
    .array(
      z.object({
        status: z.enum(PAYMENT_TRANSFER_BATCH_RECIPIENT_STATUSES),
        error: z.string().nullable(),
        transfer_id: z.string().nullable(),
      })
    )
    .parse(result.results);
}

/** The signatures of the transactions broadcast so far, in send order. */
function sentSignatures(): string[] {
  return sendTransactionMock.mock.calls.map(([, bytes]) =>
    getSignatureFromTransaction(getTransactionDecoder().decode(bytes))
  );
}

function sponsorAdapter(signAsFeePayer: (transaction: Uint8Array) => Promise<Uint8Array>) {
  return testKoraAdapter({
    getFeePayer: vi.fn().mockResolvedValue(TEST_MOCK_FEE_PAYER),
    getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
    signAsFeePayer: vi.fn(signAsFeePayer),
  });
}

/** Wraps a repository factory so one method can fail or observe; restored after the test. */
function wrapBatchesRepository(
  override: (
    repository: ReturnType<
      typeof batchesRepositoryPostgres.createPostgresPaymentTransferBatchesRepository
    >
  ) => Partial<
    ReturnType<typeof batchesRepositoryPostgres.createPostgresPaymentTransferBatchesRepository>
  >
) {
  const create = batchesRepositoryPostgres.createPostgresPaymentTransferBatchesRepository;
  const spy = vi
    .spyOn(batchesRepositoryPostgres, "createPostgresPaymentTransferBatchesRepository")
    .mockImplementation((db) => {
      const repository = create(db);
      return { ...repository, ...override(repository) };
    });
  onTestFinished(() => spy.mockRestore());
}

function wrapPaymentsRepository(
  override: (
    repository: ReturnType<typeof paymentsRepositoryPostgres.createPostgresPaymentsRepository>
  ) => Partial<ReturnType<typeof paymentsRepositoryPostgres.createPostgresPaymentsRepository>>
) {
  const create = paymentsRepositoryPostgres.createPostgresPaymentsRepository;
  const spy = vi
    .spyOn(paymentsRepositoryPostgres, "createPostgresPaymentsRepository")
    .mockImplementation((db, scope) => {
      const repository = create(db, scope);
      return { ...repository, ...override(repository) };
    });
  onTestFinished(() => spy.mockRestore());
}

const auditRowSchema = z.object({
  resource_id: z.string(),
  status: z.string(),
  metadata: z.string().transform((raw) => z.record(z.string(), z.unknown()).parse(JSON.parse(raw))),
});
const auditOutcomeMetadataSchema = z.object({
  auditPhase: z.string(),
  auditIntentId: z.string(),
  batchTransferStatus: z.string(),
  signature: z.string(),
});

/** A chunk transfer's audit intent and outcome rows (APE-425); either may be missing. */
async function readChunkAudit(transferId: string) {
  const intent = await getDb(env)
    .prepare(
      `SELECT resource_id, status, metadata FROM audit_logs
        WHERE action = 'maintenance' AND resource_type = 'audit_ledger'
          AND metadata::jsonb -> 'target' ->> 'resourceId' = ?`
    )
    .bind(transferId)
    .first();
  const outcome = await getDb(env)
    .prepare(
      `SELECT resource_id, status, metadata FROM audit_logs
        WHERE action = 'transfer' AND resource_type = 'payment_transfer' AND resource_id = ?`
    )
    .bind(transferId)
    .first();
  return {
    intent: intent === null ? null : auditRowSchema.parse(intent),
    outcome: outcome === null ? null : auditRowSchema.parse(outcome),
  };
}

async function expectChunkOutcome(
  transfer: { id: string; signature: string | null },
  verdict: { status: "success" | "failure"; batchTransferStatus: string }
) {
  const { intent, outcome } = await readChunkAudit(transfer.id);
  expect(required(outcome).status).toBe(verdict.status);
  expect(auditOutcomeMetadataSchema.parse(required(outcome).metadata)).toEqual({
    auditPhase: "outcome",
    auditIntentId: required(intent).resource_id,
    batchTransferStatus: verdict.batchTransferStatus,
    signature: required(transfer.signature),
  });
}

function settleChainVerdicts(verdict: (signature: string) => solanaRpc.SignatureStatusInfo) {
  getSignatureStatusesMock.mockImplementation(async (_rpc, signatures) =>
    signatures.map((signature) => verdict(String(signature)))
  );
}

const CONFIRMED: solanaRpc.SignatureStatusInfo = {
  slot: 200n,
  confirmations: 5n,
  confirmationStatus: "confirmed",
  err: null,
};
const FAILED_ON_CHAIN: solanaRpc.SignatureStatusInfo = {
  slot: 201n,
  confirmations: null,
  confirmationStatus: "finalized",
  err: { InstructionError: [0, { Custom: 1 }] },
};

describe("payment transfer batches", () => {
  const rpc = installClusterRpcResponder();
  installPaymentsRouteTestHooks();
  /** The seeded source wallet's key: every chunk is signed for real. */
  let source: KeyPairSigner;

  function answerSourceTokenAccount(mint: string) {
    rpc.answer(
      "getTokenAccountsByOwner",
      tokenAccountsByOwnerResult(1, [
        {
          pubkey: WALLET_B,
          mint,
          amount: "1000000000",
          decimals: 6,
          uiAmountString: "1000",
          state: "initialized",
        },
      ])
    );
  }

  /** Answers the next mint read from the cluster, for a mint the test describes. */
  function readMintFromCluster(
    mint: Address,
    extensions: Parameters<typeof respondMintAccounts>[1]
  ) {
    getAccountInfoMock.mockImplementationOnce(
      async (client, account) =>
        (
          await client
            .getAccountInfo(account, { encoding: "base64", commitment: "confirmed" })
            .send()
        ).value
    );
    answerSourceTokenAccount(mint);
    respondMintAccounts(rpc, extensions);
  }

  beforeEach(async () => {
    rpc.answer("getMinimumBalanceForRentExemption", SYSTEM_ACCOUNT_RENT_MINIMUM);
    rpc.answer("simulateTransaction", {
      context: { slot: 1 },
      value: { err: null, logs: [], accounts: null, unitsConsumed: 150, returnData: null },
    });
    // Every recipient token account exists unless a test says otherwise (HOO-2024).
    respondTokenAccounts(rpc, { tokenProgram: address(SPL_TOKEN_PROGRAMS["spl-token"]) });
    // Every address is a funded account unless a test says otherwise.
    getMultipleAccountsLamportsMock.mockImplementation(async (_rpc, addresses) =>
      addresses.map(() => 1_000_000_000n)
    );
    source = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(source.address);
    createOrgSignerForCustodyWalletMock.mockResolvedValue(source);
  });

  it("refuses archived counterparties' accounts before creating or signing a batch", async () => {
    const { counterpartyId, counterpartyAccountId } = await seedRecipientAccount(WALLET_A);
    const archived = await app.request(
      `/v1/counterparties/${counterpartyId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Idempotency-Key": crypto.randomUUID(),
        },
      },
      env
    );
    expect(archived.status).toBe(204);

    const error = await readError(
      await sendBatch([{ counterpartyId, counterpartyAccountId, amount: "0.1" }]),
      404
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe(`Counterparty account ${counterpartyAccountId} not found`);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).not.toHaveBeenCalled();
    expect(await countBatches()).toBe(0);
  });

  it("refuses an account under a counterparty other than the one named, and derives the counterparty when omitted", async () => {
    const [account] = await seedRecipientAccounts([WALLET_A]);
    const other = await seedRecipientAccount(WALLET_B);
    const { counterpartyId, counterpartyAccountId } = required(account);

    const mismatched = await readError(
      await sendBatch([
        { counterpartyId: other.counterpartyId, counterpartyAccountId, amount: "0.1" },
      ]),
      404
    );
    expect(mismatched.message).toBe(`Counterparty account ${counterpartyAccountId} not found`);
    expect(await countBatches()).toBe(0);

    const created = await readBatch(await sendBatch([{ counterpartyAccountId, amount: "0.1" }]));
    expect(created.recipients.map((r) => r.counterpartyId)).toEqual([counterpartyId]);
  });

  it("refuses an amount finer than the token's decimals with 400, writing nothing", async () => {
    const recipient = await seedRecipientAccount(WALLET_A);

    const error = await readError(await sendBatch([{ ...recipient, amount: "1.0000000001" }]), 400);

    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toBe("Amount has too many decimal places");
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(await countBatches()).toBe(0);
  });

  it.each([
    ["create", EXECUTE_PATH],
    ["estimate", `${BATCHES_PATH}/estimate`],
  ])(
    "refuses a %s body with fields the API does not define with 400, reading nothing",
    async (_route, path) => {
      const recipient = await seedRecipientAccount(WALLET_A);

      const error = await readError(
        await postBatchRequest(path, [{ ...recipient, amount: "0.1" }], {
          body: { options: { maxRecipientsPerTransaction: 1 } },
        }),
        400
      );

      expect(error.code).toBe("BAD_REQUEST");
      expect(error.message).toContain('"options"');
      expect(rpc.calls).toEqual([]);
      expect(await countBatches()).toBe(0);
    }
  );

  it("estimates a batch's transactions and the network fee of every one", async () => {
    rpc.answer("getFeeForMessage", { context: { slot: 1 }, value: 5000 });
    const recipients = await seedTwoChunkRecipients();

    const response = await estimateBatch(recipients);

    expect(response.status).toBe(200);
    expect(estimateResponseSchema.parse(await response.json()).data.estimate).toEqual({
      recipientCount: 2 * MAX_RECIPIENTS_PER_TRANSACTION,
      transactionCount: 2,
      estimatedFees: {
        networkFeeLamports: "10000",
        priorityFeeLamports: "0",
        tokenAccountRentLamports: "0",
        sponsored: true,
      },
      warnings: [],
    });
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(await countBatches()).toBe(0);
  });

  describe("native SOL below the rent-exempt minimum (HOO-2375)", () => {
    const UNFUNDED = WALLET_B;
    const FUNDED = WALLET_A;

    /** A funded and an unfunded address paid below the minimum, and a large payment above it. */
    async function seedRentRecipients() {
      const [funded, unfunded, large] = await seedRecipientAccounts([
        FUNDED,
        UNFUNDED,
        syntheticAddress(41),
      ]);
      // 0.0001 SOL is below the 0.00089088 SOL minimum; 0.1 SOL is above it.
      return {
        funded: required(funded),
        recipients: [
          { ...required(funded), amount: "0.0001" },
          { ...required(unfunded), amount: "0.0001" },
          { ...required(large), amount: "0.1" },
        ],
        large: required(large),
      };
    }

    function answerOnlyFunded() {
      getMultipleAccountsLamportsMock.mockImplementation(async (_rpc, addresses) =>
        addresses.map((account) => (account === FUNDED ? 5_000_000n : 0n))
      );
    }

    it("warns in the estimate for a recipient below the minimum whose address has no account", async () => {
      rpc.answer("getFeeForMessage", { context: { slot: 1 }, value: 5000 });
      answerOnlyFunded();
      const { recipients } = await seedRentRecipients();

      const response = await estimateBatch(recipients);

      expect(response.status).toBe(200);
      expect(estimateResponseSchema.parse(await response.json()).data.estimate.warnings).toEqual([
        {
          code: "AMOUNT_BELOW_RENT_MINIMUM",
          recipientIndex: 1,
          minimumAmount: "0.00089088",
          message:
            "Recipient 1's address has no account, so it must receive at least 0.00089088 SOL, the rent-exempt minimum",
        },
      ]);
    });

    // RPC budget: a recipient paid at least the minimum needs no balance read.
    it("reads the balances of only the source and the recipients paid below the minimum", async () => {
      rpc.answer("getFeeForMessage", { context: { slot: 1 }, value: 5000 });
      const { recipients } = await seedRentRecipients();
      const clearing = recipients.map((recipient) => ({ ...recipient, amount: "0.01" }));

      expect((await estimateBatch(recipients)).status).toBe(200);
      expect((await estimateBatch(clearing)).status).toBe(200);

      expect(
        getMultipleAccountsLamportsMock.mock.calls.map(([, addresses]) => [...addresses].sort())
      ).toEqual([[FUNDED, UNFUNDED, source.address].sort(), [source.address]]);
    });

    it("refuses create with an unstored 409 before writing or sending, and runs again once the address is funded", async () => {
      answerOnlyFunded();
      const { recipients } = await seedRentRecipients();
      const key = crypto.randomUUID();

      const error = await readError(await sendBatch(recipients, { key }), 409);

      expect(error).toEqual({
        code: "AMOUNT_BELOW_RENT_MINIMUM",
        message:
          "Recipient 1 sends to an address that has no account, so each must receive at least 0.00089088 SOL, the rent-exempt minimum.",
        details: {
          recipientIndexes: [1],
          sourceRemainder: null,
          minimumAmount: "0.00089088",
          minimumLamports: "890880",
        },
      });
      expect(sendTransactionMock).not.toHaveBeenCalled();
      expect(await countBatches()).toBe(0);

      getMultipleAccountsLamportsMock.mockImplementation(async (_rpc, addresses) =>
        addresses.map(() => 5_000_000n)
      );
      const accepted = await sendBatch(recipients, { key });
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("Idempotent-Replayed")).toBeNull();
      expect(await countBatches()).toBe(1);
    });

    it("warns and refuses when the batch would leave the source wallet below the minimum", async () => {
      rpc.answer("getFeeForMessage", { context: { slot: 1 }, value: 5000 });
      const recipients = (await seedRentRecipients()).recipients.map((recipient) => ({
        ...recipient,
        amount: "0.01",
      }));
      // 0.0303 SOL held, 0.03 sent: 0.0003 SOL left, below the 0.00089088 minimum.
      getMultipleAccountsLamportsMock.mockImplementation(async (_rpc, addresses) =>
        addresses.map(() => 30_300_000n)
      );
      const sourceMessage =
        "The source wallet would be left with 0.0003 SOL, below the 0.00089088 SOL rent-exempt minimum: send its whole balance in one transaction, or leave at least the minimum.";

      const estimate = await estimateBatch(recipients);
      expect(estimate.status).toBe(200);
      expect(estimateResponseSchema.parse(await estimate.json()).data.estimate.warnings).toEqual([
        {
          code: "SOURCE_BELOW_RENT_MINIMUM",
          minimumAmount: "0.00089088",
          sourceRemainder: "0.0003",
          message: sourceMessage,
        },
      ]);

      const error = await readError(await sendBatch(recipients), 409);
      expect(error).toEqual({
        code: "AMOUNT_BELOW_RENT_MINIMUM",
        message: sourceMessage,
        details: {
          recipientIndexes: [],
          sourceRemainder: "0.0003",
          minimumAmount: "0.00089088",
          minimumLamports: "890880",
        },
      });
      expect(sendTransactionMock).not.toHaveBeenCalled();
    });

    it("refuses a sweep whose concurrent chunks could leave the source below the minimum", async () => {
      const { funded, large } = await seedRentRecipients();
      // 20 x 0.001 + 20 x 0.00002 sweeps 0.0204 SOL exactly; whichever chunk lands
      // alone first leaves the other's 0.0004 SOL behind.
      getMultipleAccountsLamportsMock.mockImplementation(async (_rpc, addresses) =>
        addresses.map((account) => (account === FUNDED ? 5_000_000n : 20_400_000n))
      );

      const error = await readError(
        await sendBatch([
          ...fullChunkOf({ ...large, amount: "0.001" }),
          ...fullChunkOf({ ...funded, amount: "0.00002" }),
        ]),
        409
      );

      expect(error.code).toBe("AMOUNT_BELOW_RENT_MINIMUM");
      expect(error.details).toEqual({
        recipientIndexes: [],
        sourceRemainder: "0.0004",
        minimumAmount: "0.00089088",
        minimumLamports: "890880",
      });
      expect(sendTransactionMock).not.toHaveBeenCalled();
    });
  });

  it("refuses a stopped batch before its row and retries under the same key", async () => {
    const recipient = await seedRecipientAccount(WALLET_A);
    await setDisabledMovements(getDb(env), TEST_PROJECT.id, ["payments.transfer_batch"]);

    const error = await readError(
      await sendBatch([{ ...recipient, amount: "0.1" }], { key: "disabled-project-batch" }),
      403
    );

    expect(error).toEqual({
      code: "FORBIDDEN",
      message: "This movement is disabled for the project",
      details: { reason: "movement_disabled" },
    });
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(await countBatches()).toBe(0);

    await setDisabledMovements(getDb(env), TEST_PROJECT.id, []);
    const retried = await sendBatch([{ ...recipient, amount: "0.1" }], {
      key: "disabled-project-batch",
    });
    expect(retried.status).toBe(200);
    expect(retried.headers.get("Idempotent-Replayed")).toBeNull();
    expect(await countBatches()).toBe(1);
  });

  it("refuses the next chunk when a project is stopped after the first sponsor signs", async () => {
    const secondSimulation = deferred<void>();
    let simulations = 0;
    const simulate = vi.spyOn(solanaRpc, "simulateTransaction").mockImplementation(async () => {
      simulations += 1;
      if (simulations === 2) await secondSimulation.promise;
      return { success: true, logs: [], unitsConsumed: null, error: null };
    });
    onTestFinished(() => {
      secondSimulation.resolve();
      simulate.mockRestore();
    });
    const signAsFeePayer = vi.fn(async (transaction: Uint8Array) => {
      await setDisabledMovements(getDb(env), TEST_PROJECT.id, ["payments.transfer_batch"]);
      secondSimulation.resolve();
      return fullySignTestTransaction(transaction);
    });
    createKoraAdapterMock.mockReturnValueOnce(sponsorAdapter(signAsFeePayer));

    const body = await readBatch(await sendBatch(await seedTwoChunkRecipients()));

    const failed = body.recipients.filter((r) => r.status === "failed");
    expect(failed.map((r) => r.error)).toEqual(
      fullChunkOf("This movement is disabled for the project")
    );
    expect(body.recipients.filter((r) => r.status === "processing")).toHaveLength(
      MAX_RECIPIENTS_PER_TRANSACTION
    );
    expect(body.transfers.map((t) => t.status).sort()).toEqual(["failed", "processing"]);
    expect(signAsFeePayer).toHaveBeenCalledOnce();
    expect(sendTransactionMock).toHaveBeenCalledOnce();
  });

  it.each([
    {
      refused: "the second chunk",
      allowed: 1,
      batchStatus: "processing",
      failed: MAX_RECIPIENTS_PER_TRANSACTION,
      transfers: ["processing"],
      sends: 1,
    },
    {
      refused: "every chunk",
      allowed: 0,
      batchStatus: "failed",
      failed: 2 * MAX_RECIPIENTS_PER_TRANSACTION,
      transfers: [],
      sends: 0,
    },
  ])(
    "fails $refused when the custody provider's policy refuses it, and replays that result",
    async ({ allowed, batchStatus, failed: failedCount, transfers, sends }) => {
      let signings = 0;
      createOrgSignerForCustodyWalletMock.mockResolvedValueOnce(
        admittedSigner(
          {
            ...source,
            signTransactions: async (...args) => {
              signings += 1;
              if (signings <= allowed) return source.signTransactions(...args);
              throw new SigningError("private provider response", "POLICY_REFUSED");
            },
          },
          async () => ({ admitted: true }),
          {
            movement: "payments.transfer_batch",
            organizationId: TEST_ORG.id,
            projectId: TEST_PROJECT.id,
            custodyWalletId: TEST_CUSTODY_WALLET_ID,
            provider: "privy",
            credential: null,
          }
        )
      );
      const recipients = await seedTwoChunkRecipients();
      const key = crypto.randomUUID();

      const created = await readBatch(await sendBatch(recipients, { key }));

      expect(created.batch.status).toBe(batchStatus);
      const failed = created.recipients.filter((r) => r.status === "failed");
      expect(failed).toHaveLength(failedCount);
      for (const recipient of failed) {
        expect(recipient.error).toBe(
          "Privy blocked signing due to a wallet policy. Review the policy in Privy or adjust the request."
        );
        expect(recipient.transferId).toBeNull();
      }
      expect(created.transfers.map((t) => t.status)).toEqual(transfers);
      expect(sendTransactionMock).toHaveBeenCalledTimes(sends);

      const replay = await sendBatch(recipients, { key });
      expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
      expect(await readBatch(replay)).toEqual(created);
      expect(signings).toBe(2);
    }
  );

  it("creates a SOL transfer batch and records chunk transfers", async () => {
    const [first, second] = await seedRecipientAccounts([WALLET_A, WALLET_B]);

    const created = await readBatch(
      await sendBatch(
        [
          ...fullChunkOf({
            ...required(first),
            externalId: "batch-recipient-001",
            amount: "0.005",
          }),
          ...fullChunkOf({
            ...required(second),
            externalId: "batch-recipient-002",
            amount: "0.01",
          }),
        ],
        { body: { externalId: "batch-create-001" } }
      )
    );

    expect(created.batch).toMatchObject({
      status: "processing",
      externalId: "batch-create-001",
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      sourceAddress: source.address,
      token: SOL_MINT,
      totalAmount: "0.3",
      recipientCount: 2 * MAX_RECIPIENTS_PER_TRANSACTION,
      transactionCount: 2,
    });
    // Sent without waiting for the chain: the pending-transfers job settles each chunk.
    expect(created.transfers.map((t) => t.status)).toEqual(["processing", "processing"]);
    expect(created.transfers.map((t) => t.signature).sort()).toEqual(sentSignatures().sort());
    for (const transfer of created.transfers) {
      expect(transfer).toMatchObject({
        type: "transfer_batch",
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        token: SOL_MINT,
        // Every chunk is sponsored: the source wallet pays no network fee (HOO-2614).
        fee: 0,
        // A chunk's signed bytes stay server-side; readers get the signature (HOO-2344).
        serializedTx: null,
      });
    }
    // Each chunk carries exactly its recipients, every one processing.
    const linked = (amount: string) =>
      created.recipients.filter(
        (r) => r.transferId === required(created.transfers.find((t) => t.amount === amount)).id
      );
    expect(linked("0.1").map((r) => [r.amount, r.status, r.externalId])).toEqual(
      fullChunkOf(["0.005", "processing", "batch-recipient-001"])
    );
    expect(linked("0.2").map((r) => [r.amount, r.status, r.externalId])).toEqual(
      fullChunkOf(["0.01", "processing", "batch-recipient-002"])
    );
  });

  // HOO-2099: the custody signer refuses a wallet outside a selected key's
  // scope; authorize refuses it first, so a refused batch writes nothing and
  // its Idempotency-Key works again once the scope allows the wallet.
  it("refuses a batch from a wallet outside the key's scope before writing anything", async () => {
    await seedSelectedApiKeyWallets([]);
    const recipient = await seedRecipientAccount(WALLET_A);
    const key = crypto.randomUUID();

    const error = await readError(await sendBatch([{ ...recipient, amount: "0.1" }], { key }), 403);

    expect(error).toEqual({
      code: "FORBIDDEN",
      message: "The credential may not sign with this wallet",
      details: { reason: "wallet_out_of_scope" },
    });
    const keyRows = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS count FROM idempotency_keys WHERE idempotency_key = ?")
      .bind(key)
      .first<{ count: number }>();
    expect(required(keyRows).count).toBe(0);
    expect(await countBatches()).toBe(0);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();

    await seedSelectedApiKeyWallets([TEST_CUSTODY_WALLET_ID]);
    expect((await sendBatch([{ ...recipient, amount: "0.1" }], { key })).status).toBe(200);
  });

  it("executes the exact Config-owned wallet when a Connection duplicates its Provider ID", async () => {
    await seedConnectionOwnedDuplicateProviderWallet();
    const recipient = await seedRecipientAccount(WALLET_A);

    const created = await readBatch(await sendBatch([{ ...recipient, amount: "0.1" }]));

    expect(created.batch).toMatchObject({
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      sourceAddress: source.address,
    });
    expect(created.transfers.map((t) => t.custodyWalletId)).toEqual([TEST_CUSTODY_WALLET_ID]);
    expect(createOrgSignerForCustodyWalletMock.mock.calls).toEqual([
      [env, TEST_ORG.id, TEST_PROJECT.id, TEST_CUSTODY_WALLET_ID, "payments.transfer_batch"],
    ]);
  });

  it("fails closed when a linked transfer belongs to a different exact wallet", async () => {
    const recipient = await seedRecipientAccount(WALLET_A);
    const created = await readBatch(await sendBatch([{ ...recipient, amount: "0.1" }]));
    const otherCustodyWalletId = "cwlt_batch_identity_mismatch";
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, label, purpose, status)
           VALUES (?, ?, 'wal_batch_identity_mismatch', ?, 'Mismatched batch wallet', 'transfer', 'active')`
        )
        .bind(otherCustodyWalletId, TEST_CONFIG_ID, WALLET_B),
      getDb(env)
        .prepare("UPDATE payment_transfers SET custody_wallet_id = ? WHERE id = ?")
        .bind(otherCustodyWalletId, required(created.transfers[0]).id),
    ]);

    const error = await readError(await getBatch(created.batch.id), 409);

    expect(error.code).toBe("CONFLICT");
    expect(error.message).toBe("Transfer batch wallet identity is inconsistent");
  });

  it("keeps exact persisted batch history readable after the wallet becomes inactive", async () => {
    const recipient = await seedRecipientAccount(WALLET_A);
    const created = await readBatch(await sendBatch([{ ...recipient, amount: "0.1" }]));
    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind(TEST_CUSTODY_WALLET_ID)
      .run();

    const response = await app.request(
      `${BATCHES_PATH}?sourceCustodyWalletId=${TEST_CUSTODY_WALLET_ID}`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );

    expect(response.status).toBe(200);
    expect(batchListSchema.parse(await response.json()).data.map((b) => b.id)).toEqual([
      created.batch.id,
    ]);
    expect((await readBatch(await getBatch(created.batch.id))).batch.id).toBe(created.batch.id);
  });

  it("persists a batch chunk's exact signed transaction before broadcasting", async () => {
    let atBroadcast: unknown;
    sendTransactionMock.mockImplementationOnce(async (_rpc, signedBytes) => {
      atBroadcast = {
        bytes: Buffer.from(signedBytes).toString("base64"),
        row: await getDb(env)
          .prepare(
            `SELECT signature, signed_transaction, last_valid_block_height,
                    submission_started_at IS NOT NULL AS submission_started
               FROM payment_transfers WHERE type = 'transfer_batch'`
          )
          .first(),
      };
      return getSignatureFromTransaction(getTransactionDecoder().decode(signedBytes));
    });
    const recipient = await seedRecipientAccount(WALLET_A);

    const created = await readBatch(await sendBatch([{ ...recipient, amount: "0.1" }]));

    const [transfer] = created.transfers;
    const [signature] = sentSignatures();
    expect(required(transfer)).toMatchObject({ status: "processing", signature });
    const { bytes } = z.object({ bytes: z.string() }).parse(atBroadcast);
    expect(atBroadcast).toEqual({
      bytes,
      row: {
        signature,
        signed_transaction: bytes,
        last_valid_block_height: "1000",
        submission_started: true,
      },
    });

    // The ledger admitted the chunk before it was sent, naming the batch and
    // each recipient it pays (APE-425). RPC accepting it is no verdict, so the
    // outcome waits for the pending-transfers job.
    const { intent, outcome } = await readChunkAudit(required(transfer).id);
    const target = z
      .object({
        action: z.string(),
        resourceId: z.string(),
        metadata: z.object({
          batchId: z.string(),
          custodyWalletId: z.string(),
          walletId: z.string(),
          sourceAddress: z.string(),
          tokenMint: z.string(),
          amount: z.string(),
          recipients: z.array(z.record(z.string(), z.unknown())),
        }),
      })
      .parse(required(intent).metadata.target);
    expect(target).toEqual({
      action: "transfer",
      resourceId: required(transfer).id,
      metadata: {
        batchId: created.batch.id,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        walletId: TEST_WALLET_ID,
        sourceAddress: source.address,
        tokenMint: SOL_MINT,
        amount: "0.1",
        recipients: [
          {
            recipientId: required(created.recipients[0]).id,
            counterpartyId: recipient.counterpartyId,
            counterpartyAccountId: recipient.counterpartyAccountId,
            destination: WALLET_A,
            amount: "0.1",
          },
        ],
      },
    });
    expect(outcome).toBeNull();
  });

  it("fails a batch chunk unsent when the audit ledger refuses its intent", async () => {
    const begin = vi
      .spyOn(AuditService.prototype, "beginCritical")
      .mockRejectedValueOnce(new Error("audit ledger unavailable"));
    onTestFinished(() => begin.mockRestore());
    const recipient = await seedRecipientAccount(WALLET_A);

    const created = await readBatch(await sendBatch([{ ...recipient, amount: "0.1" }]));

    expect(sendTransactionMock).not.toHaveBeenCalled();
    // Settled failed, not left processing: the retry route can resend the
    // recipient, and nothing unaudited can land or replay.
    expect(created.batch.status).toBe("failed");
    expect(created.recipients.map((r) => [r.status, r.error])).toEqual([
      ["failed", "audit ledger unavailable"],
    ]);
    expect(created.transfers.map((t) => [t.status, t.error])).toEqual([
      ["failed", "audit ledger unavailable"],
    ]);
    expect(await readChunkAudit(required(created.transfers[0]).id)).toEqual({
      intent: null,
      outcome: null,
    });
  });

  it("keeps a signed batch chunk processing when its first broadcast is ambiguous", async () => {
    const unresolved = recordLoggedEvents(["sdp_api_payment_submission_unresolved"]);
    sendTransactionMock.mockRejectedValueOnce(new Error("RPC response lost"));
    const recipient = await seedRecipientAccount(WALLET_B);

    const created = await readBatch(await sendBatch([{ ...recipient, amount: "0.1" }]));

    const transfer = required(created.transfers[0]);
    const [signature] = sentSignatures();
    expect(transfer).toMatchObject({ status: "processing", signature });
    expect(created.recipients.map((r) => r.status)).toEqual(["processing"]);
    expect(unresolved()).toEqual([
      [
        "warn",
        {
          event: "sdp_api_payment_submission_unresolved",
          flow: "batch",
          reason: "broadcast_error",
          organization_id: TEST_ORG.id,
          project_id: TEST_PROJECT.id,
          batch_id: created.batch.id,
          transfer_id: transfer.id,
          transfer_type: "transfer_batch",
          signature,
          recipient_indexes: [0],
          error: "RPC response lost",
        },
      ],
    ]);
    // The outcome is unknown until the chain answers.
    const audit = await readChunkAudit(transfer.id);
    expect(audit.intent).not.toBeNull();
    expect(audit.outcome).toBeNull();

    // The chain confirms, then the ledger refuses the outcome row: the settle
    // rolls back with it, leaving the chunk processing and unaudited.
    const readState = async () => ({
      transfer: required(
        await getDb(env)
          .prepare("SELECT status FROM payment_transfers WHERE id = ?")
          .bind(transfer.id)
          .first<{ status: string }>()
      ).status,
      recipients: (await readRecipientRows(created.batch.id)).map((row) => row.status),
      batch: await readBatchStatus(created.batch.id),
    });
    expect(await readState()).toEqual({
      transfer: "processing",
      recipients: ["processing"],
      batch: "processing",
    });
    settleChainVerdicts(() => CONFIRMED);
    await getDb(env)
      .prepare(
        `ALTER TABLE audit_logs ADD CONSTRAINT test_chunk_outcome_refused
           CHECK (NOT (action = 'transfer' AND resource_type = 'payment_transfer')) NOT VALID`
      )
      .run();
    try {
      await runInEachClusterScope(() => trackPendingTransfers(env));
    } finally {
      await getDb(env)
        .prepare("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS test_chunk_outcome_refused")
        .run();
    }
    expect(await readState()).toEqual({
      transfer: "processing",
      recipients: ["processing"],
      batch: "processing",
    });
    expect((await readChunkAudit(transfer.id)).outcome).toBeNull();

    // The next run settles the chunk and closes its intent together.
    await runInEachClusterScope(() => trackPendingTransfers(env));
    expect(await readState()).toEqual({
      transfer: "confirmed",
      recipients: ["confirmed"],
      batch: "confirmed",
    });
    await expectChunkOutcome(transfer, { status: "success", batchTransferStatus: "confirmed" });
  });

  it("fails a signed batch chunk when first-attempt preflight rejects it", async () => {
    sendTransactionMock.mockRejectedValueOnce(sendTransactionPreflightError());
    const recipient = await seedRecipientAccount(WALLET_B);

    const created = await readBatch(await sendBatch([{ ...recipient, amount: "0.1" }]));

    expect(created.batch.status).toBe("failed");
    expect(created.recipients.map((r) => r.status)).toEqual(["failed"]);
    const transfer = required(created.transfers[0]);
    expect(transfer.status).toBe("failed");
    expect(transfer.signature).toBe(required(sentSignatures()[0]));
    const { intent, outcome } = await readChunkAudit(transfer.id);
    expect(required(outcome).status).toBe("failure");
    expect(required(outcome).metadata.auditIntentId).toBe(required(intent).resource_id);
  });

  describe("a source wallet short of funds (HOO-2621)", () => {
    async function sendShortfallBatch() {
      const recipient = await seedRecipientAccount(WALLET_B);
      return readBatch(await sendBatch([{ ...recipient, amount: "500" }]));
    }

    function expectShortfallRecorded(body: BatchResponse) {
      expect(body.batch.status).toBe("failed");
      expect(body.recipients.map((r) => [r.status, r.error])).toEqual([
        ["failed", INSUFFICIENT_FUNDS_MESSAGE],
      ]);
      expect(body.transfers.map((t) => [t.status, t.error])).toEqual([
        ["failed", INSUFFICIENT_FUNDS_MESSAGE],
      ]);
    }

    it("fails a chunk the sponsor's simulation finds short with the tenant-safe reason", async () => {
      const signAsFeePayer = vi.fn(async (_transaction: Uint8Array): Promise<Uint8Array> => {
        throw new FeePaymentError(
          "Failed to sign transaction as fee payer: Kora Error -32000: Invalid transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1",
          "PROVIDER_REJECTED"
        );
      });
      createKoraAdapterMock.mockReturnValueOnce(sponsorAdapter(signAsFeePayer));

      const body = await sendShortfallBatch();

      expect(signAsFeePayer).toHaveBeenCalledOnce();
      expect(sendTransactionMock).not.toHaveBeenCalled();
      expectShortfallRecorded(body);
    });

    it("fails a chunk SDP's simulation finds short with the same reason, before the sponsor signs or anything is sent", async () => {
      const signAsFeePayer = vi.fn(fullySignTestTransaction);
      createKoraAdapterMock.mockReturnValueOnce(sponsorAdapter(signAsFeePayer));
      // Answered at the JSON-RPC layer so the real helper serializes the verdict.
      rpc.answer("simulateTransaction", {
        context: { slot: 1 },
        value: {
          err: { InstructionError: [0, { Custom: 1 }] },
          logs: ["Program 11111111111111111111111111111111 failed: custom program error: 0x1"],
          accounts: null,
          unitsConsumed: 150,
          returnData: null,
        },
      });

      const body = await sendShortfallBatch();

      expect(signAsFeePayer).not.toHaveBeenCalled();
      expect(sendTransactionMock).not.toHaveBeenCalled();
      expectShortfallRecorded(body);
    });
  });

  it("admits runtime execution only for new transfer batches", async () => {
    const recipient = await seedRecipientAccount(WALLET_A);
    const recipients = [{ ...recipient, amount: "0.1" }];
    const first = await readBatch(
      await sendBatch(recipients, { key: "runtime-admission-batch-replay" })
    );
    const admission = vi.spyOn(SigningService.prototype, "admitRuntimeExecution").mockRejectedValue(
      new AppError("CONFLICT", "Custody wallet is unavailable", {
        reason: "runtime_execution_unavailable",
      })
    );
    onTestFinished(() => admission.mockRestore());

    const replay = await sendBatch(recipients, { key: "runtime-admission-batch-replay" });
    // A new payout run: new work, which admission refuses.
    const fresh = await sendBatch(recipients, {
      body: { externalId: `${testRunId()}-fresh` },
    });

    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await readBatch(replay)).toEqual(first);
    const error = await readError(fresh, 409);
    expect(error.details).toEqual({ reason: "runtime_execution_unavailable" });
    expect(admission).toHaveBeenCalledOnce();
    expect(await countBatches()).toBe(1);
  });

  it("replays a completed transfer batch after its exact wallet is deactivated", async () => {
    const recipient = await seedRecipientAccount(WALLET_A);
    const recipients = [{ ...recipient, amount: "0.1" }];
    const first = await readBatch(
      await sendBatch(recipients, { key: "deactivated-wallet-batch-replay" })
    );
    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind(TEST_CUSTODY_WALLET_ID)
      .run();
    createOrgSignerForCustodyWalletMock.mockClear();

    const replay = await sendBatch(recipients, { key: "deactivated-wallet-batch-replay" });

    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await readBatch(replay)).toEqual(first);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
  });

  // HOO-1918: once the shared key record is gone (24h, or a 5xx freed it), the
  // batch row is the backstop, and it too ignores recipient order. A row saved
  // before the execute step was split out answers under either token form it had.
  it.each(["current", "previous operation", "previous operation and token form"] as const)(
    "replays a reordered same-key batch from its row (%s)",
    async (savedForm) => {
      const [first, second] = await seedRecipientAccounts([WALLET_A, WALLET_B]);
      const paidFirst = { ...required(first), amount: "0.1" };
      const paidSecond = { ...required(second), amount: "0.2" };
      const original = await readBatch(
        await sendBatch([paidFirst, paidSecond], { key: "batch-reordered-key" })
      );
      if (savedForm !== "current") {
        const canonicalize =
          savedForm === "previous operation"
            ? canonicalizeTransferBatchBody
            : previousCanonicalTransferBatchBody;
        const fingerprint = requestFingerprint({
          operation: "POST /v1/payments/transfer-batches",
          params: {},
          query: {},
          body: canonicalize(
            createTransferBatchSchema.parse({
              externalId: testRunId(),
              sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
              token: "SOL",
              recipients: [paidFirst, paidSecond],
            })
          ),
        });
        await getDb(env).execute(
          "UPDATE payment_transfer_batches SET idempotency_fingerprint = ? WHERE id = ?",
          [fingerprint, original.batch.id]
        );
      }
      await getDb(env).execute("DELETE FROM idempotency_keys");
      sendTransactionMock.mockClear();

      const reordered = await sendBatch([paidSecond, paidFirst], { key: "batch-reordered-key" });

      expect(reordered.headers.get("Idempotent-Replayed")).toBe("true");
      expect((await readBatch(reordered)).batch).toEqual(original.batch);

      await getDb(env).execute("DELETE FROM idempotency_keys");
      const changed = await sendBatch([{ ...paidFirst, amount: "0.3" }, paidSecond], {
        key: "batch-reordered-key",
      });

      expect((await readError(changed, 409)).code).toBe("TRANSFER_BATCH_RUN_EXISTS");
      expect(sendTransactionMock).not.toHaveBeenCalled();
      expect(await countBatches()).toBe(1);
    }
  );

  it("settles a stranded batch with no client retry from the pending-transfers job", async () => {
    const recipient = await seedRecipientAccount(WALLET_A);
    const created = await readBatch(await sendBatch([{ ...recipient, amount: "0.1" }]));
    // The state a crash right after the batch commit leaves, two hours ago:
    // the recipient pending and unlinked, no chunk transfer, the batch processing.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await getDb(env)
      .prepare(
        "UPDATE payment_transfer_recipients SET transfer_id = NULL, status = 'pending', error = NULL, updated_at = ? WHERE batch_id = ?"
      )
      .bind(twoHoursAgo, created.batch.id)
      .run();
    await getDb(env)
      .prepare(
        "UPDATE payment_transfer_batches SET status = 'processing', created_at = ? WHERE id = ?"
      )
      .bind(twoHoursAgo, created.batch.id)
      .run();

    await runInEachClusterScope(() => trackPendingTransfers(env));

    expect(await readBatchStatus(created.batch.id)).toBe("failed");
    expect(
      (await readRecipientRows(created.batch.id)).map((row) => [row.status, row.error])
    ).toEqual([["failed", "The batch request ended before this recipient's transfer was sent"]]);
  });

  // HOO-1918: the row replay works from the request's own identifiers, so an
  // account archived since never refuses a request that ran.
  it("answers a retry from the batch row after a recipient's account is archived", async () => {
    const recipient = await seedRecipientAccount(WALLET_A);
    const recipients = [{ ...recipient, amount: "0.1" }];
    const original = await readBatch(await sendBatch(recipients, { key: "batch-archived-key" }));
    await getDb(env).execute("DELETE FROM idempotency_keys");
    await getDb(env).execute("UPDATE counterparty_accounts SET status = 'archived' WHERE id = ?", [
      recipient.counterpartyAccountId,
    ]);
    sendTransactionMock.mockClear();

    const retry = await sendBatch(recipients, { key: "batch-archived-key" });

    expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await readBatch(retry)).batch.id).toBe(original.batch.id);
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });

  it("replays the original transfer batch for the same idempotency key and payload", async () => {
    const recipient = await seedRecipientAccount(WALLET_A);
    const recipients = [{ ...recipient, amount: "0.1" }];
    const first = await readBatch(await sendBatch(recipients, { key: "batch-replay-key" }));

    const second = await sendBatch(recipients, { key: "batch-replay-key" });

    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await readBatch(second)).toEqual(first);
    expect(createOrgSignerForCustodyWalletMock).toHaveBeenCalledOnce();
    expect(sendTransactionMock).toHaveBeenCalledOnce();
    expect(await countBatches()).toBe(1);
  });

  it("rejects an idempotency key reused with a different transfer batch payload", async () => {
    const recipient = await seedRecipientAccount(WALLET_A);
    await readBatch(await sendBatch([{ ...recipient, amount: "0.1" }], { key: "batch-conflict" }));

    const conflict = await sendBatch([{ ...recipient, amount: "0.2" }], { key: "batch-conflict" });

    expect((await readError(conflict, 422)).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(createOrgSignerForCustodyWalletMock).toHaveBeenCalledOnce();
    expect(sendTransactionMock).toHaveBeenCalledOnce();
    expect(await countBatches()).toBe(1);
  });

  it("answers a concurrent duplicate 409 while the first batch holds its key", async () => {
    const signing = deferred<void>();
    const signerGate = deferred<void>();
    createOrgSignerForCustodyWalletMock.mockImplementation(async () => {
      signing.resolve();
      await signerGate.promise;
      return source;
    });
    const recipients = [{ ...(await seedRecipientAccount(WALLET_A)), amount: "0.1" }];

    const first = sendBatch(recipients, { key: "batch-race-key" });
    await signing.promise;
    // The shared Idempotency-Key step (HOO-1918) holds the key for the first
    // request, so the duplicate never reaches the batch row's own race.
    const duplicate = await sendBatch(recipients, { key: "batch-race-key" });
    signerGate.resolve();

    expect(Number(duplicate.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect((await readError(duplicate, 409)).code).toBe("IDEMPOTENCY_KEY_IN_FLIGHT");
    expect((await first).status).toBe(200);
    expect(createOrgSignerForCustodyWalletMock).toHaveBeenCalledOnce();
    expect(sendTransactionMock).toHaveBeenCalledOnce();
    expect(await countBatches()).toBe(1);
  });

  it("pays a new payout run of the same recipients as its own batch", async () => {
    const recipients = [{ ...(await seedRecipientAccount(WALLET_A)), amount: "0.1" }];

    const first = await readBatch(
      await sendBatch(recipients, { body: { externalId: `${testRunId()}-first` } })
    );
    const second = await readBatch(
      await sendBatch(recipients, { body: { externalId: `${testRunId()}-second` } })
    );

    expect(second.batch.id).not.toBe(first.batch.id);
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
    expect(await countBatches()).toBe(2);
  });

  describe("batch externalId (HOO-2335)", () => {
    /** What each test's first send pays, from which key; a test that sends otherwise says so. */
    const ORIGINAL = { amount: "0.1", apiKey: TEST_API_KEY.raw };

    async function seedOneRecipientRun(externalId: string) {
      const recipient = await seedRecipientAccount(WALLET_A);
      return (key: string, { amount, apiKey }: { amount: string; apiKey: string }) =>
        sendBatch([{ ...recipient, amount }], { key, apiKey, body: { externalId } });
    }

    function insertRunRow(externalId: string) {
      return batchesRepositoryPostgres
        .createPostgresPaymentTransferBatchesRepository(getDb(env))
        .createTransferBatchWithRecipients({
          batch: {
            organizationId: TEST_ORG.id,
            projectId: TEST_PROJECT.id,
            externalId,
            sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            sourceWalletId: TEST_WALLET_ID,
            sourceAddress: source.address,
            token: "SOL",
            status: "processing",
            totalAmount: "0.1",
            recipientCount: 0,
            transactionCount: 0,
            initiatedByKeyId: null,
            idempotencyKey: deriveProviderRequestId(
              ["transfer_batch_run", TEST_ORG.id, TEST_PROJECT.id, TEST_CUSTODY_WALLET_ID],
              externalId
            ),
            idempotencyFingerprint: "another-request-fingerprint",
          },
          recipients: [],
        });
    }

    function expectNothingSigned() {
      // Answered before any chain read, signer or broadcast.
      expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
      expect(getRecentBlockhashMock).not.toHaveBeenCalled();
      expect(sendTransactionMock).not.toHaveBeenCalled();
    }

    it("answers the same batch resent under a new key with the original, paying no one again", async () => {
      const send = await seedOneRecipientRun("payroll_resent");
      const first = await readBatch(await send("batch-external-id-first", ORIGINAL));
      vi.clearAllMocks();

      const resend = await send("batch-external-id-resend", ORIGINAL);

      expect(resend.headers.get("Idempotent-Replayed")).toBe("true");
      expect(await readBatch(resend)).toEqual(first);
      expectNothingSigned();
      expect(await countBatches()).toBe(1);
    });

    it("answers a resent run even after its wallet stops admitting new work", async () => {
      const send = await seedOneRecipientRun("payroll_wallet_down");
      const first = await readBatch(await send("batch-external-id-before-outage", ORIGINAL));
      vi.clearAllMocks();
      const admission = vi
        .spyOn(SigningService.prototype, "admitRuntimeExecution")
        .mockRejectedValue(
          new AppError("CONFLICT", "Custody wallet is unavailable", {
            reason: "runtime_execution_unavailable",
          })
        );
      onTestFinished(() => admission.mockRestore());

      const resend = await send("batch-external-id-during-outage", ORIGINAL);

      expect((await readBatch(resend)).batch.id).toBe(first.batch.id);
      expect(admission).not.toHaveBeenCalled();
      expectNothingSigned();
    });

    it("refuses a different batch reusing an externalId with the existing batch, signing nothing", async () => {
      const send = await seedOneRecipientRun("payroll_reused");
      const first = await readBatch(await send("batch-external-id-original", ORIGINAL));
      vi.clearAllMocks();

      const changed = await send("batch-external-id-changed", { ...ORIGINAL, amount: "0.2" });

      const error = await readError(changed, 409);
      expect(error.code).toBe("TRANSFER_BATCH_RUN_EXISTS");
      expect(error.details).toEqual({ batchId: first.batch.id, externalId: "payroll_reused" });
      expectNothingSigned();
      expect(await countBatches()).toBe(1);

      // The refusal is not stored: the key still sends the run's own body.
      const again = await send("batch-external-id-changed", ORIGINAL);
      expect((await readBatch(again)).batch.id).toBe(first.batch.id);
    });

    it("refuses the same batch from another credential instead of replaying it", async () => {
      const send = await seedOneRecipientRun("payroll_other_key");
      const otherKey = "sk_test_batch_payments_other";
      const first = await readBatch(await send("batch-external-id-own-key", ORIGINAL));
      await seedApiKeyRow(env, await hashString(otherKey, env.API_KEY_PEPPER), {
        id: "key_batch_payments_other",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        grants: ALL_API_KEY_GRANTS,
        environment: "sandbox",
        rateLimitTier: "standard",
        allowedIps: null,
        status: "active",
        expiresAt: null,
      });
      vi.clearAllMocks();

      const other = await send("batch-external-id-other-key", { ...ORIGINAL, apiKey: otherKey });

      const error = await readError(other, 409);
      expect(error.code).toBe("TRANSFER_BATCH_RUN_EXISTS");
      expect(error.details).toEqual({ batchId: first.batch.id, externalId: "payroll_other_key" });
      expectNothingSigned();
      expect(await countBatches()).toBe(1);
    });

    it("refuses a run another request records after the early check, sending nothing", async () => {
      const send = await seedOneRecipientRun("payroll_raced");
      let racer: { id: string } | undefined;
      // The other request commits the run between this request's check and its insert.
      createOrgSignerForCustodyWalletMock.mockImplementation(async () => {
        racer = (await insertRunRow("payroll_raced")).batch;
        return source;
      });

      const error = await readError(await send("batch-external-id-raced", ORIGINAL), 409);

      expect(error.code).toBe("TRANSFER_BATCH_RUN_EXISTS");
      expect(error.details).toEqual({ batchId: required(racer).id, externalId: "payroll_raced" });
      expect(sendTransactionMock).not.toHaveBeenCalled();
      expect(await countBatches()).toBe(1);
    });

    it("answers the same run sent concurrently under another key as a replay of the winner", async () => {
      const send = await seedOneRecipientRun("payroll_twin");
      let winner: Response | undefined;
      // The same request under another key commits the run between this one's check and its insert.
      createOrgSignerForCustodyWalletMock.mockImplementation(async () => {
        if (winner === undefined) {
          createOrgSignerForCustodyWalletMock.mockResolvedValue(source);
          winner = await send("batch-external-id-twin-winner", ORIGINAL);
        }
        return source;
      });

      const loser = await send("batch-external-id-twin-loser", ORIGINAL);

      expect(loser.headers.get("Idempotent-Replayed")).toBe("true");
      expect((await readBatch(loser)).batch.id).toBe((await readBatch(required(winner))).batch.id);
      expect(sendTransactionMock).toHaveBeenCalledOnce();
      expect(await countBatches()).toBe(1);
    });

    it("settles a crashed run on a resend under a new key once the chain passes its attempt", async () => {
      const send = await seedOneRecipientRun("payroll_crash");
      const first = await readBatch(await send("batch-external-id-crash-first", ORIGINAL));
      // The state a crash right after the batch commit leaves: the recipient
      // pending and unlinked, written by an attempt valid to block 100.
      await getDb(env)
        .prepare(
          `UPDATE payment_transfer_recipients
              SET status = 'pending', transfer_id = NULL, error = NULL,
                  attempt_last_valid_block_height = 100
            WHERE batch_id = ?`
        )
        .bind(first.batch.id)
        .run();
      await getDb(env)
        .prepare("UPDATE payment_transfer_batches SET status = 'processing' WHERE id = ?")
        .bind(first.batch.id)
        .run();
      vi.clearAllMocks();

      // The attempt could still land: the resend answers the batch as it stands.
      rpc.answer("getBlockHeight", 100);
      const early = await readBatch(await send("batch-external-id-crash-early", ORIGINAL));
      expect(early.batch).toMatchObject({ id: first.batch.id, status: "processing" });
      expect(early.recipients.map((r) => r.status)).toEqual(["pending"]);

      // Past it: nothing that attempt built can land, so the recipient fails.
      rpc.answer("getBlockHeight", 101);
      const late = await readBatch(await send("batch-external-id-crash-late", ORIGINAL));
      expect(late.batch).toMatchObject({ id: first.batch.id, status: "failed" });
      expect(late.recipients.map((r) => [r.status, r.error])).toEqual([
        ["failed", "The batch request ended before this recipient's transfer was sent"],
      ]);
      expect(sendTransactionMock).not.toHaveBeenCalled();
    });
  });

  describe("retry failed recipients (HOO-2343)", () => {
    /** Two full chunks; the first chunk sent is rejected, so its recipients never land. */
    async function seedPartiallyFailedBatch(run = "") {
      sendTransactionMock.mockRejectedValueOnce(sendTransactionPreflightError());
      const recipients = await seedTwoChunkRecipients();
      const body = await readBatch(
        await sendBatch(recipients, { body: { externalId: `${testRunId()}${run}` } })
      );
      // The chunk that was sent settles later, so the batch is still processing.
      expect(body.batch.status).toBe("processing");
      const failedIds = body.recipients.filter((r) => r.status === "failed").map((r) => r.id);
      expect(failedIds).toHaveLength(MAX_RECIPIENTS_PER_TRANSACTION);
      const failed = required(body.recipients.find((r) => r.status === "failed"));
      const sent = required(body.recipients.find((r) => r.status === "processing"));
      return { batch: body.batch, failed, failedIds, sent };
    }

    const retry = (batchId: string, idempotencyKey: string = crypto.randomUUID()) =>
      app.request(
        `${BATCHES_PATH}/${batchId}/retry`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": idempotencyKey,
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

    async function readRecipientStatus(recipientId: string) {
      const row = await batchesRepositoryPostgres
        .createPostgresPaymentTransferBatchesRepository(getDb(env))
        .getTransferRecipientById({
          recipientId,
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT.id,
        });
      return required(row).status;
    }

    function claimFor(
      batchId: string,
      recipientIds: string[],
      attemptLastValidBlockHeight: bigint,
      recordKey: string
    ) {
      return batchesRepositoryPostgres
        .createPostgresPaymentTransferBatchesRepository(getDb(env))
        .claimFailedTransferRecipients({
          batchId,
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT.id,
          recipientIds,
          addedTransactionCount: 1,
          attemptLastValidBlockHeight,
          attemptId: crypto.randomUUID(),
          retry: {
            idempotencyKey: recordKey,
            idempotencyFingerprint: `${recordKey}-fingerprint`,
            initiatedByKeyId: null,
          },
        });
    }

    it("resends only the failed recipients of a partially failed batch", async () => {
      const { batch, failed, failedIds, sent } = await seedPartiallyFailedBatch();
      const firstTransferIds = (await readBatch(await getBatch(batch.id))).transfers.map(
        (t) => t.id
      );
      vi.clearAllMocks();

      const body = await readBatch(await retry(batch.id));

      expect(sendTransactionMock).toHaveBeenCalledOnce();
      const resent = body.recipients.filter((r) => failedIds.includes(r.id));
      expect(resent.map((r) => r.status)).toEqual(fullChunkOf("processing"));
      const resendTransferId = required(resent[0]).transferId;
      expect(resent.map((r) => r.transferId)).toEqual(fullChunkOf(resendTransferId));
      expect(resendTransferId).not.toBe(failed.transferId);
      // The recipient that was sent keeps its transfer and is not sent again.
      expect(body.recipients.find((r) => r.id === sent.id)).toEqual(sent);
      expect(body.batch).toMatchObject({ status: "processing", transactionCount: 3 });
      // The failed chunk stays in the batch's history beside the resend.
      expect(body.transfers.map((t) => t.id).sort()).toEqual(
        [...firstTransferIds, required(resendTransferId)].sort()
      );
      expect((await readBatch(await getBatch(batch.id))).transfers.map((t) => t.id).sort()).toEqual(
        body.transfers.map((t) => t.id).sort()
      );
    });

    it("refuses a stopped project's retry before claiming, then sends under the same key", async () => {
      const { batch, failed } = await seedPartiallyFailedBatch();
      vi.clearAllMocks();
      await setDisabledMovements(getDb(env), TEST_PROJECT.id, ["payments.transfer_batch"]);

      const error = await readError(await retry(batch.id, "stopped-project-retry"), 403);
      expect(error.details).toEqual({ reason: "movement_disabled" });
      expect(sendTransactionMock).not.toHaveBeenCalled();
      expect(await readRecipientStatus(failed.id)).toBe("failed");

      await setDisabledMovements(getDb(env), TEST_PROJECT.id, []);
      const resumed = await retry(batch.id, "stopped-project-retry");
      expect(resumed.status).toBe(200);
      expect(resumed.headers.get("Idempotent-Replayed")).toBeNull();
      expect(sendTransactionMock).toHaveBeenCalledOnce();
    });

    it("replays a same-key retry without sending again", async () => {
      const { batch } = await seedPartiallyFailedBatch();
      vi.clearAllMocks();
      const key = crypto.randomUUID();

      const first = await readBatch(await retry(batch.id, key));
      const again = await retry(batch.id, key);

      expect(again.headers.get("Idempotent-Replayed")).toBe("true");
      expect(await readBatch(again)).toEqual(first);
      expect(sendTransactionMock).toHaveBeenCalledOnce();
    });

    it("answers a rerun of a retry from its recorded row once the key's record is gone", async () => {
      const { batch, failedIds } = await seedPartiallyFailedBatch();
      vi.clearAllMocks();
      const key = crypto.randomUUID();
      await readBatch(await retry(batch.id, key));
      // The key's stored answer is gone (expired, or lost to a crash before it was stored).
      await getDb(env).execute("DELETE FROM idempotency_keys");
      vi.clearAllMocks();

      const rerun = await retry(batch.id, key);

      expect(rerun.headers.get("Idempotent-Replayed")).toBe("true");
      const body = await readBatch(rerun);
      expect(body.recipients.filter((r) => failedIds.includes(r.id)).map((r) => r.status)).toEqual(
        fullChunkOf("processing")
      );
      expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
      expect(sendTransactionMock).not.toHaveBeenCalled();
    });

    it("answers a key reused on another batch's retry by that batch, never the first", async () => {
      const first = await seedPartiallyFailedBatch();
      const second = await seedPartiallyFailedBatch("-second");
      vi.clearAllMocks();
      const key = crypto.randomUUID();
      await readBatch(await retry(first.batch.id, key));

      // While the key's record lives, the key layer refuses it on another batch.
      const reused = await retry(second.batch.id, key);
      expect((await readError(reused, 422)).code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(sendTransactionMock).toHaveBeenCalledOnce();

      // Once it is gone, the first batch's retry row is not the second's answer:
      // the key is a new retry of the second batch.
      await getDb(env).execute("DELETE FROM idempotency_keys");
      const resent = await retry(second.batch.id, key);
      expect(resent.headers.get("Idempotent-Replayed")).toBeNull();
      const body = await readBatch(resent);
      expect(sendTransactionMock).toHaveBeenCalledTimes(2);
      expect(body.batch.id).toBe(second.batch.id);
      expect(required(body.recipients.find((r) => r.id === second.failed.id)).status).toBe(
        "processing"
      );
    });

    it("fails a crashed retry's unsent recipients on a same-key rerun, so they can be retried", async () => {
      const { batch, failed, sent } = await seedPartiallyFailedBatch();
      vi.clearAllMocks();
      const key = crypto.randomUUID();
      await readBatch(await retry(batch.id, key));
      // The state a crash right after the claim leaves: the claimed recipient
      // pending and unlinked, written in the retry row's transaction.
      await getDb(env)
        .prepare(
          `UPDATE payment_transfer_recipients r
              SET status = 'pending', transfer_id = NULL, error = NULL,
                  updated_at = (SELECT created_at FROM payment_transfer_batch_retries WHERE batch_id = r.batch_id)
            WHERE id = ?`
        )
        .bind(failed.id)
        .run();
      // Another request (the create) still sending a different recipient.
      await getDb(env)
        .prepare(
          "UPDATE payment_transfer_recipients SET status = 'pending', transfer_id = NULL, updated_at = ? WHERE id = ?"
        )
        .bind(new Date(Date.now() - 60 * 60 * 1000).toISOString(), sent.id)
        .run();
      await getDb(env)
        .prepare("UPDATE payment_transfer_batches SET status = 'processing' WHERE id = ?")
        .bind(batch.id)
        .run();
      await getDb(env).execute("DELETE FROM idempotency_keys");
      vi.clearAllMocks();

      const body = await readBatch(await retry(batch.id, key));

      expect(required(body.recipients.find((r) => r.id === failed.id))).toMatchObject({
        status: "failed",
        error: "The retry request ended before this recipient's transfer was sent",
      });
      // Not this retry's: left to the request that is sending it.
      expect(required(body.recipients.find((r) => r.id === sent.id)).status).toBe("pending");
      expect(sendTransactionMock).not.toHaveBeenCalled();
      // Failed again, so a new retry can send it.
      expect((await retry(batch.id)).status).toBe(200);
      expect(sendTransactionMock).toHaveBeenCalledOnce();
    });

    it("refuses a retry that would pay an unfunded address less than the rent minimum, sending nothing", async () => {
      const { batch, failed } = await seedPartiallyFailedBatch();
      // The failed recipient was paid too little for an address with no account.
      await getDb(env)
        .prepare("UPDATE payment_transfer_recipients SET amount = '0.0001' WHERE id = ?")
        .bind(failed.id)
        .run();
      getMultipleAccountsLamportsMock.mockImplementation(async (_rpc, addresses) =>
        addresses.map(() => 0n)
      );
      vi.clearAllMocks();

      const error = await readError(await retry(batch.id), 409);

      expect(error.code).toBe("AMOUNT_BELOW_RENT_MINIMUM");
      expect(sendTransactionMock).not.toHaveBeenCalled();
      // Not claimed: it stays failed, for a new batch with a larger amount.
      expect(await readRecipientStatus(failed.id)).toBe("failed");
    });

    it("refuses a retry whose recipient's account changed address, signing nothing", async () => {
      const { batch, failed, failedIds } = await seedPartiallyFailedBatch();
      await getDb(env)
        .prepare(
          `UPDATE counterparty_accounts
              SET details = jsonb_set(details, '{address}', to_jsonb(?::text))
            WHERE id = (SELECT counterparty_account_id FROM payment_transfer_recipients WHERE id = ?)`
        )
        .bind(TEST_SOLANA_ADDRESSES.wallet1, failed.id)
        .run();
      vi.clearAllMocks();

      const error = await readError(await retry(batch.id), 409);

      expect(error.code).toBe("TRANSFER_BATCH_DESTINATION_CHANGED");
      const details = z
        .object({ batchId: z.string(), recipientIds: z.array(z.string()) })
        .parse(error.details);
      expect(details.batchId).toBe(batch.id);
      expect([...details.recipientIds].sort()).toEqual([...failedIds].sort());
      expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
      expect(sendTransactionMock).not.toHaveBeenCalled();
      expect(await readRecipientStatus(failed.id)).toBe("failed");
    });

    it("fails an unsent recipient from the stranded-batch job once the chain passes its attempt", async () => {
      const { batch, failed } = await seedPartiallyFailedBatch();
      // A retry claimed the recipient moments ago, valid to block 500, then died.
      await claimFor(batch.id, [failed.id], 500n, "dead-retry-record-key");

      rpc.answer("getBlockHeight", 500);
      await runInEachClusterScope(() => trackPendingTransfers(env));
      expect(await readRecipientStatus(failed.id)).toBe("pending");

      rpc.answer("getBlockHeight", 501);
      await runInEachClusterScope(() => trackPendingTransfers(env));
      expect(await readRecipientStatus(failed.id)).toBe("failed");
    });

    it("leaves a retry's just-claimed recipients of an old batch to the retry", async () => {
      const { batch, failed } = await seedPartiallyFailedBatch();
      // A live retry has claimed the recipient and not linked it yet.
      await claimFor(batch.id, [failed.id], 1_000n, "live-retry-record-key");
      // The batch itself is hours old.
      await getDb(env)
        .prepare("UPDATE payment_transfer_batches SET created_at = ? WHERE id = ?")
        .bind(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), batch.id)
        .run();

      await runInEachClusterScope(() => trackPendingTransfers(env));

      const recipient = await batchesRepositoryPostgres
        .createPostgresPaymentTransferBatchesRepository(getDb(env))
        .getTransferRecipientById({
          recipientId: failed.id,
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT.id,
        });
      expect(recipient).toMatchObject({ status: "pending", transfer_id: null });
    });

    it("refuses a retry with no failed recipients and sends nothing", async () => {
      const { batch } = await seedPartiallyFailedBatch();
      await readBatch(await retry(batch.id));
      vi.clearAllMocks();

      const error = await readError(await retry(batch.id), 409);

      expect(error.code).toBe("TRANSFER_BATCH_NOTHING_TO_RETRY");
      expect(error.details).toEqual({ batchId: batch.id, status: "processing" });
      expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
      expect(sendTransactionMock).not.toHaveBeenCalled();
    });

    it("refuses a retry whose failed recipients another retry claimed first, sending nothing", async () => {
      const { batch, failed } = await seedPartiallyFailedBatch();
      vi.clearAllMocks();
      // The other retry claims between this one's read and its claim.
      createOrgSignerForCustodyWalletMock.mockImplementation(async () => {
        await claimFor(batch.id, [failed.id], 1_000n, "another-retry-record-key");
        return source;
      });

      const error = await readError(await retry(batch.id), 409);

      expect(error.code).toBe("TRANSFER_BATCH_RETRY_CLAIMED");
      expect(error.details).toEqual({ batchId: batch.id });
      expect(sendTransactionMock).not.toHaveBeenCalled();
    });

    it("refuses a retry from a wallet outside the key's scope before writing anything", async () => {
      const { batch, failed } = await seedPartiallyFailedBatch();
      vi.clearAllMocks();
      await seedSelectedApiKeyWallets([]);

      const error = await readError(await retry(batch.id), 403);

      expect(error.details).toEqual({ reason: "wallet_out_of_scope" });
      expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
      expect(await readRecipientStatus(failed.id)).toBe("failed");
    });

    it("keeps a batch unreadable and unretryable from another project", async () => {
      const { batch, failed } = await seedPartiallyFailedBatch();
      await rehomeTestApiKeyToProduction();
      vi.clearAllMocks();

      const list = await app.request(
        BATCHES_PATH,
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );
      expect(list.status).toBe(200);
      expect(batchListSchema.parse(await list.json()).data).toEqual([]);
      expect((await readError(await getBatch(batch.id), 404)).code).toBe("NOT_FOUND");
      expect((await readError(await retry(batch.id), 404)).code).toBe("NOT_FOUND");
      expect(sendTransactionMock).not.toHaveBeenCalled();
      expect(await readRecipientStatus(failed.id)).toBe("failed");
    });
  });

  it("pays a well-known symbol as the cluster's mint and settles the batch confirmed", async () => {
    answerSourceTokenAccount(DEVNET_USDC_MINT);
    const recipient = await seedRecipientAccount(WALLET_A);

    const created = await readBatch(
      await sendBatch([{ ...recipient, amount: "1.25" }], { body: { token: "USDC" } })
    );

    expect(created.batch).toMatchObject({
      status: "processing",
      token: DEVNET_USDC_MINT,
      totalAmount: "1.25",
    });
    expect(created.recipients.map((r) => [r.destination, r.amount, r.status])).toEqual([
      [WALLET_A, "1.25", "processing"],
    ]);
    expect(created.transfers.map((t) => [t.token, t.amount, t.signature])).toEqual([
      [DEVNET_USDC_MINT, "1.25", required(sentSignatures()[0])],
    ]);

    settleChainVerdicts(() => CONFIRMED);
    await runInEachClusterScope(() => trackPendingTransfers(env));

    expect(await readBatchStatus(created.batch.id)).toBe("confirmed");
    expect((await readRecipientRows(created.batch.id)).map((row) => row.status)).toEqual([
      "confirmed",
    ]);
  });

  it("refuses a scaled UI mint before storing or signing a batch", async () => {
    const mint = syntheticAddress(22);
    readMintFromCluster(mint, {
      mints: new Map([
        [
          mint,
          {
            decimals: 6,
            extensions: [
              scaledUiAmountConfig({
                multiplier: 2,
                newMultiplier: 4,
                newMultiplierEffectiveTimestamp: 1_800_000_000n,
              }),
            ],
          },
        ],
      ]),
      clockUnixTimestamp: 1_750_000_000n,
    });
    const recipient = await seedRecipientAccount(WALLET_A);

    const error = await readError(
      await sendBatch([{ ...recipient, amount: "0.000001" }], { body: { token: mint } }),
      400
    );

    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toBe("Payments do not support the ScaledUiAmountConfig mint extension");
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(await countBatches()).toBe(0);
  });

  it("moves exact base units on a plain Token-2022 mint", async () => {
    const mint = syntheticAddress(21);
    readMintFromCluster(mint, {
      mints: new Map([[mint, { decimals: 6, extensions: null }]]),
      clockUnixTimestamp: 1_750_000_000n,
    });
    respondTokenAccounts(rpc, { tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    const [first, second] = await seedRecipientAccounts([WALLET_A, WALLET_B]);

    const created = await readBatch(
      await sendBatch(
        [
          { ...required(first), amount: "10" },
          { ...required(second), amount: "2.5" },
        ],
        { body: { token: mint } }
      )
    );

    const [, transactionBytes] = required(sendTransactionMock.mock.calls[0]);
    const message = getCompiledTransactionMessageDecoder().decode(
      getTransactionDecoder().decode(transactionBytes).messageBytes
    );
    assert(message.version === 0);
    const transferCheckedAmounts = message.instructions.flatMap((instruction) =>
      message.staticAccounts[instruction.programAddressIndex] === TOKEN_2022_PROGRAM_ADDRESS &&
      instruction.data !== undefined &&
      instruction.data[0] === TRANSFER_CHECKED_DISCRIMINATOR
        ? [getTransferCheckedInstructionDataDecoder().decode(instruction.data).amount]
        : []
    );
    expect(transferCheckedAmounts).toEqual([10_000_000n, 2_500_000n]);
    expect(created.batch.totalAmount).toBe("12.5");
    expect(created.recipients.map((r) => [r.destination, r.amount]).sort()).toEqual(
      [
        [WALLET_A, "10"],
        [WALLET_B, "2.5"],
      ].sort()
    );
  });

  it("builds a Production project's USDC batch on mainnet-beta with the mainnet mint", async () => {
    await seedProductionPrivyWallet({
      custodyWalletId: "cwlt_batch_production",
      publicKey: source.address,
    });
    await enableMainnetSponsorship();
    answerSourceTokenAccount(MAINNET_USDC_MINT);
    const [recipient] = await seedRecipientAccounts([WALLET_A], TEST_PRODUCTION_PROJECT_ID);

    const created = await readBatch(
      await sendBatch([{ ...required(recipient), amount: "1.25" }], {
        body: { sourceCustodyWalletId: "cwlt_batch_production", token: "USDC" },
      })
    );

    expect(rpc.calls).toContainEqual({
      cluster: "mainnet-beta",
      method: "getTokenAccountsByOwner",
    });
    expect(rpc.calls.filter((call) => call.cluster !== "mainnet-beta")).toEqual([]);
    expect(created.batch.token).toBe(MAINNET_USDC_MINT);
    expect(created.transfers.map((t) => t.token)).toEqual([MAINNET_USDC_MINT]);
  });

  it("gives identical chunks distinct transactions", async () => {
    const recipient = await seedRecipientAccount(WALLET_A);
    const paid = { ...recipient, amount: "0.1" };

    const created = await readBatch(await sendBatch([...fullChunkOf(paid), ...fullChunkOf(paid)]));

    // Two identical messages would share a signature, and the chain would drop the second.
    const signatures = sentSignatures();
    expect(signatures).toHaveLength(2);
    expect(new Set(signatures).size).toBe(2);
    expect(created.transfers.map((t) => t.status)).toEqual(["processing", "processing"]);
  });

  it("settles a mixed batch to partially_failed via the reconciliation job", async () => {
    const created = await readBatch(await sendBatch(await seedTwoChunkRecipients()));
    expect(created.batch.status).toBe("processing");
    const [landed] = sentSignatures();
    settleChainVerdicts((signature) => (signature === landed ? CONFIRMED : FAILED_ON_CHAIN));

    await runInEachClusterScope(() => trackPendingTransfers(env));

    const settled = await readBatch(await getBatch(created.batch.id));
    expect(settled.batch.status).toBe("partially_failed");
    const batchRow = await getDb(env)
      .prepare("SELECT error FROM payment_transfer_batches WHERE id = ?")
      .bind(created.batch.id)
      .first<{ error: string | null }>();
    expect(required(batchRow).error).toBe(
      "One or more transfer batch transactions failed during execution"
    );
    const recipientsOf = (signature: string | null) => {
      const transfer = required(settled.transfers.find((t) => t.signature === signature));
      return settled.recipients
        .filter((r) => r.transferId === transfer.id)
        .map((r) => [r.status, r.error]);
    };
    expect(recipientsOf(required(landed))).toEqual(fullChunkOf(["confirmed", null]));
    expect(recipientsOf(required(sentSignatures()[1]))).toEqual(
      fullChunkOf(["failed", '{"InstructionError":[0,{"Custom":1}]}'])
    );
    // Each chunk's audit intent closes with its chain verdict, not with RPC
    // accepting the send (APE-425).
    for (const transfer of settled.transfers) {
      await expectChunkOutcome(
        transfer,
        transfer.signature === landed
          ? { status: "success", batchTransferStatus: "confirmed" }
          : { status: "failure", batchTransferStatus: "failed" }
      );
    }
  });

  it("settles a chunk's recipients as failed when its execution throws mid-flight", async () => {
    let creates = 0;
    wrapPaymentsRepository((repository) => ({
      createTransfer: async (params) => {
        creates += 1;
        if (creates === 2) throw new Error("simulated transfer persistence failure");
        return repository.createTransfer(params);
      },
    }));

    const created = await readBatch(await sendBatch(await seedTwoChunkRecipients()));

    expect(created.batch.status).toBe("processing");
    expect(created.transfers.map((t) => t.status)).toEqual(["processing"]);
    const failed = created.recipients.filter((r) => r.status === "failed");
    expect(failed.map((r) => [r.error, r.transferId])).toEqual(
      fullChunkOf(["simulated transfer persistence failure", null])
    );
    expect(created.recipients.filter((r) => r.status === "processing")).toHaveLength(
      MAX_RECIPIENTS_PER_TRANSACTION
    );
    expect(sendTransactionMock).toHaveBeenCalledOnce();
  });

  it("rolls back the chunk transfer when recipient linking fails so reconciliation never sees an orphan", async () => {
    let injected = false;
    wrapBatchesRepository((repository) => ({
      updateTransferRecipientsStatus: async (input) => {
        if (!injected && input.transferId !== null && input.status === "processing") {
          injected = true;
          throw new Error("simulated recipient link failure");
        }
        return repository.updateTransferRecipientsStatus(input);
      },
    }));
    const recipient = await seedRecipientAccount(WALLET_A);

    const created = await readBatch(await sendBatch([{ ...recipient, amount: "0.1" }]));

    expect(sendTransactionMock).not.toHaveBeenCalled();
    expect(created.batch.status).toBe("failed");
    expect(created.transfers).toEqual([]);
    expect(created.recipients.map((r) => [r.status, r.error, r.transferId])).toEqual([
      ["failed", "simulated recipient link failure", null],
    ]);
    const chunkRows = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS count FROM payment_transfers WHERE type = 'transfer_batch'")
      .first<{ count: number }>();
    expect(required(chunkRows).count).toBe(0);

    await runInEachClusterScope(() => trackPendingTransfers(env));
    expect(await readBatchStatus(created.batch.id)).toBe("failed");
  });

  it("fails a linked chunk when signed transaction persistence fails before broadcast", async () => {
    let injected = false;
    wrapPaymentsRepository((repository) => ({
      persistSignedTransfer: async (input) => {
        if (!injected) {
          injected = true;
          throw new Error("simulated signature persist failure");
        }
        return repository.persistSignedTransfer(input);
      },
    }));
    const recipient = await seedRecipientAccount(WALLET_B);

    const created = await readBatch(await sendBatch([{ ...recipient, amount: "0.1" }]));

    expect(sendTransactionMock).not.toHaveBeenCalled();
    expect(created.batch.status).toBe("failed");
    const transfer = required(created.transfers[0]);
    expect(transfer).toMatchObject({ status: "failed", signature: null });
    expect(created.recipients.map((r) => [r.status, r.transferId])).toEqual([
      ["failed", transfer.id],
    ]);
  });

  it("returns the terminal status when reconciliation settles the batch mid-request", async () => {
    let reconciled = false;
    wrapBatchesRepository((repository) => ({
      recomputeTransferBatchStatus: async (input) => {
        if (!reconciled) {
          reconciled = true;
          settleChainVerdicts(() => CONFIRMED);
          // The job runs as the cron runner runs it, not as the request it interrupts.
          await runWithSystemDatabaseIdentity("cron:track-pending-transfers", () =>
            trackPendingTransfers(env)
          );
        }
        return repository.recomputeTransferBatchStatus(input);
      },
    }));
    const recipient = await seedRecipientAccount(WALLET_A);

    const created = await readBatch(await sendBatch([{ ...recipient, amount: "0.1" }]));

    expect(reconciled).toBe(true);
    expect(created.batch.status).toBe("confirmed");
    expect(created.recipients.map((r) => r.status)).toEqual(["confirmed"]);
    expect(created.transfers.map((t) => t.status)).toEqual(["confirmed"]);
  });

  it("resolves concurrent settlements of the same batch to the correct final status", async () => {
    const created = await readBatch(await sendBatch(await seedTwoChunkRecipients()));
    const [first, second] = created.transfers;
    const repository = createSystemPaymentTransferBatchesRepository(env);
    const settle = (transferId: string, transferStatus: "confirmed" | "failed") =>
      repository.settleTransferBatch({
        transferId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        transferStatus,
        error: transferStatus === "failed" ? "on-chain failure" : null,
        slot: null,
        updatedAt: new Date().toISOString(),
      });

    await Promise.all([
      settle(required(first).id, "confirmed"),
      settle(required(second).id, "failed"),
    ]);

    expect(await readBatchStatus(created.batch.id)).toBe("partially_failed");
  });

  it("accepts a batch of the most recipients one holds and reads every one back", async () => {
    const accounts = await seedRecipientAccounts(
      Array.from({ length: MAX_TRANSFER_BATCH_RECIPIENTS }, (_, index) =>
        syntheticAddress(1_000 + index)
      )
    );

    const created = await readBatch(
      await sendBatch(accounts.map((account) => ({ ...account, amount: "0.001" })))
    );

    expect(created.batch.recipientCount).toBe(500);
    expect(created.recipients).toHaveLength(500);
    const read = await readBatch(await getBatch(created.batch.id));
    expect(new Set(read.recipients.map((r) => r.destination)).size).toBe(500);
    expect(read.transfers).toHaveLength(created.batch.transactionCount);
  }, 30_000);
});
