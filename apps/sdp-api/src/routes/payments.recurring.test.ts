import { runInClusterScope } from "@sdp/rpc/scope";
import type * as solanaRpc from "@sdp/rpc/solana";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  isCollectableRecurringPaymentStatus,
  PAYMENT_RECURRING_PAYMENT_LIFECYCLE_OPERATIONS,
  type PaymentRecurringPaymentAttemptStatus,
  type PaymentRecurringPaymentLifecycleAttemptStage,
  type PaymentRecurringPaymentLifecycleOperation,
  type PaymentRecurringPaymentUpdateAttemptStage,
  type PaymentSubscriptionCollectionAttemptMetadata,
  RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS,
  RECURRING_PAYMENT_STATUSES_WITH_RECOVERABLE_COLLECTION,
  SUCCESSFUL_PAYMENT_TRANSFER_STATUSES,
} from "@sdp/types/payments";
import type { TokenStatus } from "@sdp/types/tokens";
import { getBase58Codec } from "@solana/codecs";
import {
  address,
  blockhash,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  lamports,
  type MaybeAccount,
  signature,
} from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import * as paymentRecurringPaymentsRepositoryPostgres from "@/db/repositories/payment-recurring-payments.repository.postgres";
import * as paymentSubscriptionsRepositoryPostgres from "@/db/repositories/payment-subscriptions.repository.postgres";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories/payment-subscriptions.repository.postgres";
import * as paymentsRepositoryPostgres from "@/db/repositories/payments.repository.postgres";
import { app as baseApp } from "@/index";
import { AppError, badRequest, PUBLIC_INTERNAL_ERROR_MESSAGE } from "@/lib/errors";
import { MoneyMovementRefusedError } from "@/lib/money-admission";
import * as organizationAccess from "@/lib/organization-access";
import { deriveIdempotencyRecordKey } from "@/middleware/idempotency";
import { errorResponseSchema, successResponseSchema } from "@/openapi/schemas/base";
import { paymentRecurringPaymentListResponseSchema } from "@/openapi/schemas/payments";
import { runInEachClusterScope } from "@/runtime/cluster-scope-runs";
import { rootLogger } from "@/runtime/logger";
import { SigningService } from "@/services/domain/signing.service";
import { collectDueRecurringPayments } from "@/services/jobs/collect-recurring-payments";
import { cancelRecurringPaymentsActivatedByKey } from "@/services/payments/recurring-payments/cancel-activated-by-key";
import { skipRefusedRecurringCollectionPeriod } from "@/services/payments/recurring-payments/collection";
import * as recurringShared from "@/services/payments/recurring-payments/shared";
import * as paymentAmounts from "@/services/payments/token-amount";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { authenticateTestClerkUser } from "@/test/helpers/clerk";
import {
  clusterOfRpcClient,
  epochInfoResult,
  type StubSignatureStatus,
  signatureStatusesRead,
  signatureStatusesReplyAt,
} from "@/test/helpers/cluster-rpc";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { deferred } from "@/test/helpers/deferred";
import { env } from "@/test/helpers/env";
import { withIdempotencyKeys } from "@/test/helpers/idempotency-keys";
import {
  confirmTransactionMock,
  createKoraAdapterMock,
  createOrgSignerForCustodyWalletMock,
  DEVNET_USDC_MINT,
  enableMainnetSponsorship,
  fetchMaybeSubscriptionDelegationMock,
  getAccountInfoMock,
  getRecentBlockhashMock,
  getTransactionMock,
  installPaymentsRouteTestHooks,
  MAINNET_USDC_MINT,
  recurringCollectionTransactionForSignature,
  seedCachedKey,
  seedCounterparty,
  seedProductionPrivyWallet,
  sendTransactionMock,
  TEST_API_KEY,
  TEST_CONFIG_ID,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PRODUCTION_PROJECT_ID,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { seedConfigOwnedDuplicateProviderWallet } from "@/test/helpers/payments-transfers";
import {
  activateRecurringPaymentFixture,
  createRecurringPaymentFixture,
  DEFAULT_RECURRING_FIXTURE,
  installRecurringExecutionHooks,
  parseCollectionResponse,
  parseRecurringResponse,
  poolSentSignatures,
  RECURRING_HEADERS,
  rejectPoolSendAfter,
  seedRecurringCollectionJournal,
  setRecurringCollectionDue,
  testSignature,
} from "@/test/helpers/recurring-payments";
import { required } from "@/test/helpers/required";
import { sendTransactionPreflightError } from "@/test/helpers/rpc-errors";
import { respondMintAccounts, scaledUiAmountConfig } from "@/test/helpers/token-mints";

// Every mutation carries a fresh key unless a test sets its own (HOO-1918).
const app = withIdempotencyKeys(baseApp);

const SAVED_LAST_VALID_BLOCK_HEIGHT = 1000;
const CHAIN_TIP_SLOT = 2000;

/** A subscription delegation on chain; `expiresAtTs` 0 is active, set is canceled. */
function delegation(
  expiresAtTs: bigint
): MaybeAccount<subscriptionsProgram.SubscriptionDelegation> {
  return {
    exists: true,
    address: address(TEST_SOLANA_ADDRESSES.wallet3),
    executable: false,
    lamports: lamports(2_000_000n),
    programAddress: subscriptionsProgram.SUBSCRIPTIONS_PROGRAM_ADDRESS,
    space: BigInt(subscriptionsProgram.SUBSCRIPTION_SIZE),
    data: {
      header: {
        discriminator: 0,
        version: subscriptionsProgram.CURRENT_PROGRAM_VERSION,
        bump: 255,
        delegator: address(TEST_SOLANA_ADDRESSES.wallet1),
        delegatee: address(TEST_SOLANA_ADDRESSES.wallet2),
        payer: address(TEST_SOLANA_ADDRESSES.wallet1),
        initId: 1n,
      },
      terms: { amount: 25_000_000n, periodHours: 24n, createdAt: 1_770_000_000n },
      amountPulledInPeriod: 0n,
      currentPeriodStartTs: 1_770_000_000n,
      expiresAtTs,
    },
  };
}

/** A plan on chain; `metadataUri` is stored NUL-padded to its fixed 128 bytes. */
function planAccount(metadataUri = ""): MaybeAccount<subscriptionsProgram.Plan> {
  return {
    exists: true,
    address: address(TEST_SOLANA_ADDRESSES.wallet3),
    executable: false,
    lamports: lamports(2_000_000n),
    programAddress: subscriptionsProgram.SUBSCRIPTIONS_PROGRAM_ADDRESS,
    space: BigInt(subscriptionsProgram.PLAN_SIZE),
    data: {
      discriminator: 0,
      owner: address(TEST_SOLANA_ADDRESSES.wallet1),
      bump: 255,
      status: subscriptionsProgram.PlanStatus.Active,
      data: {
        planId: 1001n,
        mint: address(DEVNET_USDC_MINT),
        terms: { amount: 25_000_000n, periodHours: 24n, createdAt: 1_770_000_000n },
        endTs: 0n,
        destinations: [address(TEST_SOLANA_ADDRESSES.wallet2)],
        pullers: [address(TEST_SOLANA_ADDRESSES.wallet1)],
        metadataUri: metadataUri.padEnd(128, "\0"),
      },
    },
  };
}

const noAccount = { exists: false, address: address(TEST_SOLANA_ADDRESSES.wallet3) } as const;

/** Leaves a subscription's collection attempts unkeyed, as the cron's claim is (HOO-1918). */
async function clearCollectionAttemptKeys(subscriptionId: string): Promise<void> {
  await getDb(env)
    .prepare(
      "UPDATE payment_subscription_collection_attempts SET idempotency_key = NULL WHERE subscription_id = ?"
    )
    .bind(subscriptionId)
    .run();
}

const recurringPaymentLogEventSchema = z.object({ event: z.string() });

function mockDistinctRecentBlockhashes(): void {
  const blockhashes = [
    "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
    "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR",
    "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8",
    "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq",
    "LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY",
    "QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF",
  ];
  let call = 0;
  getRecentBlockhashMock.mockImplementation(async () => ({
    blockhash: blockhash(blockhashes[call++ % blockhashes.length]),
    lastValidBlockHeight: 1000n,
  }));
}

const _TEST_COUNTERPARTY_IDENTITY = {
  firstName: "Ada",
  lastName: "Lovelace",
  dateOfBirth: "1990-01-15",
  phone: "+14155551234",
  address: {
    line1: "1 Market St",
    city: "San Francisco",
    countryCode: "US",
  },
} as const;

async function seedCryptoWalletCounterpartyAccount(params: {
  counterpartyId: string;
  address: string;
}): Promise<string> {
  const id = `counterparty_account_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  await getDb(env)
    .prepare(
      `INSERT INTO counterparty_accounts (
         id,
         organization_id,
         project_id,
         counterparty_id,
         account_kind,
         label,
         details,
         provider_account_data,
         status,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      params.counterpartyId,
      "crypto_wallet",
      "Recurring payment wallet",
      JSON.stringify({ network: "solana", address: params.address }),
      JSON.stringify({}),
      "active",
      now,
      now
    )
    .run();

  return id;
}

async function seedIssuedTokenMint(params: {
  projectId: string;
  mintAddress: string;
  status: TokenStatus;
}): Promise<string> {
  const tokenId = `tok_${crypto.randomUUID()}`;
  await getDb(env)
    .prepare(
      `INSERT INTO issued_tokens (id, project_id, organization_id, mint_address, name, symbol, decimals, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      tokenId,
      params.projectId,
      TEST_ORG.id,
      params.mintAddress,
      "Issued Test Token",
      "ITT",
      6,
      params.status,
      TEST_USER.id
    )
    .run();
  return tokenId;
}

/** An active schedule on a token issued in the project, and a way to pause that token. */
async function activateOnIssuedToken() {
  const issuedMint = (await generateKeyPairSigner()).address;
  const issuedTokenId = await seedIssuedTokenMint({
    projectId: TEST_PROJECT.id,
    mintAddress: issuedMint,
    status: "active",
  });
  const activated = await activateRecurringPaymentFixture({
    ...DEFAULT_RECURRING_FIXTURE,
    token: issuedMint,
  });
  const pauseToken = async () => {
    await getDb(env)
      .prepare("UPDATE issued_tokens SET status = 'paused' WHERE id = ?")
      .bind(issuedTokenId)
      .run();
  };
  return { activated, issuedMint, pauseToken };
}

function _expectPreparedSubscriptionTransaction(
  preparedTransaction: {
    serialized: string;
    blockhash: string;
    lastValidBlockHeight: string;
    requiredSigners: string[];
  },
  expectedSigners: string[]
): void {
  expect(preparedTransaction.serialized).toBeTruthy();
  expect(preparedTransaction.blockhash).toBe("EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N");
  expect(preparedTransaction.lastValidBlockHeight).toBe("1000");
  for (const signer of expectedSigners) {
    expect(preparedTransaction.requiredSigners).toContain(signer);
  }

  const transaction = getTransactionDecoder().decode(
    Buffer.from(preparedTransaction.serialized, "base64")
  );
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);

  expect(message.staticAccounts.length).toBeGreaterThan(0);
  for (const signer of expectedSigners) {
    expect(Object.keys(transaction.signatures)).toContain(signer);
  }
}

/** A deleted organization keeps its rows; only new money movement stops (HOO-1955). */
async function deleteTestOrganization() {
  await getDb(env)
    .prepare("UPDATE organizations SET status = 'deleted' WHERE id = ?")
    .bind(TEST_ORG.id)
    .run();
}

/**
 * Authentication refuses a deleted organization outright (it reads the status
 * fresh on every request), so an HTTP handler only meets a deleted organization
 * when the deletion lands while the request is in flight. This deletes it just
 * after the next request's authentication read, which is that race.
 */
function deleteTestOrganizationAfterAuth() {
  const authenticate = organizationAccess.authorizeApiKey;
  vi.spyOn(organizationAccess, "authorizeApiKey").mockImplementationOnce(async (...args) => {
    const settings = await authenticate(...args);
    await deleteTestOrganization();
    return settings;
  });
}

async function collectionAttempts(subscriptionId: string) {
  return (
    await getDb(env)
      .prepare(
        `SELECT status, error, signature, metadata
           FROM payment_subscription_collection_attempts
          WHERE subscription_id = ?
          ORDER BY created_at`
      )
      .bind(subscriptionId)
      .all<{
        status: string;
        error: string | null;
        signature: string | null;
        metadata: { source?: string };
      }>()
  ).results;
}

async function recurringPaymentDueAt(recurringPaymentId: string) {
  const row = await getDb(env)
    .prepare("SELECT status, next_collection_due_at FROM payment_recurring_payments WHERE id = ?")
    .bind(recurringPaymentId)
    .first<{ status: string; next_collection_due_at: string | Date }>();
  return { status: row?.status, dueAt: new Date(row?.next_collection_due_at ?? 0).getTime() };
}

function activationState(recurringPaymentId: string) {
  return getDb(env)
    .prepare(
      `SELECT rp.status, a.status AS attempt_status, a.authorization_signature,
              a.last_valid_block_height
         FROM payment_recurring_payments rp
         JOIN payment_recurring_payment_activation_attempts a ON a.recurring_payment_id = rp.id
        WHERE rp.id = ?`
    )
    .bind(recurringPaymentId)
    .first<{
      status: string;
      attempt_status: string;
      authorization_signature: string | null;
      last_valid_block_height: string | null;
    }>();
}

function collectDueRecurringPaymentsIn(environment: SdpEnvironment, now: Date) {
  return runInClusterScope({ projectId: null, environment }, () =>
    collectDueRecurringPayments(env, now)
  );
}

async function activateRecurringPaymentForTest(headers: Record<string, string>) {
  return activateRecurringPaymentFixture({ ...DEFAULT_RECURRING_FIXTURE, headers });
}

function recurringExecutionCallCounts() {
  return {
    feePaymentAdapter: createKoraAdapterMock.mock.calls.length,
    custodySigner: createOrgSignerForCustodyWalletMock.mock.calls.length,
    accountInfo: getAccountInfoMock.mock.calls.length,
    blockhash: getRecentBlockhashMock.mock.calls.length,
    confirmation: confirmTransactionMock.mock.calls.length,
    transaction: getTransactionMock.mock.calls.length,
    send: sendTransactionMock.mock.calls.length,
    delegation: fetchMaybeSubscriptionDelegationMock.mock.calls.length,
  };
}

function denyRecurringRuntimeExecution() {
  return vi.spyOn(SigningService.prototype, "admitRuntimeExecution").mockRejectedValue(
    new AppError("CONFLICT", "Custody wallet is unavailable", {
      reason: "runtime_execution_unavailable",
    })
  );
}

async function recurringExecutionSnapshot(recurringPaymentId: string) {
  return getDb(env)
    .prepare(
      `SELECT to_jsonb(rp) AS recurring_payment,
              (SELECT COUNT(*)::int
                 FROM payment_recurring_payments) AS recurring_payments,
              (SELECT to_jsonb(ps)
                 FROM payment_subscriptions ps
                WHERE ps.id = rp.subscription_id) AS subscription,
              (SELECT COUNT(*)::int
                 FROM payment_recurring_payment_activation_attempts a
                WHERE a.recurring_payment_id = rp.id) AS activation_attempts,
              (SELECT COUNT(*)::int
                 FROM payment_recurring_payment_update_attempts a
                WHERE a.recurring_payment_id = rp.id) AS update_attempts,
              (SELECT COUNT(*)::int
                 FROM payment_recurring_payment_lifecycle_attempts a
                WHERE a.recurring_payment_id = rp.id) AS lifecycle_attempts,
              (SELECT COUNT(*)::int
                 FROM payment_recurring_payment_update_events e
                WHERE e.recurring_payment_id = rp.id) AS update_events,
              (SELECT COUNT(*)::int
                 FROM payment_subscription_collection_attempts a
                WHERE a.subscription_id = rp.subscription_id) AS collection_attempts,
              (SELECT COUNT(*)::int
                 FROM payment_transfers t
                WHERE t.provider_data->>'recurringPaymentId' = rp.id) AS collection_transfers
         FROM payment_recurring_payments rp
        WHERE rp.id = ?`
    )
    .bind(recurringPaymentId)
    .first();
}

async function expectRuntimeAdmissionDenialWithoutWrites(input: {
  recurringPaymentId: string;
  path: string;
  method: "PATCH" | "POST";
  headers: Record<string, string>;
  body: string;
}) {
  const before = await recurringExecutionSnapshot(input.recurringPaymentId);
  const executionCalls = recurringExecutionCallCounts();
  const admission = denyRecurringRuntimeExecution();

  try {
    const response = await app.request(
      input.path,
      { method: input.method, headers: input.headers, body: input.body },
      env
    );

    expect(response.status).toBe(409);
    expect(admission).toHaveBeenCalledOnce();
    expect(admission).toHaveBeenCalledWith(TEST_ORG.id, TEST_PROJECT.id, TEST_CUSTODY_WALLET_ID);
  } finally {
    admission.mockRestore();
  }

  expect(await recurringExecutionSnapshot(input.recurringPaymentId)).toEqual(before);
  expect(recurringExecutionCallCounts()).toEqual(executionCalls);
}

const UNBOUND_CUSTODY_WALLET_ID = "cwlt_recurring_unbound";
const UNBOUND_WALLET_ID = "wal_recurring_unbound";
interface SeededPendingRecurringPayment {
  id: string;
  counterpartyId: string;
  counterpartyAccountId: string;
}

async function seedUnboundWallet(): Promise<void> {
  const unboundWallet = await generateKeyPairSigner();
  await getDb(env)
    .prepare(
      `INSERT INTO custody_wallets
         (id, custody_config_id, wallet_id, public_key, purpose, status)
       VALUES (?, ?, ?, ?, 'transfer', 'active')`
    )
    .bind(UNBOUND_CUSTODY_WALLET_ID, TEST_CONFIG_ID, UNBOUND_WALLET_ID, unboundWallet.address)
    .run();
}

/**
 * Seed a wallet sharing the primary wallet's Provider ID under another provider's config in the
 * project, since a project holds one config per provider.
 * @param params - The replacement wallet's rows.
 * @param params.custodyConfigId - Id of the owning config.
 * @param params.custodyWalletId - Id of the replacement wallet record.
 * @param params.publicKey - The replacement wallet's address.
 * @returns Resolves once the config and wallet are written.
 */
async function seedReplacementCustodyWallet(params: {
  custodyConfigId: string;
  custodyWalletId: string;
  publicKey: string;
}): Promise<void> {
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: params.custodyConfigId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        provider: "privy",
        configEncrypted: "test-config",
        status: "active",
      },
    ],
    wallets: [
      {
        id: params.custodyWalletId,
        owner: { kind: "config", custodyConfigId: params.custodyConfigId },
        walletId: TEST_WALLET_ID,
        publicKey: params.publicKey,
        label: null,
        purpose: "transfer",
        status: "active",
      },
    ],
  });
}

async function bindApiKeyToWallet(custodyWalletId: string): Promise<void> {
  await seedCachedKey({ walletScope: "selected", walletIds: [custodyWalletId] });
}

/**
 * POSTs `path` as the recurring test key while another transaction holds the
 * key row, and revokes the key there once the request's claim is waiting on
 * it: the request was admitted with a live key, and its claim reads it after
 * the revocation commits.
 */
async function revokeKeyWhileClaiming(
  path: string,
  init: { method: string; body: unknown } = { method: "POST", body: {} },
  narrowing = "UPDATE api_keys SET status = 'deactivated' WHERE id = ?"
): Promise<Response> {
  return narrowWhileClaiming({
    path,
    init,
    headers: RECURRING_HEADERS,
    table: "api_keys",
    rowId: TEST_API_KEY.id,
    narrowing,
  });
}

/**
 * Holds the activator's row lock, sends the request, waits until its claim
 * blocks on that row, then applies `narrowing` and commits, so the narrowing
 * lands after admission and before the claim reads the row.
 */
async function narrowWhileClaiming(input: {
  path: string;
  init: { method: string; body: unknown };
  headers: Record<string, string>;
  table: "api_keys" | "organization_members" | "project_members";
  rowId: string;
  narrowing: string;
}): Promise<Response> {
  let narrow: () => void = () => {};
  const narrowed = new Promise<void>((resolve) => {
    narrow = resolve;
  });
  let locked: () => void = () => {};
  const holding = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const lockRow = {
    api_keys: "SELECT id FROM api_keys WHERE id = ? FOR UPDATE",
    organization_members: "SELECT id FROM organization_members WHERE user_id = ? FOR UPDATE",
    project_members: "SELECT id FROM project_members WHERE user_id = ? FOR UPDATE",
  }[input.table];
  const narrowing = getDb(env).transaction(async (tx) => {
    await tx.execute(lockRow, [input.rowId]);
    locked();
    await narrowed;
    await tx.execute(input.narrowing, [input.rowId]);
  });
  await holding;
  const request = app.request(
    input.path,
    { method: input.init.method, headers: input.headers, body: JSON.stringify(input.init.body) },
    env
  );
  await untilWaitingOnRowLock(input.table);
  narrow();
  await narrowing;
  return request;
}

/** Waits until a claim's share lock on a row of `table` is blocked behind another transaction. */
async function untilWaitingOnRowLock(
  table: "api_keys" | "organization_members" | "project_members"
): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const waiting = await getDb(env).queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND datname = current_database()
          AND pid <> pg_backend_pid()
          AND position('FOR SHARE' in query) > 0
          AND position($1 in query) > 0`,
      [table]
    );
    if (!waiting) throw new Error("COUNT(*) returned no row");
    if (waiting.count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No claim started waiting on the ${table} row lock`);
}

async function seedPendingRecurringPayment(): Promise<SeededPendingRecurringPayment> {
  const recurringPayment = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
  const response = await app.request(
    `/v1/payments/recurring-payments/${recurringPayment.id}`,
    { headers: RECURRING_HEADERS },
    env
  );
  expect(response.status).toBe(200);
  const body = await parseRecurringResponse(response);
  return body.data.recurringPayment;
}

async function expectWalletOutOfScope(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  const body = errorResponseSchema.parse(await response.json());
  expect(body.error.message).toBe("The credential may not sign with this wallet");
}

describe("Payments routes — recurring", () => {
  installPaymentsRouteTestHooks();
  const recurringExecution = installRecurringExecutionHooks();
  beforeEach(() => {
    answerChainTip(SAVED_LAST_VALID_BLOCK_HEIGHT);
    answerSignatureStatuses(() => null);
  });

  function answerChainTip(blockHeight: number): void {
    recurringExecution.rpc.answer(
      "getEpochInfo",
      epochInfoResult({ absoluteSlot: CHAIN_TIP_SLOT, blockHeight })
    );
  }

  function answerSignatureStatuses(status: (signature: string) => StubSignatureStatus | null) {
    recurringExecution.rpc.respond("getSignatureStatuses", (request) =>
      signatureStatusesReplyAt(
        CHAIN_TIP_SLOT,
        signatureStatusesRead(request).signatures.map(status)
      )
    );
  }

  function recordSignatureStatus(recorded: string, err: StubSignatureStatus["err"]): void {
    answerSignatureStatuses((signature) =>
      signature === recorded
        ? { slot: 100, confirmations: null, confirmationStatus: "finalized", err }
        : null
    );
  }

  it("creates recurring work for the exact wallet when Provider wallet IDs are duplicated", async () => {
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted,
              encryption_version, status)
           VALUES ('cust_cfg_ambiguous_recurring', ?, ?, 'privy', 'test-config',
                   'sdp-custody-encryption-v1', 'active')`
        )
        .bind(TEST_ORG.id, TEST_PROJECT.id),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, status)
           VALUES ('cwlt_ambiguous_recurring', 'cust_cfg_ambiguous_recurring', ?, ?, 'active')`
        )
        .bind(TEST_WALLET_ID, TEST_SOLANA_ADDRESSES.wallet1),
    ]);

    await createRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    expect(
      await getDb(env)
        .prepare("SELECT source_custody_wallet_id FROM payment_recurring_payments")
        .first<{ source_custody_wallet_id: string }>()
    ).toEqual({ source_custody_wallet_id: TEST_CUSTODY_WALLET_ID });
  });

  it("creates, lists, and gets recurring payment records through SDP API routes", async () => {
    const created = await createRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    expect(created.id).toMatch(/^prp_/);
    expect(created.sourceCustodyWalletId).toBe(TEST_CUSTODY_WALLET_ID);
    expect(created.sourceProviderWalletId).toBe(TEST_WALLET_ID);
    expect(created.destinationAddress).toBe(TEST_SOLANA_ADDRESSES.wallet2);
    expect(created.token).toBe(DEVNET_USDC_MINT);
    expect(created.amount).toBe("25.00");
    expect(created.status).toBe("pending_activation");

    const listRes = await app.request(
      "/v1/payments/recurring-payments?status=pending_activation",
      { headers: RECURRING_HEADERS },
      env
    );
    expect(listRes.status).toBe(200);
    const listBody = successResponseSchema(paymentRecurringPaymentListResponseSchema).parse(
      await listRes.json()
    );
    expect(listBody.data.total).toBe(1);
    expect(listBody.data.recurringPayments[0]?.id).toBe(created.id);

    const getRes = await app.request(
      `/v1/payments/recurring-payments/${created.id}`,
      { headers: RECURRING_HEADERS },
      env
    );
    expect(getRes.status).toBe(200);
    const getBody = await parseRecurringResponse(getRes);
    expect(getBody.data.recurringPayment.id).toBe(created.id);
    expect(getBody.data.recurringPayment.status).toBe("pending_activation");
  });

  it("fails closed before signing when a recurring payment has no exact wallet pin", async () => {
    const recurringPaymentId = (
      await createRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        headers: RECURRING_HEADERS,
      })
    ).id;
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET source_custody_wallet_id = NULL WHERE id = ?")
      .bind(recurringPaymentId)
      .run();
    const signerCalls = createOrgSignerForCustodyWalletMock.mock.calls.length;

    const response = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(response.status).toBe(409);
    expect(createOrgSignerForCustodyWalletMock).toHaveBeenCalledTimes(signerCalls);
  });

  it("does not claim activation when runtime admission denies the source wallet", async () => {
    const recurringPaymentId = (
      await createRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        headers: RECURRING_HEADERS,
      })
    ).id;

    await expectRuntimeAdmissionDenialWithoutWrites({
      recurringPaymentId,
      path: `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      method: "POST",
      headers: RECURRING_HEADERS,
      body: "{}",
    });
  });

  it("does not claim an active update when runtime admission denies the source wallet", async () => {
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });

    await expectRuntimeAdmissionDenialWithoutWrites({
      recurringPaymentId: activated.id,
      path: `/v1/payments/recurring-payments/${activated.id}`,
      method: "PATCH",
      headers: RECURRING_HEADERS,
      body: JSON.stringify({ metadataUri: "https://example.com/recurring/blocked.json" }),
    });
  });

  it.each(PAYMENT_RECURRING_PAYMENT_LIFECYCLE_OPERATIONS)(
    "does not claim $operation when runtime admission denies the source wallet",
    async (operation) => {
      const activated = await activateRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        headers: RECURRING_HEADERS,
      });
      if (operation === "resume") {
        const cancelResponse = await app.request(
          `/v1/payments/recurring-payments/${activated.id}/cancel`,
          { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
          env
        );
        expect(cancelResponse.status).toBe(200);
      }

      await expectRuntimeAdmissionDenialWithoutWrites({
        recurringPaymentId: activated.id,
        path: `/v1/payments/recurring-payments/${activated.id}/${operation}`,
        method: "POST",
        headers: RECURRING_HEADERS,
        body: "{}",
      });
    }
  );

  it("rolls back a lifecycle claim when attempt insertion fails", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const createRepository =
      paymentRecurringPaymentsRepositoryPostgres.createPostgresPaymentRecurringPaymentsRepository;
    const repositorySpy = vi
      .spyOn(
        paymentRecurringPaymentsRepositoryPostgres,
        "createPostgresPaymentRecurringPaymentsRepository"
      )
      .mockImplementation((db) => {
        const repository = createRepository(db);
        return {
          ...repository,
          createLifecycleAttempt: vi.fn(async () => {
            throw new Error("lifecycle attempt insert unavailable");
          }),
        };
      });

    const response = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );
    repositorySpy.mockRestore();

    expect(response.status).toBe(500);
    expect(
      await getDb(env)
        .prepare("SELECT status FROM payment_recurring_payments WHERE id = ?")
        .bind(activated.id)
        .first<{ status: string }>()
    ).toEqual({ status: "active" });
  });

  it("restricts recurring payment tokens to USD stablecoins and project-issued tokens", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "recurring_token_gate" });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRecurring = (token: string) =>
      app.request(
        "/v1/payments/recurring-payments",
        {
          method: "POST",
          headers: RECURRING_HEADERS,
          body: JSON.stringify({
            sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            counterpartyId,
            counterpartyAccountId,
            token,
            amount: "25.00",
            periodHours: 24,
          }),
        },
        env
      );

    const expectTokenRejected = async (token: string) => {
      const res = await createRecurring(token);
      expect(res.status).toBe(400);
      const body = errorResponseSchema.parse(await res.json());
      expect(body.error.message).toBe(
        "Recurring payments support USD stablecoins and tokens issued in this project; native SOL is not supported"
      );
    };

    await expectTokenRejected("SOL");
    await expectTokenRejected(TEST_SOLANA_ADDRESSES.wallet1);

    const issuedMint = (await generateKeyPairSigner()).address;
    const pausedMint = (await generateKeyPairSigner()).address;
    const scaledMint = (await generateKeyPairSigner()).address;
    await seedIssuedTokenMint({
      projectId: TEST_PROJECT.id,
      mintAddress: issuedMint,
      status: "active",
    });
    await seedIssuedTokenMint({
      projectId: TEST_PROJECT.id,
      mintAddress: pausedMint,
      status: "paused",
    });
    await seedIssuedTokenMint({
      projectId: TEST_PROJECT.id,
      mintAddress: scaledMint,
      status: "active",
    });
    respondMintAccounts(recurringExecution.rpc, {
      mints: new Map([
        [issuedMint, { decimals: 6, extensions: null }],
        [
          scaledMint,
          {
            decimals: 6,
            extensions: [
              scaledUiAmountConfig({
                multiplier: 2,
                newMultiplier: 2,
                newMultiplierEffectiveTimestamp: 0n,
              }),
            ],
          },
        ],
      ]),
      clockUnixTimestamp: 1_750_000_000n,
    });
    await expectTokenRejected(pausedMint);

    const scaledRes = await createRecurring(scaledMint);
    expect(scaledRes.status).toBe(400);
    expect(errorResponseSchema.parse(await scaledRes.json()).error.message).toBe(
      "Payments do not support the ScaledUiAmountConfig mint extension"
    );

    const issuedRes = await createRecurring(issuedMint);
    expect(issuedRes.status).toBe(201);
    const issuedBody = await parseRecurringResponse(issuedRes);
    expect(issuedBody.data.recurringPayment.token).toBe(issuedMint);

    const stableRes = await createRecurring("USDC");
    expect(stableRes.status).toBe(201);
    const stableBody = await parseRecurringResponse(stableRes);
    expect(stableBody.data.recurringPayment.token).toBe(DEVNET_USDC_MINT);
  });

  it("refuses a USDC amount finer than its decimals and stores no recurring payment", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "recurring_precision_gate" });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const res = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers: RECURRING_HEADERS,
        body: JSON.stringify({
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: "USDC",
          amount: "25.0000001",
          periodHours: 24,
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    expect(errorResponseSchema.parse(await res.json()).error.code).toBe("BAD_REQUEST");
    const stored = await getDb(env)
      .prepare("SELECT COUNT(*)::integer AS count FROM payment_recurring_payments")
      .first<{ count: number }>();
    expect(stored).toEqual({ count: 0 });
  });

  it("refuses an update to a USDC amount finer than its decimals and keeps the stored amount", async () => {
    const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);

    const res = await app.request(
      `/v1/payments/recurring-payments/${created.id}`,
      {
        method: "PATCH",
        headers: RECURRING_HEADERS,
        body: JSON.stringify({ amount: "35.0000001" }),
      },
      env
    );

    expect(res.status).toBe(400);
    expect(errorResponseSchema.parse(await res.json()).error.code).toBe("BAD_REQUEST");
    const stored = await getDb(env)
      .prepare("SELECT amount FROM payment_recurring_payments WHERE id = ?")
      .bind(created.id)
      .first<{ amount: string }>();
    expect(stored).toEqual({ amount: DEFAULT_RECURRING_FIXTURE.amount });
  });

  it("refuses a fresh update of an active schedule to a paused issued token, sending nothing", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const pausedMint = (await generateKeyPairSigner()).address;
    await seedIssuedTokenMint({
      projectId: TEST_PROJECT.id,
      mintAddress: pausedMint,
      status: "paused",
    });
    const sendsBefore = sendTransactionMock.mock.calls.length;

    const res = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      { method: "PATCH", headers: RECURRING_HEADERS, body: JSON.stringify({ token: pausedMint }) },
      env
    );

    expect(res.status).toBe(400);
    expect(errorResponseSchema.parse(await res.json()).error.message).toBe(
      "Recurring payments support USD stablecoins and tokens issued in this project; native SOL is not supported"
    );
    expect((await recurringPaymentDueAt(activated.id)).status).toBe("active");
    expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);
  });

  it("refuses a fresh update that keeps its issued token after the token pauses, sending nothing", async () => {
    const { activated, pauseToken } = await activateOnIssuedToken();
    await pauseToken();
    const sendsBefore = sendTransactionMock.mock.calls.length;

    const res = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      { method: "PATCH", headers: RECURRING_HEADERS, body: JSON.stringify({ amount: "30.00" }) },
      env
    );

    expect(res.status).toBe(400);
    expect(errorResponseSchema.parse(await res.json()).error.message).toBe(
      "Recurring payments support USD stablecoins and tokens issued in this project; native SOL is not supported"
    );
    expect((await recurringPaymentDueAt(activated.id)).status).toBe("active");
    expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);
  });

  it("activates recurring payments through SDP API routes", async () => {
    const signAsFeePayerMock = recurringExecution.signAsFeePayerMock();
    const created = await createRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${created.id}/activate`,
      {
        method: "POST",
        headers: RECURRING_HEADERS,
        body: "{}",
      },
      env
    );

    expect(activateRes.status).toBe(200);
    const activateBody = await parseRecurringResponse(activateRes);
    const [planCreationSignature, authorizationSignature] = poolSentSignatures();
    expect(activateBody.data.recurringPayment).toMatchObject({
      id: created.id,
      status: "active",
      planCreatedAt: "1770000000",
      planCreationSignature,
      authorizationSignature,
    });
    expect(sendTransactionMock.mock.calls.map(([, transactionBytes]) => transactionBytes)).toEqual(
      signAsFeePayerMock.mock.settledResults.map((signed) => signed.value)
    );
    expect(activateBody.data.recurringPayment.planId).toMatch(/^psp_/);
    expect(activateBody.data.recurringPayment.subscriptionId).toMatch(/^psub_/);
    expect(activateBody.data.recurringPayment.planPda).toBeTruthy();
    expect(activateBody.data.recurringPayment.subscriptionPda).toBeTruthy();
    expect(activateBody.data.recurringPayment.subscriptionAuthorityAddress).toBeTruthy();
    expect(activateBody.data.recurringPayment.nextCollectionDueAt).toBeTruthy();
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
    const confirmedAttempts = await getDb(env)
      .prepare(
        `SELECT status, stage, plan_creation_signature, authorization_signature
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(created.id)
      .all<{
        status: string;
        stage: string;
        plan_creation_signature: string | null;
        authorization_signature: string | null;
      }>();
    expect(confirmedAttempts.results[0]).toMatchObject({
      status: "confirmed",
      stage: "finalize",
      plan_creation_signature: activateBody.data.recurringPayment.planCreationSignature,
      authorization_signature: activateBody.data.recurringPayment.authorizationSignature,
    });

    const replayRes = await app.request(
      `/v1/payments/recurring-payments/${created.id}/activate`,
      {
        method: "POST",
        headers: RECURRING_HEADERS,
        body: "{}",
      },
      env
    );

    expect(replayRes.status).toBe(200);
    const replayBody = await parseRecurringResponse(replayRes);
    expect(replayBody.data.recurringPayment).toMatchObject({
      id: created.id,
      status: "active",
      authorizationSignature: activateBody.data.recurringPayment.authorizationSignature,
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
  });

  it("repairs a finalized activation attempt on replay", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);

    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payment_activation_attempts
            SET status = 'processing',
                stage = 'finalize',
                updated_at = ?
          WHERE recurring_payment_id = ?`
      )
      .bind(new Date().toISOString(), activated.id)
      .run();

    const repairedReplayRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/activate`,
      {
        method: "POST",
        headers: RECURRING_HEADERS,
        body: "{}",
      },
      env
    );

    expect(repairedReplayRes.status).toBe(200);
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
    const repairedAttempt = await getDb(env)
      .prepare(
        `SELECT status, stage
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{ status: string; stage: string }>();
    expect(repairedAttempt).toMatchObject({
      status: "confirmed",
      stage: "finalize",
    });
  });

  it.each(["database error", "fence miss"])(
    "keeps a live delegation recoverable after finalization fails with %s",
    async (failure) => {
      const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const createRepository =
        paymentRecurringPaymentsRepositoryPostgres.createPostgresPaymentRecurringPaymentsRepository;
      const repositorySpy = vi
        .spyOn(
          paymentRecurringPaymentsRepositoryPostgres,
          "createPostgresPaymentRecurringPaymentsRepository"
        )
        .mockImplementation((db) => {
          const repository = createRepository(db);
          return {
            ...repository,
            updateActivationAttempt: vi.fn(async (input) => {
              if (input.status === "confirmed") {
                if (failure === "fence miss") return null;
                throw new Error("activation attempt finalization unavailable");
              }
              return repository.updateActivationAttempt(input);
            }),
          };
        });

      const response = await app.request(
        `/v1/payments/recurring-payments/${created.id}/activate`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      );
      repositorySpy.mockRestore();

      expect(response.status).toBe(failure === "fence miss" ? 409 : 500);
      const [, authorizationSignature] = poolSentSignatures();
      expect(authorizationSignature).toBeTruthy();
      const rows = await getDb(env)
        .prepare(
          `SELECT rp.status AS recurring_status,
                rp.plan_id,
                rp.subscription_id,
                ps.status AS subscription_status,
                ps.authorization_signature,
                a.status AS attempt_status,
                a.stage AS attempt_stage,
                rp.authorization_signature AS recurring_authorization_signature,
                a.authorization_signature AS attempt_authorization_signature,
                a.last_valid_block_height
           FROM payment_recurring_payments rp
           LEFT JOIN payment_recurring_payment_activation_attempts a
             ON a.id = (SELECT id
                          FROM payment_recurring_payment_activation_attempts
                         WHERE recurring_payment_id = rp.id
                         ORDER BY created_at DESC LIMIT 1)
           LEFT JOIN payment_subscriptions ps ON ps.id = rp.subscription_id
          WHERE rp.id = ?`
        )
        .bind(created.id)
        .first<{
          recurring_status: string;
          plan_id: string | null;
          subscription_id: string | null;
          subscription_status: string;
          authorization_signature: string | null;
          attempt_status: string;
          attempt_stage: string;
          recurring_authorization_signature: string | null;
          attempt_authorization_signature: string | null;
          last_valid_block_height: string | null;
        }>();
      expect(rows).toMatchObject({
        recurring_status: "activating",
        plan_id: expect.any(String),
        subscription_id: expect.any(String),
        subscription_status: "pending_authorization",
        authorization_signature: null,
        attempt_status: "processing",
        attempt_stage: "finalize",
        recurring_authorization_signature: authorizationSignature,
        attempt_authorization_signature: authorizationSignature,
        last_valid_block_height: "1000",
      });
      expect(sendTransactionMock).toHaveBeenCalledTimes(2);

      await getDb(env)
        .prepare("UPDATE payment_recurring_payments SET updated_at = ? WHERE id = ?")
        .bind(new Date(Date.now() - 16 * 60 * 1000).toISOString(), created.id)
        .run();
      expect(await collectDueRecurringPaymentsIn("sandbox", new Date())).toMatchObject({
        recovered: 1,
        refused: 0,
      });
      const recovered = await app.request(
        `/v1/payments/recurring-payments/${created.id}`,
        { headers: RECURRING_HEADERS },
        env
      );
      expect((await parseRecurringResponse(recovered)).data.recurringPayment).toMatchObject({
        status: "active",
        authorizationSignature,
      });
      expect(
        await getDb(env)
          .prepare(
            "SELECT status, stage FROM payment_recurring_payment_activation_attempts WHERE recurring_payment_id = ?"
          )
          .bind(created.id)
          .first<{ status: string; stage: string }>()
      ).toEqual({ status: "confirmed", stage: "finalize" });
      expect(sendTransactionMock).toHaveBeenCalledTimes(2);
    }
  );

  it("updates pending recurring payment terms directly and journals an audit event", async () => {
    const created = await createRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${created.id}`,
      {
        method: "PATCH",
        headers: RECURRING_HEADERS,
        body: JSON.stringify({
          amount: "30.50",
          periodHours: 48,
          firstCollectionAt: null,
          metadataUri: "https://example.com/recurring/update.json",
        }),
      },
      env
    );

    expect(updateRes.status).toBe(200);
    const updateBody = await parseRecurringResponse(updateRes);
    expect(updateBody.data.recurringPayment).toMatchObject({
      id: created.id,
      amount: "30.50",
      periodHours: 48,
      metadataUri: "https://example.com/recurring/update.json",
      status: "pending_activation",
    });

    const event = await getDb(env)
      .prepare(
        `SELECT changed_fields, before_values, after_values
           FROM payment_recurring_payment_update_events
          WHERE recurring_payment_id = ?`
      )
      .bind(created.id)
      .first<{
        changed_fields: string[];
        before_values: Record<string, unknown>;
        after_values: Record<string, unknown>;
      }>();
    expect(event?.changed_fields).toEqual(expect.arrayContaining(["amount", "periodHours"]));
    expect(event?.before_values.amount).toBe("25.00");
    expect(event?.after_values.amount).toBe("30.50");
  });

  it("refuses changing a reset activation's plan terms, which a retry would reuse as they landed", async () => {
    const created = await createRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const otherAccountId = `counterparty_account_${crypto.randomUUID()}`;
    const planId = `psp_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO counterparty_accounts (
           id, organization_id, project_id, counterparty_id, account_kind, label,
           details, provider_account_data, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'crypto_wallet', 'Second wallet', ?, '{}', 'active', ?, ?)`
      )
      .bind(
        otherAccountId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        created.counterpartyId,
        JSON.stringify({ network: "solana", address: TEST_SOLANA_ADDRESSES.wallet3 }),
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_plans (
           id, organization_id, project_id, owner_wallet_id, owner_address, token,
           amount, period_hours, program_plan_id, status, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, '25.00', 24, '1001', 'active', ?, ?, ?)`
      )
      .bind(
        planId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        recurringExecution.sourceSigner().address,
        DEVNET_USDC_MINT,
        TEST_USER.id,
        now,
        now
      )
      .run();
    // The plan landed, then the subscription was refused and the activation reset.
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payments
            SET plan_id = ?, plan_pda = ?, plan_created_at = '1770000000',
                plan_creation_signature = ?
          WHERE id = ?`
      )
      .bind(planId, TEST_SOLANA_ADDRESSES.wallet3, testSignature(1), created.id)
      .run();
    const before = await getDb(env)
      .prepare("SELECT destination_address, amount FROM payment_recurring_payments WHERE id = ?")
      .bind(created.id)
      .first<{ destination_address: string; amount: string }>();
    const patch = (body: Record<string, unknown>) =>
      app.request(
        `/v1/payments/recurring-payments/${created.id}`,
        { method: "PATCH", headers: RECURRING_HEADERS, body: JSON.stringify(body) },
        env
      );

    expect((await patch({ counterpartyAccountId: otherAccountId })).status).toBe(409);
    expect((await patch({ amount: "30.00" })).status).toBe(409);
    expect(
      await getDb(env)
        .prepare("SELECT destination_address, amount FROM payment_recurring_payments WHERE id = ?")
        .bind(created.id)
        .first()
    ).toEqual(before);
    // A term the plan does not carry still changes.
    expect((await patch({ firstCollectionAt: null })).status).toBe(200);
  });

  it("treats a respelled amount on an active schedule as no change, broadcasting nothing", async () => {
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const sentBefore = sendTransactionMock.mock.calls.length;

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      { method: "PATCH", headers: RECURRING_HEADERS, body: JSON.stringify({ amount: "25.0" }) },
      env
    );

    expect(updateRes.status).toBe(200);
    expect(sendTransactionMock.mock.calls.length).toBe(sentBefore);
    const replacements = await getDb(env)
      .prepare(
        `SELECT COUNT(*)::integer AS count FROM payment_recurring_payment_update_attempts
          WHERE recurring_payment_id = ? AND 'amount' = ANY(changed_fields)`
      )
      .bind(activated.id)
      .first<{ count: number }>();
    expect(replacements).toEqual({ count: 0 });
  });

  it("links a pending schedule's update event to its attempt", async () => {
    const created = await createRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${created.id}`,
      { method: "PATCH", headers: RECURRING_HEADERS, body: JSON.stringify({ amount: "30.50" }) },
      env
    );
    expect(updateRes.status).toBe(200);
    const linked = await getDb(env)
      .prepare(
        `SELECT e.attempt_id = a.id AS linked
           FROM payment_recurring_payment_update_events e
           JOIN payment_recurring_payment_update_attempts a
             ON a.recurring_payment_id = e.recurring_payment_id
          WHERE e.recurring_payment_id = ?`
      )
      .bind(created.id)
      .first<{ linked: boolean | null }>();
    expect(linked).toEqual({ linked: true });
  });

  it("updates active recurring payment metadata in place on the existing on-chain plan", async () => {
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const laterPeriodStartAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET current_period_start_at = ? WHERE id = ?")
      .bind(laterPeriodStartAt, activated.subscriptionId)
      .run();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers: RECURRING_HEADERS,
        body: JSON.stringify({
          metadataUri: "https://example.com/recurring/active.json",
          nextCollectionDueAt: null,
        }),
      },
      env
    );

    expect(updateRes.status).toBe(200);
    const updateBody = await parseRecurringResponse(updateRes);
    expect(updateBody.data.recurringPayment).toMatchObject({
      status: "active",
      planId: activated.planId,
      subscriptionId: activated.subscriptionId,
      metadataUri: "https://example.com/recurring/active.json",
    });
    expect(updateBody.data.recurringPayment.nextCollectionDueAt).not.toBeNull();
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);

    const attempt = await getDb(env)
      .prepare(
        `SELECT mode, status, stage, plan_update_signature
           FROM payment_recurring_payment_update_attempts
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{
        mode: string;
        status: string;
        stage: string;
        plan_update_signature: string | null;
      }>();
    expect(attempt).toMatchObject({
      mode: "metadata_schedule",
      status: "confirmed",
      stage: "finalize",
      plan_update_signature: poolSentSignatures()[2],
    });
    const event = await getDb(env)
      .prepare(
        `SELECT after_values
           FROM payment_recurring_payment_update_events
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{ after_values: Record<string, unknown> }>();
    expect(event?.after_values.nextCollectionDueAt).toBe(
      updateBody.data.recurringPayment.nextCollectionDueAt
    );
  });

  it("resets an update refused at preflight, clearing its saved signature so the next update runs at once", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    sendTransactionMock.mockRejectedValueOnce(sendTransactionPreflightError(17));
    const update = (metadataUri: string) =>
      app.request(
        `/v1/payments/recurring-payments/${activated.id}`,
        { method: "PATCH", headers: RECURRING_HEADERS, body: JSON.stringify({ metadataUri }) },
        env
      );

    const refused = await update("https://example.com/recurring/refused.json");

    expect(refused.status).toBe(400);
    expect(
      await getDb(env)
        .prepare(
          `SELECT status, plan_update_signature
             FROM payment_recurring_payment_update_attempts
            WHERE recurring_payment_id = ?`
        )
        .bind(activated.id)
        .first<{ status: string; plan_update_signature: string | null }>()
    ).toEqual({ status: "failed", plan_update_signature: null });

    const retried = await update("https://example.com/recurring/retried.json");

    expect(retried.status).toBe(200);
    expect((await parseRecurringResponse(retried)).data.recurringPayment).toMatchObject({
      status: "active",
      metadataUri: "https://example.com/recurring/retried.json",
    });
  });

  it("replaces active recurring payment records for term changes and cancels the old subscription", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    const replacementCustodyWalletId = "cwlt_recurring_replacement";
    await seedReplacementCustodyWallet({
      custodyConfigId: "cust_cfg_recurring_replacement",
      custodyWalletId: replacementCustodyWalletId,
      publicKey: sourceSigner.address,
    });
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const firstCollectionAt = "2026-07-02T00:00:00.000Z";
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET first_collection_at = ? WHERE id = ?")
      .bind(firstCollectionAt, activated.id)
      .run();

    const replacementRequest = {
      sourceCustodyWalletId: replacementCustodyWalletId,
      amount: "35.00",
      periodHours: 48,
      nextCollectionDueAt: null,
    };
    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers: RECURRING_HEADERS,
        body: JSON.stringify(replacementRequest),
      },
      env
    );

    expect(updateRes.status).toBe(200);
    const updateBody = await parseRecurringResponse(updateRes);
    const [, , replacementPlanSignature, replacementAuthSignature, oldCancelSignature] =
      poolSentSignatures();
    expect(updateBody.data.recurringPayment).toMatchObject({
      status: "active",
      sourceCustodyWalletId: replacementCustodyWalletId,
      amount: "35.00",
      periodHours: 48,
      authorizationSignature: replacementAuthSignature,
    });
    expect(updateBody.data.recurringPayment.nextCollectionDueAt).not.toBeNull();
    expect(updateBody.data.recurringPayment.planId).not.toBe(activated.planId);
    expect(updateBody.data.recurringPayment.subscriptionId).not.toBe(activated.subscriptionId);
    expect(sendTransactionMock).toHaveBeenCalledTimes(5);

    const oldSubscription = await getDb(env)
      .prepare("SELECT status FROM payment_subscriptions WHERE id = ?")
      .bind(activated.subscriptionId)
      .first<{ status: string }>();
    const oldPlan = await getDb(env)
      .prepare("SELECT status FROM payment_subscription_plans WHERE id = ?")
      .bind(activated.planId)
      .first<{ status: string }>();
    const attempt = await getDb(env)
      .prepare(
        `SELECT mode, status, stage, new_source_custody_wallet_id,
                plan_creation_signature, authorization_signature, old_cancel_signature
           FROM payment_recurring_payment_update_attempts
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{
        mode: string;
        status: string;
        stage: string;
        new_source_custody_wallet_id: string | null;
        plan_creation_signature: string | null;
        authorization_signature: string | null;
        old_cancel_signature: string | null;
      }>();
    expect(oldSubscription?.status).toBe("canceled");
    expect(oldPlan?.status).toBe("archived");
    expect(attempt).toMatchObject({
      mode: "replacement",
      status: "confirmed",
      stage: "finalize",
      new_source_custody_wallet_id: replacementCustodyWalletId,
      plan_creation_signature: replacementPlanSignature,
      authorization_signature: replacementAuthSignature,
      old_cancel_signature: oldCancelSignature,
    });
    const event = await getDb(env)
      .prepare(
        `SELECT changed_fields, before_values, after_values
           FROM payment_recurring_payment_update_events
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{
        changed_fields: string[];
        before_values: Record<string, unknown>;
        after_values: Record<string, unknown>;
      }>();
    expect(event?.changed_fields).toContain("firstCollectionAt");
    expect(event?.changed_fields).toContain("nextCollectionDueAt");
    expect(event?.before_values.firstCollectionAt).toBe(firstCollectionAt);
    expect(event?.after_values.firstCollectionAt).toBeNull();
    expect(event?.after_values.nextCollectionDueAt).toBe(
      updateBody.data.recurringPayment.nextCollectionDueAt
    );
  });

  it("lets a collection claim win over a concurrent source-wallet change", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    const replacementCustodyWalletId = "cwlt_recurring_race_replacement";
    await seedReplacementCustodyWallet({
      custodyConfigId: "cust_cfg_recurring_race_replacement",
      custodyWalletId: replacementCustodyWalletId,
      publicKey: sourceSigner.address,
    });
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });

    let releaseUpdate: (() => void) | undefined;
    let signalUpdatePaused: (() => void) | undefined;
    const updatePaused = new Promise<void>((resolve) => {
      signalUpdatePaused = resolve;
    });
    const updateReleased = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const admission = vi
      .spyOn(SigningService.prototype, "admitRuntimeExecution")
      .mockImplementationOnce(async () => {
        signalUpdatePaused?.();
        await updateReleased;
      });
    const pendingRequests: Array<Promise<Response>> = [];
    let updateRes: Response | undefined;
    let collectRes: Response | undefined;
    let releaseCollection: (() => void) | undefined;
    try {
      const updatePromise = Promise.resolve(
        app.request(
          `/v1/payments/recurring-payments/${activated.id}`,
          {
            method: "PATCH",
            headers: RECURRING_HEADERS,
            body: JSON.stringify({
              sourceCustodyWalletId: replacementCustodyWalletId,
              nextCollectionDueAt: null,
            }),
          },
          env
        )
      );
      pendingRequests.push(updatePromise);
      await updatePaused;

      let signalCollectionClaimed: (() => void) | undefined;
      const collectionClaimed = new Promise<void>((resolve) => {
        signalCollectionClaimed = resolve;
      });
      const collectionReleased = new Promise<void>((resolve) => {
        releaseCollection = resolve;
      });
      createOrgSignerForCustodyWalletMock.mockImplementationOnce(async () => {
        signalCollectionClaimed?.();
        await collectionReleased;
        return sourceSigner;
      });
      const collectPromise = Promise.resolve(
        app.request(
          `/v1/payments/recurring-payments/${activated.id}/collect`,
          { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
          env
        )
      );
      pendingRequests.push(collectPromise);
      await collectionClaimed;

      releaseUpdate?.();
      updateRes = await updatePromise;
      releaseCollection?.();
      collectRes = await collectPromise;
    } finally {
      releaseUpdate?.();
      releaseCollection?.();
      admission.mockRestore();
      await Promise.allSettled(pendingRequests);
    }

    expect(updateRes?.status).toBe(409);
    expect(collectRes?.status).toBe(200);
    expect(
      await getDb(env)
        .prepare("SELECT source_custody_wallet_id FROM payment_recurring_payments WHERE id = ?")
        .bind(activated.id)
        .first<{ source_custody_wallet_id: string | null }>()
    ).toEqual({ source_custody_wallet_id: TEST_CUSTODY_WALLET_ID });
    expect(
      await getDb(env)
        .prepare(
          `SELECT status
             FROM payment_subscription_collection_attempts
            WHERE subscription_id = ? AND due_at = ?`
        )
        .bind(activated.subscriptionId, dueAt)
        .first<{ status: string }>()
    ).toEqual({ status: "confirmed" });
    expect(
      await getDb(env)
        .prepare(
          "SELECT COUNT(*)::int AS count FROM payment_recurring_payment_update_attempts WHERE recurring_payment_id = ?"
        )
        .bind(activated.id)
        .first<{ count: number }>()
    ).toEqual({ count: 0 });
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
  });

  it("rejects active replacement next due dates before replacement transactions are submitted", async () => {
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const tooEarlyNextDue = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers: RECURRING_HEADERS,
        body: JSON.stringify({
          amount: "35.00",
          periodHours: 48,
          nextCollectionDueAt: tooEarlyNextDue,
        }),
      },
      env
    );

    expect(updateRes.status).toBe(400);
    const body = errorResponseSchema.parse(await updateRes.json());
    expect(body.error.message).toContain("replacement subscription period");
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);

    const recurringPayment = await getDb(env)
      .prepare("SELECT status FROM payment_recurring_payments WHERE id = ?")
      .bind(activated.id)
      .first<{ status: string }>();
    const attempt = await getDb(env)
      .prepare(
        `SELECT status, error, plan_creation_signature, authorization_signature, old_cancel_signature
           FROM payment_recurring_payment_update_attempts
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{
        status: string;
        error: string | null;
        plan_creation_signature: string | null;
        authorization_signature: string | null;
        old_cancel_signature: string | null;
      }>();
    expect(recurringPayment?.status).toBe("active");
    expect(attempt).toMatchObject({
      status: "failed",
      plan_creation_signature: null,
      authorization_signature: null,
      old_cancel_signature: null,
    });
    expect(attempt?.error).toContain("replacement subscription period");
  });

  it("stores an offset firstCollectionAt as the same instant in UTC", async () => {
    const created = await createRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
      firstCollectionAt: "2099-01-01T05:30:00+05:30",
    });

    expect(created.firstCollectionAt).toBe("2099-01-01T00:00:00.000Z");
    expect(
      await getDb(env)
        .prepare(
          "SELECT first_collection_at, next_collection_due_at FROM payment_recurring_payments WHERE id = ?"
        )
        .bind(created.id)
        .first<{ first_collection_at: string; next_collection_due_at: string | null }>()
    ).toMatchObject({ first_collection_at: "2099-01-01T00:00:00.000Z" });
  });

  /**
   * Pauses the next update at its runtime admission, before its claim, runs
   * `during` while it waits, then lets it finish.
   */
  async function updateAroundPausedClaim<T>(input: {
    recurringPaymentId: string;
    body: Record<string, unknown>;
    during: () => Promise<T>;
  }): Promise<{ paused: Response; during: T }> {
    const updatePaused = deferred<void>();
    const updateReleased = deferred<void>();
    const admission = vi
      .spyOn(SigningService.prototype, "admitRuntimeExecution")
      .mockImplementationOnce(async () => {
        updatePaused.resolve();
        await updateReleased.promise;
      });
    const updatePromise = Promise.resolve(
      app.request(
        `/v1/payments/recurring-payments/${input.recurringPaymentId}`,
        { method: "PATCH", headers: RECURRING_HEADERS, body: JSON.stringify(input.body) },
        env
      )
    );
    try {
      await updatePaused.promise;
      const during = await input.during();
      updateReleased.resolve();
      return { paused: await updatePromise, during };
    } finally {
      updateReleased.resolve();
      admission.mockRestore();
      await Promise.allSettled([updatePromise]);
    }
  }

  // SOLA9-703 / SOLA9-693: a same-wallet update resolves omitted fields from
  // the row it read; one that committed in between must make it lose.
  it("refuses a same-wallet update whose row a concurrent update changed after it was read", async () => {
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const laterMetadataUri = "https://example.com/recurring/later.json";

    const { paused, during } = await updateAroundPausedClaim({
      recurringPaymentId: activated.id,
      body: { metadataUri: "https://example.com/recurring/earlier.json" },
      during: async () =>
        await app.request(
          `/v1/payments/recurring-payments/${activated.id}`,
          {
            method: "PATCH",
            headers: RECURRING_HEADERS,
            body: JSON.stringify({ metadataUri: laterMetadataUri }),
          },
          env
        ),
    });

    expect(during.status).toBe(200);
    expect(paused.status).toBe(409);
    expect(errorResponseSchema.parse(await paused.json()).error.message).toContain(
      "already processing"
    );
    expect(
      await getDb(env)
        .prepare("SELECT status, metadata_uri FROM payment_recurring_payments WHERE id = ?")
        .bind(activated.id)
        .first<{ status: string; metadata_uri: string | null }>()
    ).toEqual({ status: "active", metadata_uri: laterMetadataUri });
    expect(
      await getDb(env)
        .prepare(
          "SELECT COUNT(*)::int AS count FROM payment_recurring_payment_update_attempts WHERE recurring_payment_id = ?"
        )
        .bind(activated.id)
        .first<{ count: number }>()
    ).toEqual({ count: 1 });
  });

  // SOLA9-791: moving the due date under a submitted collection would strand
  // it, since its finalizer and recovery key on that due date.
  it("lets a collection claim win over a concurrent same-wallet schedule change", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });

    const collectionClaimed = deferred<void>();
    const collectionReleased = deferred<void>();
    let collectPromise: Promise<Response> | undefined;
    let updateRes: Response | undefined;
    try {
      ({ paused: updateRes } = await updateAroundPausedClaim({
        recurringPaymentId: activated.id,
        body: {
          metadataUri: "https://example.com/recurring/moved.json",
          nextCollectionDueAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        },
        during: async () => {
          createOrgSignerForCustodyWalletMock.mockImplementationOnce(async () => {
            collectionClaimed.resolve();
            await collectionReleased.promise;
            return sourceSigner;
          });
          collectPromise = Promise.resolve(
            app.request(
              `/v1/payments/recurring-payments/${activated.id}/collect`,
              { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
              env
            )
          );
          await collectionClaimed.promise;
        },
      }));
    } finally {
      collectionReleased.resolve();
    }
    const collectRes = await required(collectPromise);

    expect(updateRes.status).toBe(409);
    expect(collectRes.status).toBe(200);
    expect(
      await getDb(env)
        .prepare(
          `SELECT status
             FROM payment_subscription_collection_attempts
            WHERE subscription_id = ? AND due_at = ?`
        )
        .bind(activated.subscriptionId, dueAt)
        .first<{ status: string }>()
    ).toEqual({ status: "confirmed" });
    expect(
      await getDb(env)
        .prepare(
          "SELECT COUNT(*)::int AS count FROM payment_recurring_payment_update_attempts WHERE recurring_payment_id = ?"
        )
        .bind(activated.id)
        .first<{ count: number }>()
    ).toEqual({ count: 0 });
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
  });

  // SOLA9-751: a recovered source change signs on the new wallet before it
  // cancels on the old one, so a key that cannot cancel there stops first.
  it("refuses recovering a stale source change for a key outside the old wallet, before any new-wallet step", async () => {
    await seedUnboundWallet();
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const before = {
      sourceCustodyWalletId: activated.sourceCustodyWalletId,
      counterpartyId: activated.counterpartyId,
      counterpartyAccountId: activated.counterpartyAccountId,
      token: activated.token,
      amount: activated.amount,
      periodHours: activated.periodHours,
      firstCollectionAt: activated.firstCollectionAt,
      nextCollectionDueAt: activated.nextCollectionDueAt,
      metadataUri: activated.metadataUri,
    };
    await getDb(env)
      .prepare(
        "UPDATE payment_recurring_payments SET status = 'updating', updated_at = ? WHERE id = ?"
      )
      .bind(staleAt, activated.id)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_update_attempts (
           id, organization_id, project_id, recurring_payment_id, mode, status, stage,
           old_plan_id, old_subscription_id, new_source_custody_wallet_id, changed_fields,
           before_values, after_values, created_at, updated_at
         ) VALUES (
           'prpu_stale_source_change', ?, ?, ?, 'replacement', 'processing', 'claim', ?, ?, ?,
           ARRAY['sourceCustodyWalletId']::text[], ?::jsonb, ?::jsonb, ?, ?
         )`
      )
      .bind(
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.id,
        activated.planId,
        activated.subscriptionId,
        UNBOUND_CUSTODY_WALLET_ID,
        JSON.stringify(before),
        JSON.stringify({ ...before, sourceCustodyWalletId: UNBOUND_CUSTODY_WALLET_ID }),
        staleAt,
        staleAt
      )
      .run();
    // The key may sign with the new wallet only.
    await bindApiKeyToWallet(UNBOUND_CUSTODY_WALLET_ID);
    const snapshot = await recurringExecutionSnapshot(activated.id);
    const executionCalls = recurringExecutionCallCounts();

    const response = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers: RECURRING_HEADERS,
        body: JSON.stringify({ sourceCustodyWalletId: UNBOUND_CUSTODY_WALLET_ID }),
      },
      env
    );

    await expectWalletOutOfScope(response);
    expect(await recurringExecutionSnapshot(activated.id)).toEqual(snapshot);
    expect(recurringExecutionCallCounts()).toEqual(executionCalls);
  });

  it("rejects fresh in-flight recurring payment updates", async () => {
    const recurringPaymentId = (
      await createRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        headers: RECURRING_HEADERS,
      })
    ).id;
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET status = 'updating' WHERE id = ?")
      .bind(recurringPaymentId)
      .run();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}`,
      {
        method: "PATCH",
        headers: RECURRING_HEADERS,
        body: JSON.stringify({ metadataUri: "https://example.com/recurring/wait.json" }),
      },
      env
    );

    expect(updateRes.status).toBe(409);
    const body = errorResponseSchema.parse(await updateRes.json());
    expect(body.error.message).toContain("already processing");
  });

  it("rejects stale recurring payment update recovery with a different payload", async () => {
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();

    await getDb(env)
      .prepare(
        "UPDATE payment_recurring_payments SET status = 'updating', updated_at = ? WHERE id = ?"
      )
      .bind(staleAt, activated.id)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_update_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           mode,
           status,
           stage,
           old_plan_id,
           old_subscription_id,
           changed_fields,
           before_values,
           after_values,
           created_at,
           updated_at
         ) VALUES (
           'prpu_stale_payload_mismatch',
           ?, ?, ?, 'replacement', 'processing', 'create_plan', ?, ?,
           ARRAY['amount']::text[], ?::jsonb, ?::jsonb, ?, ?
         )`
      )
      .bind(
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.id,
        activated.planId,
        activated.subscriptionId,
        JSON.stringify({ amount: "25.00" }),
        JSON.stringify({ amount: "35.00" }),
        staleAt,
        staleAt
      )
      .run();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers: RECURRING_HEADERS,
        body: JSON.stringify({ amount: "36.00" }),
      },
      env
    );

    expect(updateRes.status).toBe(409);
    const body = errorResponseSchema.parse(await updateRes.json());
    expect(body.error.message).toContain("retry the same update");
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
  });

  it("recovers a stale update whose amount the retry spells differently (30.0 and 30 are one amount)", async () => {
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const before = {
      sourceCustodyWalletId: activated.sourceCustodyWalletId,
      counterpartyId: activated.counterpartyId,
      counterpartyAccountId: activated.counterpartyAccountId,
      token: activated.token,
      amount: activated.amount,
      periodHours: activated.periodHours,
      firstCollectionAt: activated.firstCollectionAt,
      nextCollectionDueAt: activated.nextCollectionDueAt,
      metadataUri: activated.metadataUri,
    };
    await getDb(env)
      .prepare(
        "UPDATE payment_recurring_payments SET status = 'updating', updated_at = ? WHERE id = ?"
      )
      .bind(staleAt, activated.id)
      .run();
    // The crashed edit asked for "30.0".
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_update_attempts (
           id, organization_id, project_id, recurring_payment_id, mode, status, stage,
           old_plan_id, old_subscription_id, changed_fields, before_values, after_values,
           created_at, updated_at
         ) VALUES (
           'prpu_stale_respelled_amount', ?, ?, ?, 'replacement', 'processing', 'claim', ?, ?,
           ARRAY['amount']::text[], ?::jsonb, ?::jsonb, ?, ?
         )`
      )
      .bind(
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.id,
        activated.planId,
        activated.subscriptionId,
        JSON.stringify(before),
        JSON.stringify({ ...before, amount: "30.0" }),
        staleAt,
        staleAt
      )
      .run();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      { method: "PATCH", headers: RECURRING_HEADERS, body: JSON.stringify({ amount: "30" }) },
      env
    );

    expect(updateRes.status).toBe(200);
    expect((await parseRecurringResponse(updateRes)).data.recurringPayment).toMatchObject({
      status: "active",
    });
    const attempt = await getDb(env)
      .prepare("SELECT status FROM payment_recurring_payment_update_attempts WHERE id = ?")
      .bind("prpu_stale_respelled_amount")
      .first<{ status: string }>();
    expect(attempt).toEqual({ status: "confirmed" });
  });

  // HOO-2099: start admission runs only before a fresh update's claim. A
  // recovered update whose saved signature landed only confirms it, so a key
  // that has since lost the wallet still finishes it rather than leaving the
  // mandate paused in `updating`.
  it("confirms a landed stale metadata update after the key loses the wallet", async () => {
    const updatePlanSignature = signature(
      "3agLAsjf2Qba9W59cqxbXFoPRJFDFKB3efqYRhT6wLxaM4KwV31NVrLDjKAw22hR1GFcQc4mePSjZ6XZEHUAjN4c"
    );
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const signaturesBefore = sendTransactionMock.mock.calls.length;
    const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const metadataUri = "https://example.com/recurring/landed.json";
    const before = {
      sourceCustodyWalletId: activated.sourceCustodyWalletId,
      counterpartyId: activated.counterpartyId,
      counterpartyAccountId: activated.counterpartyAccountId,
      token: activated.token,
      amount: activated.amount,
      periodHours: activated.periodHours,
      firstCollectionAt: activated.firstCollectionAt,
      nextCollectionDueAt: activated.nextCollectionDueAt,
      metadataUri: activated.metadataUri,
    };
    await getDb(env)
      .prepare(
        "UPDATE payment_recurring_payments SET status = 'updating', updated_at = ? WHERE id = ?"
      )
      .bind(staleAt, activated.id)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_update_attempts (
           id, organization_id, project_id, recurring_payment_id, mode, status, stage,
           old_plan_id, old_subscription_id, plan_update_signature, changed_fields,
           before_values, after_values, created_at, updated_at
         ) VALUES (
           'prpu_stale_landed_metadata', ?, ?, ?, 'metadata_schedule', 'processing',
           'update_plan', ?, ?, ?, ARRAY['metadataUri']::text[], ?::jsonb, ?::jsonb, ?, ?
         )`
      )
      .bind(
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.id,
        activated.planId,
        activated.subscriptionId,
        updatePlanSignature,
        JSON.stringify(before),
        JSON.stringify({ ...before, metadataUri }),
        staleAt,
        staleAt
      )
      .run();
    // The saved plan update landed: the plan holds the new URI.
    vi.mocked(subscriptionsProgram.fetchMaybePlan).mockResolvedValue(planAccount(metadataUri));
    await seedUnboundWallet();
    await bindApiKeyToWallet(UNBOUND_CUSTODY_WALLET_ID);

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      { method: "PATCH", headers: RECURRING_HEADERS, body: JSON.stringify({ metadataUri }) },
      env
    );

    expect(updateRes.status).toBe(200);
    expect((await parseRecurringResponse(updateRes)).data.recurringPayment).toMatchObject({
      status: "active",
      metadataUri,
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(signaturesBefore);
  });

  it("clamps stale metadata update retries after the subscription period advances", async () => {
    const updatePlanSignature = signature(
      "3agLAsjf2Qba9W59cqxbXFoPRJFDFKB3efqYRhT6wLxaM4KwV31NVrLDjKAw22hR1GFcQc4mePSjZ6XZEHUAjN4c"
    );
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const requestedNextDueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const advancedPeriodStartAt = new Date().toISOString();
    const expectedClampedDueAt = new Date(
      new Date(advancedPeriodStartAt).getTime() + 24 * 60 * 60 * 1000
    ).toISOString();
    const metadataUri = "https://example.com/recurring/recovered.json";
    const updateSnapshotBefore = {
      sourceCustodyWalletId: activated.sourceCustodyWalletId,
      counterpartyId: activated.counterpartyId,
      counterpartyAccountId: activated.counterpartyAccountId,
      token: activated.token,
      amount: activated.amount,
      periodHours: activated.periodHours,
      firstCollectionAt: activated.firstCollectionAt,
      nextCollectionDueAt: activated.nextCollectionDueAt,
      metadataUri: activated.metadataUri,
    };

    await getDb(env)
      .prepare(
        "UPDATE payment_recurring_payments SET status = 'updating', updated_at = ? WHERE id = ?"
      )
      .bind(staleAt, activated.id)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET current_period_start_at = ? WHERE id = ?")
      .bind(advancedPeriodStartAt, activated.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_update_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           mode,
           status,
           stage,
           old_plan_id,
           old_subscription_id,
           plan_update_signature,
           changed_fields,
           before_values,
           after_values,
           created_at,
           updated_at
         ) VALUES (
           'prpu_stale_metadata_schedule_recovery',
           ?, ?, ?, 'metadata_schedule', 'processing', 'update_plan', ?, ?, ?,
           ARRAY['nextCollectionDueAt', 'metadataUri']::text[], ?::jsonb, ?::jsonb, ?, ?
         )`
      )
      .bind(
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.id,
        activated.planId,
        activated.subscriptionId,
        updatePlanSignature,
        JSON.stringify(updateSnapshotBefore),
        JSON.stringify({
          ...updateSnapshotBefore,
          nextCollectionDueAt: requestedNextDueAt,
          metadataUri,
        }),
        staleAt,
        staleAt
      )
      .run();
    // The saved plan update landed: the plan holds the new URI, NUL-padded to its fixed width.
    vi.mocked(subscriptionsProgram.fetchMaybePlan).mockResolvedValue(planAccount(metadataUri));

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers: RECURRING_HEADERS,
        body: JSON.stringify({ metadataUri, nextCollectionDueAt: requestedNextDueAt }),
      },
      env
    );

    expect(updateRes.status).toBe(200);
    const updateBody = await parseRecurringResponse(updateRes);
    expect(updateBody.data.recurringPayment).toMatchObject({
      status: "active",
      metadataUri,
      nextCollectionDueAt: expectedClampedDueAt,
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);

    const event = await getDb(env)
      .prepare(
        `SELECT after_values
           FROM payment_recurring_payment_update_events
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{ after_values: Record<string, unknown> }>();
    expect(event?.after_values.nextCollectionDueAt).toBe(expectedClampedDueAt);
  });

  it("creates the source token account during recurring payment activation when it is missing", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    const recurringPaymentId = (
      await createRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        headers: RECURRING_HEADERS,
      })
    ).id;
    const [expectedSourceAta] = await findAssociatedTokenPda({
      owner: sourceSigner.address,
      tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      mint: address(DEVNET_USDC_MINT),
    });
    getAccountInfoMock.mockImplementation(async (_rpc, accountAddress) =>
      accountAddress === expectedSourceAta
        ? null
        : ({
            lamports: 4200000000n,
            owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          } as Awaited<ReturnType<typeof solanaRpc.getAccountInfo>>)
    );

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      {
        method: "POST",
        headers: RECURRING_HEADERS,
        body: "{}",
      },
      env
    );

    expect(activateRes.status).toBe(200);
    const activateBody = await parseRecurringResponse(activateRes);
    expect(activateBody.data.recurringPayment.status).toBe("active");
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
    const subscriptionRow = await getDb(env)
      .prepare("SELECT subscriber_token_account FROM payment_subscriptions WHERE id = ?")
      .bind(activateBody.data.recurringPayment.subscriptionId)
      .first<{ subscriber_token_account: string | null }>();
    expect(subscriptionRow?.subscriber_token_account).toBe(expectedSourceAta);
  });

  it("cancels active recurring payments through SDP API routes", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(cancelRes.status).toBe(200);
    const cancelBody = await parseRecurringResponse(cancelRes);
    expect(cancelBody.data.recurringPayment).toMatchObject({
      id: activated.id,
      status: "canceled",
    });
    const lifecycleAttempt = await getDb(env)
      .prepare(
        `SELECT operation, status, stage, signature
           FROM payment_recurring_payment_lifecycle_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(activated.id)
      .first<{ operation: string; status: string; stage: string; signature: string | null }>();
    expect(lifecycleAttempt).toMatchObject({
      operation: "cancel",
      status: "confirmed",
      stage: "finalize",
      signature: poolSentSignatures()[2],
    });
    const subscriptionRow = await getDb(env)
      .prepare("SELECT status, cancel_at, canceled_at FROM payment_subscriptions WHERE id = ?")
      .bind(activated.subscriptionId)
      .first<{ status: string; cancel_at: string | null; canceled_at: string | null }>();
    expect(subscriptionRow?.status).toBe("canceled");
    expect(subscriptionRow?.cancel_at).toBeTruthy();
    expect(subscriptionRow?.canceled_at).toBeTruthy();

    const replayRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(replayRes.status).toBe(200);
    const replayBody = await parseRecurringResponse(replayRes);
    expect(replayBody.data.recurringPayment).toMatchObject({
      id: activated.id,
      status: "canceled",
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
  });

  it("cancels an active recurring payment whose issued token was paused after activation", async () => {
    const issuedMint = (await generateKeyPairSigner()).address;
    const issuedTokenId = await seedIssuedTokenMint({
      projectId: TEST_PROJECT.id,
      mintAddress: issuedMint,
      status: "active",
    });
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      token: issuedMint,
    });
    await getDb(env)
      .prepare("UPDATE issued_tokens SET status = 'paused' WHERE id = ?")
      .bind(issuedTokenId)
      .run();

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(cancelRes.status).toBe(200);
    expect((await parseRecurringResponse(cancelRes)).data.recurringPayment).toMatchObject({
      id: activated.id,
      status: "canceled",
    });
    expect(
      await getDb(env)
        .prepare(
          `SELECT status, signature
             FROM payment_recurring_payment_lifecycle_attempts
            WHERE recurring_payment_id = ? AND operation = 'cancel'`
        )
        .bind(activated.id)
        .first<{ status: string; signature: string | null }>()
    ).toEqual({ status: "confirmed", signature: poolSentSignatures()[2] });
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
  });

  it("keeps a cancel whose send outcome is unknown in flight with its signature saved", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    sendTransactionMock.mockRejectedValueOnce(new Error("RPC response lost"));

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(cancelRes.status).toBe(500);
    expect(
      await getDb(env)
        .prepare(
          `SELECT status, signature
             FROM payment_recurring_payment_lifecycle_attempts
            WHERE recurring_payment_id = ?`
        )
        .bind(activated.id)
        .first<{ status: string; signature: string | null }>()
    ).toEqual({ status: "processing", signature: poolSentSignatures()[2] });
    expect((await recurringPaymentDueAt(activated.id)).status).toBe(
      RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS.cancel.processingStatus
    );
  });

  it("cancels pending_activation recurring payments directly without on-chain tx", async () => {
    const recurringPaymentId = (
      await createRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        headers: RECURRING_HEADERS,
      })
    ).id;

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/cancel`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(cancelRes.status).toBe(200);
    const cancelBody = await parseRecurringResponse(cancelRes);
    expect(cancelBody.data.recurringPayment).toMatchObject({
      id: recurringPaymentId,
      status: "canceled",
    });

    const dbRow = await getDb(env)
      .prepare("SELECT status FROM payment_recurring_payments WHERE id = ?")
      .bind(recurringPaymentId)
      .first<{ status: string }>();
    expect(dbRow?.status).toBe("canceled");
  });

  it("resumes canceled recurring payments through SDP API routes", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );
    expect(cancelRes.status).toBe(200);

    const resumeRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/resume`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(resumeRes.status).toBe(200);
    const resumeBody = await parseRecurringResponse(resumeRes);
    expect(resumeBody.data.recurringPayment).toMatchObject({
      id: activated.id,
      status: "active",
    });
    const lifecycleAttempt = await getDb(env)
      .prepare(
        `SELECT operation, status, stage, signature
           FROM payment_recurring_payment_lifecycle_attempts
          WHERE recurring_payment_id = ? AND operation = 'resume'
          ORDER BY created_at DESC`
      )
      .bind(activated.id)
      .first<{ operation: string; status: string; stage: string; signature: string | null }>();
    expect(lifecycleAttempt).toMatchObject({
      operation: "resume",
      status: "confirmed",
      stage: "finalize",
      signature: poolSentSignatures()[3],
    });
    const subscriptionRow = await getDb(env)
      .prepare("SELECT status, cancel_at, canceled_at FROM payment_subscriptions WHERE id = ?")
      .bind(activated.subscriptionId)
      .first<{ status: string; cancel_at: string | null; canceled_at: string | null }>();
    expect(subscriptionRow).toMatchObject({
      status: "active",
      cancel_at: null,
      canceled_at: null,
    });

    const replayRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/resume`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(replayRes.status).toBe(200);
    expect(sendTransactionMock).toHaveBeenCalledTimes(4);
  });

  it.each(PAYMENT_RECURRING_PAYMENT_LIFECYCLE_OPERATIONS)(
    "recovers submitted recurring payment $operation attempts",
    async (operation) => {
      const submittedSignature = signature(
        operation === "cancel"
          ? "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13"
          : "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe"
      );
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      if (operation === "resume") {
        const cancelResponse = await app.request(
          `/v1/payments/recurring-payments/${activated.id}/cancel`,
          { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
          env
        );
        expect(cancelResponse.status).toBe(200);
      }
      const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      const attemptId = `prpl_${crypto.randomUUID()}`;
      const transition = RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS[operation];
      await getDb(env)
        .prepare("UPDATE payment_recurring_payments SET status = ?, updated_at = ? WHERE id = ?")
        .bind(transition.processingStatus, staleUpdatedAt, activated.id)
        .run();
      await getDb(env)
        .prepare(
          `INSERT INTO payment_recurring_payment_lifecycle_attempts (
             id, organization_id, project_id, recurring_payment_id, operation,
             status, stage, signature, metadata, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'processing', 'submit', ?, ?::jsonb, ?, ?)`
        )
        .bind(
          attemptId,
          TEST_ORG.id,
          TEST_PROJECT.id,
          activated.id,
          operation,
          submittedSignature,
          JSON.stringify({}),
          staleUpdatedAt,
          staleUpdatedAt
        )
        .run();
      // The submitted operation landed: a cancel sets the expiry, a resume clears it.
      fetchMaybeSubscriptionDelegationMock.mockResolvedValue(
        delegation(operation === "cancel" ? 1_800_000_000n : 0n)
      );
      confirmTransactionMock.mockClear();

      const response = await app.request(
        `/v1/payments/recurring-payments/${activated.id}/${operation}`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      );

      expect(response.status).toBe(200);
      const body = await parseRecurringResponse(response);
      expect(body.data.recurringPayment.status).toBe(transition.finalStatus);
      expect(sendTransactionMock).toHaveBeenCalledTimes(operation === "cancel" ? 2 : 3);
      // Recovery runs long after the status cache dropped the signature, so the
      // account settles it (HOO-2044); the saved signature is never polled.
      expect(confirmTransactionMock).not.toHaveBeenCalledWith(
        expect.anything(),
        submittedSignature,
        expect.anything()
      );
      const recoveredAttempt = await getDb(env)
        .prepare(
          "SELECT status, stage, signature FROM payment_recurring_payment_lifecycle_attempts WHERE id = ?"
        )
        .bind(attemptId)
        .first<{ status: string; stage: string; signature: string | null }>();
      expect(recoveredAttempt).toMatchObject({
        status: "confirmed",
        stage: "finalize",
        signature: submittedSignature,
      });
    }
  );

  it("cancels future collections while the current collection is processing", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const attemptId = `psca_${crypto.randomUUID()}`;
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });
    await seedRecurringCollectionJournal({
      stage: "claimed",
      attemptId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      collectionDueAt: dueAt,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      attemptedAt: now,
    });

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers: RECURRING_HEADERS,
        body: JSON.stringify({ metadataUri: "https://example.com/recurring/wait.json" }),
      },
      env
    );
    expect(updateRes.status).toBe(409);

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(cancelRes.status).toBe(200);
    const row = await getDb(env)
      .prepare("SELECT status, next_collection_due_at FROM payment_recurring_payments WHERE id = ?")
      .bind(activated.id)
      .first<{ status: string; next_collection_due_at: string }>();
    expect(row).toMatchObject({ status: "canceled", next_collection_due_at: dueAt });
    const attempt = await getDb(env)
      .prepare("SELECT status FROM payment_subscription_collection_attempts WHERE id = ?")
      .bind(attemptId)
      .first<{ status: string }>();
    expect(attempt?.status).toBe("processing");

    const resumeRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/resume`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );
    expect(resumeRes.status).toBe(409);
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
  });

  it("resets recurring payment cancellation claims when subscription validation fails", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET status = 'paused' WHERE id = ?")
      .bind(activated.subscriptionId)
      .run();

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(cancelRes.status).toBe(409);
    const cancelBody = errorResponseSchema.parse(await cancelRes.json());
    expect(cancelBody.error.message).toContain("Subscription cannot be canceled");
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_recurring_payments WHERE id = ?")
      .bind(activated.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");
    const lifecycleAttempt = await getDb(env)
      .prepare(
        `SELECT operation, status, stage, error
           FROM payment_recurring_payment_lifecycle_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(activated.id)
      .first<{ operation: string; status: string; stage: string; error: string | null }>();
    expect(lifecycleAttempt).toMatchObject({
      operation: "cancel",
      status: "failed",
      stage: "claim",
    });
    expect(lifecycleAttempt?.error).toContain("Subscription cannot be canceled");
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
  });

  it("cancels without waiting for confirmed collection finalization", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    const collectionSignature = signature(
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13"
    );
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });
    await seedRecurringCollectionJournal({
      stage: "confirmed",
      attemptId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      collectionDueAt: dueAt,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      attemptedAt: now,
      transfer: {
        id: transferId,
        walletId: TEST_WALLET_ID,
        counterpartyId: activated.counterpartyId,
        sourceAddress: sourceSigner.address,
        destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
        signature: collectionSignature,
      },
    });
    recordSignatureStatus(collectionSignature, null);

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(cancelRes.status).toBe(200);
    const cancelBody = await parseRecurringResponse(cancelRes);
    expect(cancelBody.data.recurringPayment.status).toBe("canceled");
    expect(cancelBody.data.recurringPayment.nextCollectionDueAt).toBe(dueAt);
    const recoveredAttempt = await getDb(env)
      .prepare(
        "SELECT status, signature FROM payment_subscription_collection_attempts WHERE id = ?"
      )
      .bind(attemptId)
      .first<{ status: string; signature: string | null }>();
    expect(recoveredAttempt).toMatchObject({
      status: "confirmed",
      signature: collectionSignature,
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
  });

  it("collects with the exact custody wallet when a Provider wallet ID could select another signer", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    const signAsFeePayerMock = recurringExecution.signAsFeePayerMock();
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    await seedConfigOwnedDuplicateProviderWallet();
    const duplicateProviderWalletSigner = await generateKeyPairSigner();
    createOrgSignerForCustodyWalletMock.mockImplementation(
      async (_signerEnv, _orgId, _projectId, custodyWalletId) =>
        custodyWalletId === TEST_CUSTODY_WALLET_ID ? sourceSigner : duplicateProviderWalletSigner
    );
    const signerCallsBeforeCollection = createOrgSignerForCustodyWalletMock.mock.calls.length;
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });
    const [expectedDestinationAta] = await findAssociatedTokenPda({
      owner: address(TEST_SOLANA_ADDRESSES.wallet2),
      tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      mint: address(DEVNET_USDC_MINT),
    });

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(collectRes.status).toBe(200);
    const collectBody = await parseCollectionResponse(collectRes);
    expect(collectBody.data.recurringPayment).toMatchObject({
      id: activated.id,
      status: "active",
      destinationTokenAccount: expectedDestinationAta,
    });
    if (collectBody.data.recurringPayment.nextCollectionDueAt === null) {
      throw new Error("Collected recurring payment is missing its next due date");
    }
    expect(new Date(collectBody.data.recurringPayment.nextCollectionDueAt).getTime()).toBe(
      new Date(dueAt).getTime() + 24 * 60 * 60 * 1000
    );
    expect(collectBody.data.collectionAttempt).toMatchObject({
      status: "confirmed",
      dueAt,
    });
    expect(collectBody.data.collectionAttempt.signature).toBeTruthy();
    const manualAttempt = await getDb(env)
      .prepare("SELECT metadata FROM payment_subscription_collection_attempts WHERE id = ?")
      .bind(collectBody.data.collectionAttempt.id)
      .first<{ metadata: PaymentSubscriptionCollectionAttemptMetadata }>();
    expect(manualAttempt?.metadata).toMatchObject({
      source: "linked_transfer",
      initialSource: "manual",
      initiatedByKeyId: TEST_API_KEY.id,
    });
    expect(collectBody.data.transfer).toMatchObject({
      id: collectBody.data.collectionAttempt.transferId,
      status: "confirmed",
      signature: collectBody.data.collectionAttempt.signature,
      source: sourceSigner.address,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
    });
    expect(signAsFeePayerMock).toHaveBeenCalledTimes(3);
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
    expect(createOrgSignerForCustodyWalletMock).toHaveBeenCalledWith(
      env,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_CUSTODY_WALLET_ID,
      "recurring.collect"
    );
    expect(
      new Set(
        createOrgSignerForCustodyWalletMock.mock.calls
          .slice(signerCallsBeforeCollection)
          .map(([, , , custodyWalletId]) => custodyWalletId)
      )
    ).toEqual(new Set([TEST_CUSTODY_WALLET_ID]));
    const submission = await getDb(env)
      .prepare(
        `SELECT custody_wallet_id, signed_transaction, last_valid_block_height,
                submission_started_at
           FROM payment_transfers
          WHERE id = ?`
      )
      .bind(collectBody.data.transfer.id)
      .first<{
        custody_wallet_id: string | null;
        signed_transaction: string | null;
        last_valid_block_height: string | null;
        submission_started_at: string | null;
      }>();
    expect(submission).toMatchObject({
      custody_wallet_id: TEST_CUSTODY_WALLET_ID,
      last_valid_block_height: "1000",
    });
    expect(submission?.signed_transaction).toBeTruthy();
    expect(submission?.submission_started_at).toBeTruthy();
  });

  it("admits one collection for two concurrent requests for the same due cycle", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });

    const responses = await Promise.all([
      app.request(
        `/v1/payments/recurring-payments/${activated.id}/collect`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      ),
      app.request(
        `/v1/payments/recurring-payments/${activated.id}/collect`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      ),
    ]);

    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    const counts = await getDb(env)
      .prepare(
        `SELECT
           (SELECT COUNT(*)::int FROM payment_subscription_collection_attempts
             WHERE subscription_id = ? AND due_at = ?) AS attempts,
           (SELECT COUNT(*)::int FROM payment_transfers
             WHERE provider_data->>'recurringPaymentId' = ?) AS transfers`
      )
      .bind(activated.subscriptionId, dueAt, activated.id)
      .first<{ attempts: number; transfers: number }>();
    expect(counts).toEqual({ attempts: 1, transfers: 1 });
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
  });

  it("does not broadcast when the signed collection transfer cannot be journaled", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });
    const createPaymentsRepository = paymentsRepositoryPostgres.createPostgresPaymentsRepository;
    const repositorySpy = vi
      .spyOn(paymentsRepositoryPostgres, "createPostgresPaymentsRepository")
      .mockImplementation((db, scope) => {
        const repository = createPaymentsRepository(db, scope);
        return {
          ...repository,
          persistSignedTransfer: vi.fn(async () => {
            throw new Error("transfer signature write unavailable");
          }),
        };
      });

    const failedResponse = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );
    repositorySpy.mockRestore();

    expect(failedResponse.status).toBe(500);
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
    const unsigned = await getDb(env)
      .prepare(
        `SELECT a.signature AS attempt_signature, t.signature AS transfer_signature
           FROM payment_subscription_collection_attempts a
           JOIN payment_transfers t ON t.id = a.transfer_id
          WHERE a.subscription_id = ? AND a.due_at = ?`
      )
      .bind(activated.subscriptionId, dueAt)
      .first<{ attempt_signature: string | null; transfer_signature: string | null }>();
    expect(unsigned).toEqual({ attempt_signature: null, transfer_signature: null });

    const recoveredResponse = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );
    expect(recoveredResponse.status).toBe(200);
    const recovered = await parseCollectionResponse(recoveredResponse);
    expect(recovered.data.collectionAttempt.status).toBe("confirmed");
    expect(recovered.data.collectionAttempt.signature).toBeTruthy();
    expect(recovered.data.transfer.signature).toBe(recovered.data.collectionAttempt.signature);
  });

  it("rolls back the collection attempt and transfer when linking fails", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });

    const createSubscriptionsRepository =
      paymentSubscriptionsRepositoryPostgres.createPostgresPaymentSubscriptionsRepository;
    const subscriptionsRepositorySpy = vi
      .spyOn(paymentSubscriptionsRepositoryPostgres, "createPostgresPaymentSubscriptionsRepository")
      .mockImplementation((db) => {
        const repository = createSubscriptionsRepository(db);
        return {
          ...repository,
          updateCollectionAttempt: vi.fn(async (input) => {
            if (input.transferId && input.status === "processing") {
              throw new Error("collection attempt link unavailable");
            }
            return repository.updateCollectionAttempt(input);
          }),
        };
      });
    let collectRes: Response;
    try {
      collectRes = await app.request(
        `/v1/payments/recurring-payments/${activated.id}/collect`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      );
    } finally {
      subscriptionsRepositorySpy.mockRestore();
    }

    expect(collectRes.status).toBe(500);
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
    const attempt = await getDb(env)
      .prepare(
        `SELECT status, transfer_id
           FROM payment_subscription_collection_attempts
          WHERE subscription_id = ? AND due_at = ?`
      )
      .bind(activated.subscriptionId, dueAt)
      .first<{ status: string; transfer_id: string | null }>();
    // The attempt, its transfer and the link commit together (HOO-1918): none is left.
    expect(attempt).toBeNull();
    const transfers = await getDb(env)
      .prepare(
        `SELECT COUNT(*)::integer AS count
           FROM payment_transfers
          WHERE organization_id = ?
            AND project_id = ?
            AND provider_data ->> 'recurringPaymentId' = ?`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id, activated.id)
      .first<{ count: number }>();
    expect(transfers?.count).toBe(0);
  });

  it("keeps ambiguous collections processing and recovers them", async () => {
    const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => undefined);
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });
    sendTransactionMock.mockRejectedValueOnce(new Error("RPC response lost"));

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(collectRes.status).toBe(200);
    const collectBody = await parseCollectionResponse(collectRes);
    expect(collectBody.data.collectionAttempt).toMatchObject({ status: "processing" });
    expect(collectBody.data.collectionAttempt.signature).toBeTruthy();
    expect(collectBody.data.transfer).toMatchObject({
      status: "processing",
      signature: collectBody.data.collectionAttempt.signature,
    });
    const recurringPayment = await getDb(env)
      .prepare("SELECT next_collection_due_at FROM payment_recurring_payments WHERE id = ?")
      .bind(activated.id)
      .first<{ next_collection_due_at: string }>();
    expect(recurringPayment?.next_collection_due_at).toBe(dueAt);
    const attempt = await getDb(env)
      .prepare(
        "SELECT status FROM payment_subscription_collection_attempts WHERE subscription_id = ?"
      )
      .bind(activated.subscriptionId)
      .first<{ status: string }>();
    expect(attempt?.status).toBe("processing");
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sdp_api_payment_submission_unresolved",
        flow: "recurring",
        reason: "submission_unconfirmed",
        organization_id: TEST_ORG.id,
        project_id: TEST_PROJECT.id,
        transfer_id: collectBody.data.transfer.id,
        signature: collectBody.data.transfer.signature,
        error: PUBLIC_INTERNAL_ERROR_MESSAGE,
      }),
      "sdp_api_payment_submission_unresolved"
    );

    // Another key never recovers this request's attempt (it would leave that key
    // free to pull the next period); the cron's unkeyed claim can be adopted.
    await clearCollectionAttemptKeys(activated.subscriptionId);
    recordSignatureStatus(poolSentSignatures()[2], null);
    const recoveredRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );
    expect(recoveredRes.status).toBe(200);
    const recoveredBody = await parseCollectionResponse(recoveredRes);
    expect(recoveredBody.data.collectionAttempt).toMatchObject({
      status: "confirmed",
      signature: collectBody.data.collectionAttempt.signature,
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  async function leaveCollectionUnanswered() {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    sendTransactionMock.mockRejectedValueOnce(new Error("RPC response lost"));
    const collect = () =>
      app.request(
        `/v1/payments/recurring-payments/${activated.id}/collect`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      );
    expect((await collect()).status).toBe(200);
    await clearCollectionAttemptKeys(activated.subscriptionId);
    return { subscriptionId: activated.subscriptionId, collect };
  }

  it("fails a recovered collection whose pull has no record past its expiry, then pulls the period again", async () => {
    mockDistinctRecentBlockhashes();
    const { subscriptionId, collect } = await leaveCollectionUnanswered();
    answerChainTip(SAVED_LAST_VALID_BLOCK_HEIGHT + 1);

    const recovered = await collect();

    expect(recovered.status).toBe(200);
    expect(
      (await collectionAttempts(subscriptionId)).map(({ status, error, signature }) => ({
        status,
        error,
        signature,
      }))
    ).toEqual([
      {
        status: "failed",
        error: "Recurring payment collection expired without landing on-chain",
        signature: poolSentSignatures()[2],
      },
      { status: "confirmed", error: null, signature: poolSentSignatures()[3] },
    ]);
  });

  it("refuses to recover a collection whose pull may still land", async () => {
    const { subscriptionId, collect } = await leaveCollectionUnanswered();

    const recovered = await collect();

    expect(recovered.status).toBe(409);
    expect((await collectionAttempts(subscriptionId)).map(({ status }) => status)).toEqual([
      "processing",
    ]);
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
  });

  it("fails a collection when first-attempt preflight proves its account is frozen", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });
    sendTransactionMock.mockRejectedValueOnce(sendTransactionPreflightError(17));

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(collectRes.status).toBe(400);
    const collectBody = errorResponseSchema.parse(await collectRes.json());
    expect(collectBody.error.code).toBe("ACCOUNT_FROZEN");
    const attempt = await getDb(env)
      .prepare(
        "SELECT status, transfer_id FROM payment_subscription_collection_attempts WHERE subscription_id = ?"
      )
      .bind(activated.subscriptionId)
      .first<{ status: string; transfer_id: string | null }>();
    expect(attempt?.status).toBe("failed");
    const transfer = await getDb(env)
      .prepare("SELECT status, signature FROM payment_transfers WHERE id = ?")
      .bind(attempt?.transfer_id)
      .first<{ status: string; signature: string | null }>();
    expect(transfer?.status).toBe("failed");
    expect(transfer?.signature).toBeTruthy();
  });

  it.each(["amount", "transfer_hook_accounts"] as const)(
    "does not advance billing when the confirmed pull %s differ",
    async (mismatch) => {
      const errorLog = vi.spyOn(rootLogger, "error").mockImplementation(() => undefined);
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
      await setRecurringCollectionDue({
        recurringPaymentId: activated.id,
        subscriptionId: activated.subscriptionId,
        dueAt,
      });
      getTransactionMock.mockImplementation(async (_rpc, signature) => {
        const transaction = await recurringCollectionTransactionForSignature({
          signature,
          decimals: 6,
        });
        const instruction = transaction?.instructions[0];
        if (!transaction || !instruction?.data) {
          throw new Error("Expected recurring-payment transfer instruction data");
        }
        const decoded = subscriptionsProgram
          .getTransferSubscriptionInstructionDataDecoder()
          .decode(getBase58Codec().encode(instruction.data));
        const alteredData = subscriptionsProgram
          .getTransferSubscriptionInstructionDataEncoder()
          .encode({
            transferData: {
              ...decoded.transferData,
              amount:
                mismatch === "amount"
                  ? decoded.transferData.amount + 1n
                  : decoded.transferData.amount,
            },
          });
        return {
          ...transaction,
          instructions: [
            {
              ...instruction,
              accounts:
                mismatch === "transfer_hook_accounts"
                  ? [...instruction.accounts, TEST_SOLANA_ADDRESSES.wallet3]
                  : instruction.accounts,
              data: getBase58Codec().decode(alteredData),
            },
          ],
        };
      });

      const collectRes = await app.request(
        `/v1/payments/recurring-payments/${activated.id}/collect`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      );

      expect(collectRes.status).toBe(409);
      const collectBody = errorResponseSchema.parse(await collectRes.json());
      expect(collectBody.error).toMatchObject({ code: "CONFLICT" });
      expect(collectBody.error.message).toContain("does not prove");
      const attempt = await getDb(env)
        .prepare(
          `SELECT id, transfer_id, status, signature, error
           FROM payment_subscription_collection_attempts
          WHERE subscription_id = ? AND due_at = ?`
        )
        .bind(activated.subscriptionId, dueAt)
        .first<{
          id: string;
          transfer_id: string;
          status: string;
          signature: string | null;
          error: string | null;
        }>();
      expect(attempt).toMatchObject({ status: "processing", error: null });
      expect(attempt?.signature).toBeTruthy();
      const transfer = await getDb(env)
        .prepare(
          `SELECT status, signature, signed_transaction, submission_started_at, error
           FROM payment_transfers
          WHERE id = ?`
        )
        .bind(attempt?.transfer_id)
        .first<{
          status: string;
          signature: string | null;
          signed_transaction: string | null;
          submission_started_at: string | null;
          error: string | null;
        }>();
      expect(transfer).toMatchObject({
        status: "processing",
        signature: attempt?.signature,
        error: null,
      });
      expect(transfer?.signed_transaction).toBeTruthy();
      expect(transfer?.submission_started_at).toBeTruthy();
      const recurringPayment = await getDb(env)
        .prepare("SELECT next_collection_due_at FROM payment_recurring_payments WHERE id = ?")
        .bind(activated.id)
        .first<{ next_collection_due_at: string }>();
      expect(recurringPayment?.next_collection_due_at).toBe(dueAt);

      const createSubscriptionsRepository =
        paymentSubscriptionsRepositoryPostgres.createPostgresPaymentSubscriptionsRepository;
      const updateCollectionAttempt = vi
        .fn()
        .mockRejectedValue(new Error("collection journal unavailable"));
      const subscriptionsRepositorySpy = vi
        .spyOn(
          paymentSubscriptionsRepositoryPostgres,
          "createPostgresPaymentSubscriptionsRepository"
        )
        .mockImplementation((db) => ({
          ...createSubscriptionsRepository(db),
          updateCollectionAttempt,
        }));
      // Recovered as the cron's unkeyed claim: another key never adopts it.
      await clearCollectionAttemptKeys(activated.subscriptionId);
      recordSignatureStatus(poolSentSignatures()[2], null);
      let recoveryRes: Response;
      try {
        recoveryRes = await app.request(
          `/v1/payments/recurring-payments/${activated.id}/collect`,
          { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
          env
        );
      } finally {
        subscriptionsRepositorySpy.mockRestore();
      }
      expect(recoveryRes.status).toBe(409);
      const recoveryBody = errorResponseSchema.parse(await recoveryRes.json());
      expect(recoveryBody.error).toMatchObject({ code: "CONFLICT" });
      expect(recoveryBody.error.message).toContain("does not prove");
      expect(updateCollectionAttempt).toHaveBeenCalledOnce();
      const recoveredAttempt = await getDb(env)
        .prepare(
          "SELECT status, signature, error FROM payment_subscription_collection_attempts WHERE id = ?"
        )
        .bind(attempt?.id)
        .first<{ status: string; signature: string | null; error: string | null }>();
      const recoveredTransfer = await getDb(env)
        .prepare("SELECT status, signature, error FROM payment_transfers WHERE id = ?")
        .bind(attempt?.transfer_id)
        .first<{ status: string; signature: string | null; error: string | null }>();
      expect(recoveredAttempt).toMatchObject({
        status: "processing",
        signature: attempt?.signature,
        error: null,
      });
      expect(recoveredTransfer).toMatchObject({
        status: "processing",
        signature: attempt?.signature,
        error: null,
      });
      expect(sendTransactionMock).toHaveBeenCalledTimes(3);
      const proofMismatchEvents = errorLog.mock.calls.filter(([payload]) => {
        const parsed = recurringPaymentLogEventSchema.safeParse(payload);
        return (
          parsed.success &&
          parsed.data.event === "sdp_api_recurring_payment_collection_proof_mismatch"
        );
      });
      expect(proofMismatchEvents).toHaveLength(2);
      for (const [payload, message] of proofMismatchEvents) {
        expect(payload).toEqual(
          expect.objectContaining({
            event: "sdp_api_recurring_payment_collection_proof_mismatch",
            reason: "on_chain_instruction_mismatch",
            organization_id: TEST_ORG.id,
            project_id: TEST_PROJECT.id,
            recurring_payment_id: activated.id,
            subscription_id: activated.subscriptionId,
            attempt_id: attempt?.id,
            transfer_id: attempt?.transfer_id,
            signature: attempt?.signature,
          })
        );
        expect(message).toBe("sdp_api_recurring_payment_collection_proof_mismatch");
      }
      errorLog.mockRestore();
    }
  );

  it("does not let a delayed authorization preparation overwrite an active subscription", async () => {
    const counterpartyId = await seedCounterparty({
      externalId: `authorization_race_${crypto.randomUUID()}`,
    });
    const repo = createPostgresPaymentSubscriptionsRepository(getDb(env));
    const planId = `psp_${crypto.randomUUID()}`;
    const subscriptionId = `psub_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const trustedTokenAccount = TEST_SOLANA_ADDRESSES.wallet1;
    const delayedTokenAccount = TEST_SOLANA_ADDRESSES.wallet3;

    await repo.createPlan({
      id: planId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      ownerWalletId: TEST_WALLET_ID,
      ownerAddress: TEST_SOLANA_ADDRESSES.wallet1,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      periodHours: 24,
      programPlanId: "1004",
      planPda: null,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      pullerWalletId: null,
      pullerAddress: null,
      metadataUri: null,
      status: "active",
      createdBy: TEST_USER.id,
      createdAt: now,
      updatedAt: now,
    });
    await repo.createSubscription({
      id: subscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      planId,
      counterpartyId,
      subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
      subscriberTokenAccount: null,
      subscriptionPda: null,
      subscriptionAuthorityAddress: null,
      authorizationSignature: null,
      status: "pending_authorization",
      currentPeriodStartAt: null,
      nextCollectionDueAt: null,
      createdBy: TEST_USER.id,
      createdAt: now,
      updatedAt: now,
    });

    let releaseMintLookup: (() => void) | undefined;
    let signalMintLookupReached: (() => void) | undefined;
    const mintLookupReached = new Promise<void>((resolve) => {
      signalMintLookupReached = resolve;
    });
    const mintLookupReleased = new Promise<void>((resolve) => {
      releaseMintLookup = resolve;
    });
    const loadPaymentMint = paymentAmounts.loadPaymentMint;
    const mintLookup = vi
      .spyOn(paymentAmounts, "loadPaymentMint")
      .mockImplementationOnce(async (mint) => {
        if (signalMintLookupReached) signalMintLookupReached();
        await mintLookupReleased;
        return loadPaymentMint(mint);
      });

    const preparePromise = app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-authorization`,
      {
        method: "POST",
        headers: RECURRING_HEADERS,
        body: JSON.stringify({
          expectedSubscriptionAuthorityInitId: "0",
          subscriberTokenAccount: delayedTokenAccount,
          expectedPlanCreatedAt: "1700000000",
        }),
      },
      env
    );

    await mintLookupReached;
    await repo.updateSubscription({
      subscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      subscriberTokenAccount: trustedTokenAccount,
      status: "active",
      currentPeriodStartAt: now,
      nextCollectionDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (releaseMintLookup) {
      releaseMintLookup();
    }

    const prepareRes = await preparePromise;
    mintLookup.mockRestore();
    expect(prepareRes.status).toBe(409);
    const persisted = await repo.getSubscriptionById({
      subscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
    });
    expect(persisted).toMatchObject({
      status: "active",
      subscriber_token_account: trustedTokenAccount,
    });
  });

  it.each(
    RECURRING_PAYMENT_STATUSES_WITH_RECOVERABLE_COLLECTION.filter(
      (status) => !isCollectableRecurringPaymentStatus(status)
    )
  )(
    "finalizes recovered recurring payment collections while recurring payment is %s",
    async (recurringPaymentStatus) => {
      const sourceSigner = recurringExecution.sourceSigner();
      const submittedSignature = signature(
        "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13"
      );
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const mintAdmission = vi
        .spyOn(paymentAmounts, "loadPaymentMint")
        .mockRejectedValue(
          badRequest("Payments do not support the InterestBearingConfig mint extension")
        );
      onTestFinished(() => mintAdmission.mockRestore());
      const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
      const now = new Date().toISOString();
      const staleAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      const transferId = `xfr_${crypto.randomUUID()}`;
      const attemptId = `psca_${crypto.randomUUID()}`;
      await setRecurringCollectionDue({
        recurringPaymentId: activated.id,
        subscriptionId: activated.subscriptionId,
        dueAt,
      });
      await getDb(env)
        .prepare("UPDATE payment_recurring_payments SET status = ? WHERE id = ?")
        .bind(recurringPaymentStatus, activated.id)
        .run();
      await getDb(env)
        .prepare(
          `UPDATE payment_subscriptions
            SET status = ?,
                canceled_at = ?
          WHERE id = ?`
        )
        .bind(
          recurringPaymentStatus === "canceled" ? "canceled" : "active",
          recurringPaymentStatus === "canceled" ? now : null,
          activated.subscriptionId
        )
        .run();
      if (recurringPaymentStatus === "canceling") {
        await getDb(env)
          .prepare(
            `INSERT INTO payment_recurring_payment_lifecycle_attempts (
               id, organization_id, project_id, recurring_payment_id, operation,
               status, stage, signature, error, metadata, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'cancel', 'processing', 'claim', NULL, NULL, '{}'::jsonb, ?, ?)`
          )
          .bind(
            `prpla_${crypto.randomUUID()}`,
            TEST_ORG.id,
            TEST_PROJECT.id,
            activated.id,
            now,
            now
          )
          .run();
      }
      await seedRecurringCollectionJournal({
        stage: "submitted",
        attemptId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        recurringPaymentId: activated.id,
        subscriptionId: activated.subscriptionId,
        collectionDueAt: dueAt,
        token: DEVNET_USDC_MINT,
        amount: "25.00",
        attemptedAt: staleAt,
        transfer: {
          id: transferId,
          walletId: TEST_WALLET_ID,
          counterpartyId: activated.counterpartyId,
          sourceAddress: sourceSigner.address,
          destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
          signature: submittedSignature,
        },
      });

      recordSignatureStatus(submittedSignature, null);
      getTransactionMock.mockResolvedValueOnce(null);
      const uncertainRes = await app.request(
        `/v1/payments/recurring-payments/${activated.id}/collect`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      );
      expect(uncertainRes.status).toBe(502);
      const uncertainAttempt = await getDb(env)
        .prepare(
          `SELECT status, signature, updated_at
           FROM payment_subscription_collection_attempts
          WHERE id = ?`
        )
        .bind(attemptId)
        .first<{ status: string; signature: string | null; updated_at: string }>();
      expect(uncertainAttempt).toMatchObject({
        status: "processing",
        signature: submittedSignature,
      });
      expect(new Date(uncertainAttempt?.updated_at ?? 0).getTime()).toBeGreaterThan(
        new Date(staleAt).getTime()
      );

      // The first request adopted the journal's attempt; another key never
      // recovers it, so the attempt goes back to the cron's unkeyed claim.
      await clearCollectionAttemptKeys(activated.subscriptionId);
      const collectRes = await app.request(
        `/v1/payments/recurring-payments/${activated.id}/collect`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      );

      expect(collectRes.status).toBe(200);
      const collectBody = await parseCollectionResponse(collectRes);
      expect(collectBody.data.recurringPayment.status).toBe(recurringPaymentStatus);
      if (collectBody.data.recurringPayment.nextCollectionDueAt === null) {
        throw new Error("Recovered recurring payment is missing its next due date");
      }
      expect(new Date(collectBody.data.recurringPayment.nextCollectionDueAt).getTime()).toBe(
        new Date(dueAt).getTime()
      );
      expect(collectBody.data.collectionAttempt).toMatchObject({
        id: attemptId,
        status: "confirmed",
        signature: submittedSignature,
      });
      expect(collectBody.data.transfer).toMatchObject({
        id: transferId,
        status: "confirmed",
        signature: submittedSignature,
      });
      expect(mintAdmission).not.toHaveBeenCalled();
      expect(sendTransactionMock).toHaveBeenCalledTimes(2);
    }
  );

  it("retries recurring payment collection after pre-submission crash", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const staleAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const attemptId = `psca_${crypto.randomUUID()}`;
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });
    await seedRecurringCollectionJournal({
      stage: "claimed",
      attemptId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      collectionDueAt: dueAt,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      attemptedAt: staleAt,
    });

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(collectRes.status).toBe(200);
    const collectBody = await parseCollectionResponse(collectRes);
    expect(collectBody.data.collectionAttempt).toMatchObject({
      status: "confirmed",
    });
    expect(collectBody.data.collectionAttempt.signature).toBeTruthy();
    expect(collectBody.data.collectionAttempt.id).not.toBe(attemptId);
    expect(collectBody.data.transfer).toMatchObject({
      status: "confirmed",
      signature: collectBody.data.collectionAttempt.signature,
    });
    const staleAttempt = await getDb(env)
      .prepare(
        `SELECT status, error, metadata
           FROM payment_subscription_collection_attempts
          WHERE id = ?`
      )
      .bind(attemptId)
      .first<{ status: string; error: string | null; metadata: { retryAfterAt?: string } }>();
    expect(staleAttempt?.status).toBe("failed");
    expect(staleAttempt?.error).toBe(PUBLIC_INTERNAL_ERROR_MESSAGE);
    expect(staleAttempt?.metadata.retryAfterAt).toBeTruthy();
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
  });

  it("does not fail fresh transferless recurring payment attempts during recovery", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const attemptId = `psca_${crypto.randomUUID()}`;
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });
    await seedRecurringCollectionJournal({
      stage: "claimed",
      attemptId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      collectionDueAt: dueAt,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      attemptedAt: now,
    });

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(collectRes.status).toBe(409);
    const attempt = await getDb(env)
      .prepare(
        `SELECT status, transfer_id, error
           FROM payment_subscription_collection_attempts
          WHERE id = ?`
      )
      .bind(attemptId)
      .first<{ status: string; transfer_id: string | null; error: string | null }>();
    expect(attempt).toMatchObject({
      status: "processing",
      transfer_id: null,
      error: null,
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
  });

  it("does not fail fresh unsigned recurring payment transfers during recovery", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id,
           organization_id,
           project_id,
           wallet_id,
           counterparty_id,
           source_address,
           destination_address,
           token,
           amount,
           memo,
           type,
           direction,
           status,
           provider_data,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, (SELECT counterparty_id FROM payment_recurring_payments WHERE id = ?), ?, ?, ?, ?, NULL, ?, ?, ?, ?::jsonb, NULL, ?, ?)`
      )
      .bind(
        transferId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        activated.id,
        sourceSigner.address,
        TEST_SOLANA_ADDRESSES.wallet2,
        DEVNET_USDC_MINT,
        "25.00",
        "transfer",
        "outbound",
        "processing",
        JSON.stringify({
          recurringPaymentId: activated.id,
          subscriptionId: activated.subscriptionId,
          collectionDueAt: dueAt,
        }),
        now,
        now
      )
      .run();
    await seedRecurringCollectionJournal({
      stage: "claimed",
      attemptId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      collectionDueAt: dueAt,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      attemptedAt: now,
    });
    await getDb(env)
      .prepare("UPDATE payment_subscription_collection_attempts SET transfer_id = ? WHERE id = ?")
      .bind(transferId, attemptId)
      .run();

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(collectRes.status).toBe(409);
    const attempt = await getDb(env)
      .prepare(
        `SELECT status, signature, error
           FROM payment_subscription_collection_attempts
          WHERE id = ?`
      )
      .bind(attemptId)
      .first<{ status: string; signature: string | null; error: string | null }>();
    expect(attempt).toMatchObject({
      status: "processing",
      signature: null,
      error: null,
    });
    const transfer = await getDb(env)
      .prepare("SELECT status, signature, error FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{ status: string; signature: string | null; error: string | null }>();
    expect(transfer).toMatchObject({
      status: "processing",
      signature: null,
      error: null,
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
  });

  it("journals failed recovered recurring payment collection attempts and allows retry", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    const submittedSignature = signature(
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13"
    );
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });
    await seedRecurringCollectionJournal({
      stage: "submitted",
      attemptId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      collectionDueAt: dueAt,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      attemptedAt: now,
      transfer: {
        id: transferId,
        walletId: TEST_WALLET_ID,
        counterpartyId: activated.counterpartyId,
        sourceAddress: sourceSigner.address,
        destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
        signature: submittedSignature,
      },
    });
    recordSignatureStatus(submittedSignature, { InstructionError: [0, { Custom: 1 }] });

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(collectRes.status).toBe(200);
    const collectBody = await parseCollectionResponse(collectRes);
    const failedAttempt = await getDb(env)
      .prepare(
        `SELECT status, error, metadata
           FROM payment_subscription_collection_attempts
          WHERE id = ?`
      )
      .bind(attemptId)
      .first<{ status: string; error: string | null; metadata: { retryAfterAt?: string } }>();
    expect(failedAttempt?.status).toBe("failed");
    expect(failedAttempt?.error).toContain("collection failed on-chain");
    expect(failedAttempt?.metadata.retryAfterAt).toBeTruthy();
    const failedTransfer = await getDb(env)
      .prepare("SELECT status, error, signature FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{ status: string; error: string | null; signature: string | null }>();
    expect(failedTransfer).toMatchObject({
      status: "failed",
      signature: submittedSignature,
    });
    expect(failedTransfer?.error).toContain("collection failed on-chain");
    expect(collectBody.data.collectionAttempt).toMatchObject({
      status: "confirmed",
    });
    expect(collectBody.data.collectionAttempt.signature).toBeTruthy();
    expect(collectBody.data.collectionAttempt.id).not.toBe(attemptId);
    expect(collectBody.data.transfer).toMatchObject({
      status: "confirmed",
      signature: collectBody.data.collectionAttempt.signature,
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
  });

  it.each(SUCCESSFUL_PAYMENT_TRANSFER_STATUSES)(
    "recovers %s collection transfers without reopening the due period",
    async (transferStatus) => {
      const sourceSigner = recurringExecution.sourceSigner();
      const submittedSignature = signature(
        "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13"
      );
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
      const now = new Date().toISOString();
      const transferId = `xfr_${crypto.randomUUID()}`;
      const attemptId = `psca_${crypto.randomUUID()}`;
      await setRecurringCollectionDue({
        recurringPaymentId: activated.id,
        subscriptionId: activated.subscriptionId,
        dueAt,
      });
      await seedRecurringCollectionJournal({
        stage: "submitted",
        attemptId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        recurringPaymentId: activated.id,
        subscriptionId: activated.subscriptionId,
        collectionDueAt: dueAt,
        token: DEVNET_USDC_MINT,
        amount: "25.00",
        attemptedAt: now,
        transfer: {
          id: transferId,
          walletId: TEST_WALLET_ID,
          counterpartyId: activated.counterpartyId,
          sourceAddress: sourceSigner.address,
          destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
          signature: submittedSignature,
        },
      });
      await getDb(env)
        .prepare("UPDATE payment_transfers SET status = ? WHERE id = ?")
        .bind(transferStatus, transferId)
        .run();
      recordSignatureStatus(submittedSignature, null);
      const collectRes = await app.request(
        `/v1/payments/recurring-payments/${activated.id}/collect`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      );

      expect(collectRes.status).toBe(200);
      const collectBody = await parseCollectionResponse(collectRes);
      expect(collectBody.data.collectionAttempt).toMatchObject({
        id: attemptId,
        status: "confirmed",
        signature: submittedSignature,
      });
      expect(collectBody.data.transfer).toMatchObject({
        id: transferId,
        status: transferStatus,
        signature: submittedSignature,
      });
      if (collectBody.data.recurringPayment.nextCollectionDueAt === null) {
        throw new Error("Recovered recurring payment is missing its next collection due date");
      }
      expect(new Date(collectBody.data.recurringPayment.nextCollectionDueAt).getTime()).toBe(
        new Date(dueAt).getTime() + 24 * 60 * 60 * 1000
      );
      const attempt = await getDb(env)
        .prepare("SELECT status, error FROM payment_subscription_collection_attempts WHERE id = ?")
        .bind(attemptId)
        .first<{ status: string; error: string | null }>();
      expect(attempt).toMatchObject({ status: "confirmed", error: null });
      expect(sendTransactionMock).toHaveBeenCalledTimes(2);
    }
  );

  it("rejects early recurring payment collection", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(collectRes.status).toBe(400);
    const collectBody = errorResponseSchema.parse(await collectRes.json());
    expect(collectBody.error.message).toContain("not due yet");
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
    const attempts = await getDb(env)
      .prepare("SELECT id FROM payment_subscription_collection_attempts")
      .all<{ id: string }>();
    expect(attempts.results).toHaveLength(0);
  });

  it("journals failed pre-submission recurring payment collection attempts", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });
    createOrgSignerForCustodyWalletMock.mockRejectedValueOnce(
      new Error("collection signer unavailable")
    );

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(collectRes.status).toBe(500);
    const attempts = await getDb(env)
      .prepare(
        `SELECT status, error, metadata, transfer_id
           FROM payment_subscription_collection_attempts
          WHERE subscription_id = ?`
      )
      .bind(activated.subscriptionId)
      .all<{
        status: string;
        error: string | null;
        metadata: { retryAfterAt?: string };
        transfer_id: string | null;
      }>();
    expect(attempts.results[0]?.status).toBe("failed");
    expect(attempts.results[0]?.error).toBe(PUBLIC_INTERNAL_ERROR_MESSAGE);
    expect(attempts.results[0]?.metadata.retryAfterAt).toBeTruthy();
    expect(attempts.results[0]?.transfer_id).toMatch(/^xfr_/);
    const transfer = await getDb(env)
      .prepare("SELECT status, error, signature FROM payment_transfers WHERE id = ?")
      .bind(attempts.results[0]?.transfer_id)
      .first<{ status: string; error: string | null; signature: string | null }>();
    expect(transfer).toMatchObject({
      status: "failed",
      signature: null,
    });
    expect(transfer?.error).toBe(PUBLIC_INTERNAL_ERROR_MESSAGE);
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
  });

  describe("money admission (HOO-1955)", () => {
    it("skips a deleted organization's due period once, without signing or catching up", async () => {
      const recurringPayment = await activateRecurringPaymentForTest(RECURRING_HEADERS);
      const signaturesBefore = sendTransactionMock.mock.calls.length;
      const now = new Date();
      await setRecurringCollectionDue({
        recurringPaymentId: recurringPayment.id,
        subscriptionId: recurringPayment.subscriptionId,
        dueAt: new Date(now.getTime() - 60 * 1000).toISOString(),
      });
      await deleteTestOrganization();

      expect(await collectDueRecurringPaymentsIn("sandbox", now)).toEqual({
        recovered: 0,
        collected: 0,
        failed: 0,
        skipped: 0,
        refused: 1,
      });
      // The due date moved past now, so the next tick selects nothing.
      expect(
        await collectDueRecurringPaymentsIn("sandbox", new Date(now.getTime() + 60 * 1000))
      ).toEqual({
        recovered: 0,
        collected: 0,
        failed: 0,
        skipped: 0,
        refused: 0,
      });

      expect(sendTransactionMock).toHaveBeenCalledTimes(signaturesBefore);
      const row = await recurringPaymentDueAt(recurringPayment.id);
      expect(row.status).toBe("active");
      expect(row.dueAt).toBeGreaterThan(now.getTime());
      expect(await collectionAttempts(recurringPayment.subscriptionId)).toEqual([
        expect.objectContaining({
          status: "skipped",
          error: "Organization is not active",
          signature: null,
          metadata: expect.objectContaining({ source: "automated" }),
        }),
      ]);
    });

    it("skips a production project's due period once its organization loses production access", async () => {
      const productionWalletId = "cwlt_recurring_production";
      await seedProductionPrivyWallet({
        custodyWalletId: productionWalletId,
        publicKey: recurringExecution.sourceSigner().address,
      });
      await enableMainnetSponsorship();

      const recurringPayment = await activateRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        projectId: TEST_PRODUCTION_PROJECT_ID,
        sourceCustodyWalletId: productionWalletId,
        token: MAINNET_USDC_MINT,
      });
      const signaturesBefore = sendTransactionMock.mock.calls.length;
      const now = new Date();
      await setRecurringCollectionDue({
        recurringPaymentId: recurringPayment.id,
        subscriptionId: recurringPayment.subscriptionId,
        dueAt: new Date(now.getTime() - 60 * 1000).toISOString(),
      });
      await getDb(env)
        .prepare(
          `UPDATE organizations
              SET settings = (settings::jsonb - 'enableProductionProject')::text
            WHERE id = ?`
        )
        .bind(TEST_ORG.id)
        .run();

      expect(await collectDueRecurringPaymentsIn("production", now)).toEqual({
        recovered: 0,
        collected: 0,
        failed: 0,
        skipped: 0,
        refused: 1,
      });

      expect(sendTransactionMock).toHaveBeenCalledTimes(signaturesBefore);
      expect(await collectionAttempts(recurringPayment.subscriptionId)).toEqual([
        expect.objectContaining({
          status: "skipped",
          error: "Production is not enabled for this organization",
          signature: null,
        }),
      ]);
      const row = await recurringPaymentDueAt(recurringPayment.id);
      expect(row.dueAt).toBeGreaterThan(now.getTime());
      const subscription = await getDb(env)
        .prepare("SELECT next_collection_due_at FROM payment_subscriptions WHERE id = ?")
        .bind(recurringPayment.subscriptionId)
        .first<{ next_collection_due_at: string | Date }>();
      expect(new Date(subscription?.next_collection_due_at ?? 0).getTime()).toBe(row.dueAt);
    });

    it("keeps collecting a sandbox project for an organization without production access", async () => {
      const recurringPayment = await activateRecurringPaymentForTest(RECURRING_HEADERS);
      const now = new Date();
      await setRecurringCollectionDue({
        recurringPaymentId: recurringPayment.id,
        subscriptionId: recurringPayment.subscriptionId,
        dueAt: new Date(now.getTime() - 60 * 1000).toISOString(),
      });
      // Drop only the production entitlement; the custody provider override stays.
      await getDb(env)
        .prepare(
          `UPDATE organizations
              SET settings = (settings::jsonb - 'enableProductionProject')::text
            WHERE id = ?`
        )
        .bind(TEST_ORG.id)
        .run();

      expect(await collectDueRecurringPaymentsIn("sandbox", now)).toMatchObject({
        collected: 1,
        refused: 0,
      });
    });

    it("leaves a refused period alone while another collection holds it", async () => {
      const recurringPayment = await activateRecurringPaymentForTest(RECURRING_HEADERS);
      const now = new Date();
      const dueAt = new Date(now.getTime() - 60 * 1000).toISOString();
      await setRecurringCollectionDue({
        recurringPaymentId: recurringPayment.id,
        subscriptionId: recurringPayment.subscriptionId,
        dueAt,
      });
      const [due] = await paymentRecurringPaymentsRepositoryPostgres
        .createPostgresPaymentRecurringPaymentsRepository(getDb(env))
        .listDueCollectionPayments({
          environment: "sandbox",
          dueBefore: now.toISOString(),
          retryBefore: dueAt,
          limit: 10,
        });
      if (due?.id !== recurringPayment.id) {
        throw new Error("Expected the recurring payment to be due");
      }
      // A collector admitted before the deletion has already taken the cycle.
      await createPostgresPaymentSubscriptionsRepository(getDb(env)).createCollectionAttempt({
        id: `psca_${crypto.randomUUID()}`,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        subscriptionId: recurringPayment.subscriptionId,
        transferId: null,
        token: DEVNET_USDC_MINT,
        amount: "25.00",
        dueAt,
        attemptedAt: now.toISOString(),
        status: "processing",
        signature: null,
        error: null,
        metadata: {
          source: "manual",
          recurringPaymentId: recurringPayment.id,
          initiatedByKeyId: null,
        },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      await deleteTestOrganization();

      await expect(
        skipRefusedRecurringCollectionPeriod({
          env,
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT.id,
          recurringPayment: due,
          refusal: new MoneyMovementRefusedError("organization_inactive"),
          now,
        })
      ).resolves.toBe(false);

      expect((await recurringPaymentDueAt(recurringPayment.id)).dueAt).toBe(
        new Date(dueAt).getTime()
      );
      expect(await collectionAttempts(recurringPayment.subscriptionId)).toEqual([
        expect.objectContaining({ status: "processing" }),
      ]);
    });

    it("skips a refused period once when two ticks race", async () => {
      const recurringPayment = await activateRecurringPaymentForTest(RECURRING_HEADERS);
      const now = new Date();
      await setRecurringCollectionDue({
        recurringPaymentId: recurringPayment.id,
        subscriptionId: recurringPayment.subscriptionId,
        dueAt: new Date(now.getTime() - 60 * 1000).toISOString(),
      });
      await deleteTestOrganization();

      const results = await Promise.all([
        collectDueRecurringPaymentsIn("sandbox", now),
        collectDueRecurringPaymentsIn("sandbox", now),
      ]);

      expect(results.reduce((total, result) => total + result.refused, 0)).toBe(1);
      expect(await collectionAttempts(recurringPayment.subscriptionId)).toEqual([
        expect.objectContaining({ status: "skipped" }),
      ]);
    });

    it("refuses a manual collection for a deleted organization without writing an attempt", async () => {
      const recurringPayment = await activateRecurringPaymentForTest(RECURRING_HEADERS);
      const signaturesBefore = sendTransactionMock.mock.calls.length;
      await setRecurringCollectionDue({
        recurringPaymentId: recurringPayment.id,
        subscriptionId: recurringPayment.subscriptionId,
        dueAt: new Date(Date.now() - 60 * 1000).toISOString(),
      });
      deleteTestOrganizationAfterAuth();

      const response = await app.request(
        `/v1/payments/recurring-payments/${recurringPayment.id}/collect`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      );

      expect(response.status).toBe(403);
      expect(sendTransactionMock).toHaveBeenCalledTimes(signaturesBefore);
      expect(await collectionAttempts(recurringPayment.subscriptionId)).toEqual([]);
    });

    it("refuses an activation before claiming it, signing and recording nothing", async () => {
      const recurringPayment = await createRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        headers: RECURRING_HEADERS,
      });
      deleteTestOrganizationAfterAuth();

      const response = await app.request(
        `/v1/payments/recurring-payments/${recurringPayment.id}/activate`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      );

      expect(response.status).toBe(403);
      expect(sendTransactionMock).not.toHaveBeenCalled();
      expect((await recurringPaymentDueAt(recurringPayment.id)).status).toBe("pending_activation");
      const attempt = await getDb(env)
        .prepare(
          "SELECT status, error FROM payment_recurring_payment_activation_attempts WHERE recurring_payment_id = ?"
        )
        .bind(recurringPayment.id)
        .first<{ status: string; error: string | null }>();
      expect(attempt).toBeNull();
    });

    it("refuses a resume before claiming it, leaving it canceled", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const cancelRes = await app.request(
        `/v1/payments/recurring-payments/${activated.id}/cancel`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      );
      expect(cancelRes.status).toBe(200);
      const signaturesBefore = sendTransactionMock.mock.calls.length;
      deleteTestOrganizationAfterAuth();

      const resumeRes = await app.request(
        `/v1/payments/recurring-payments/${activated.id}/resume`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      );

      expect(resumeRes.status).toBe(403);
      expect(sendTransactionMock).toHaveBeenCalledTimes(signaturesBefore);
      expect((await recurringPaymentDueAt(activated.id)).status).toBe("canceled");
      const attempt = await getDb(env)
        .prepare(
          `SELECT status, signature, error
             FROM payment_recurring_payment_lifecycle_attempts
            WHERE recurring_payment_id = ? AND operation = 'resume'`
        )
        .bind(activated.id)
        .first<{ status: string; signature: string | null; error: string | null }>();
      expect(attempt).toBeNull();
    });

    it.each(PAYMENT_RECURRING_PAYMENT_LIFECYCLE_OPERATIONS)(
      "finishes a submitted $operation for a deleted organization without asking",
      async (operation) => {
        const submittedSignature = signature(
          operation === "cancel"
            ? "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13"
            : "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe"
        );
        const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        if (operation === "resume") {
          const cancelResponse = await app.request(
            `/v1/payments/recurring-payments/${activated.id}/cancel`,
            { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
            env
          );
          expect(cancelResponse.status).toBe(200);
        }
        const signaturesBefore = sendTransactionMock.mock.calls.length;
        const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
        const transition = RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS[operation];
        await getDb(env)
          .prepare("UPDATE payment_recurring_payments SET status = ?, updated_at = ? WHERE id = ?")
          .bind(transition.processingStatus, staleUpdatedAt, activated.id)
          .run();
        await getDb(env)
          .prepare(
            `INSERT INTO payment_recurring_payment_lifecycle_attempts (
               id, organization_id, project_id, recurring_payment_id, operation,
               status, stage, signature, metadata, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'processing', 'submit', ?, ?::jsonb, ?, ?)`
          )
          .bind(
            `prpl_${crypto.randomUUID()}`,
            TEST_ORG.id,
            TEST_PROJECT.id,
            activated.id,
            operation,
            submittedSignature,
            JSON.stringify({}),
            staleUpdatedAt,
            staleUpdatedAt
          )
          .run();
        // The submitted operation landed: a cancel sets the expiry, a resume clears it.
        fetchMaybeSubscriptionDelegationMock.mockResolvedValue(
          delegation(operation === "cancel" ? 1_800_000_000n : 0n)
        );
        await deleteTestOrganization();

        expect(await collectDueRecurringPaymentsIn("sandbox", new Date())).toMatchObject({
          recovered: 1,
          refused: 0,
        });
        expect((await recurringPaymentDueAt(activated.id)).status).toBe(transition.finalStatus);
        expect(sendTransactionMock).toHaveBeenCalledTimes(signaturesBefore);
      }
    );
  });

  describe("Production on mainnet-beta (HOO-1620)", () => {
    const PRODUCTION_WALLET_ID = "cwlt_recurring_mainnet";

    async function seedProductionSource(): Promise<void> {
      await seedProductionPrivyWallet({
        custodyWalletId: PRODUCTION_WALLET_ID,
        publicKey: recurringExecution.sourceSigner().address,
      });
      await enableMainnetSponsorship();
    }

    function activateProductionUsdcSchedule() {
      return activateRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        projectId: TEST_PRODUCTION_PROJECT_ID,
        sourceCustodyWalletId: PRODUCTION_WALLET_ID,
        token: "USDC",
      });
    }

    async function automatedCollectionSignature(subscriptionId: string): Promise<string> {
      const attempts = await collectionAttempts(subscriptionId);
      expect(attempts).toEqual([
        expect.objectContaining({
          status: "confirmed",
          metadata: expect.objectContaining({
            source: "linked_transfer",
            initialSource: "automated",
          }),
        }),
      ]);
      const [attempt] = attempts;
      return required(attempt.signature);
    }

    it("stores a Production schedule's USDC as the mainnet mint and activates it on mainnet-beta only", async () => {
      await seedProductionSource();

      const activated = await activateProductionUsdcSchedule();

      expect(activated.token).toBe(MAINNET_USDC_MINT);
      expect(
        recurringExecution.rpc.calls.filter((call) => call.method === "getTokenSupply")
      ).toEqual([]);
      expect(
        new Set(
          [
            ...getAccountInfoMock.mock.calls,
            ...getRecentBlockhashMock.mock.calls,
            ...confirmTransactionMock.mock.calls,
            ...sendTransactionMock.mock.calls,
          ].map(([client]) => clusterOfRpcClient(client))
        )
      ).toEqual(new Set(["mainnet-beta"]));
    });

    it("collects each environment's due schedule on its own cluster in one tick", async () => {
      const sandboxSchedule = await activateRecurringPaymentForTest(RECURRING_HEADERS);
      await seedProductionSource();
      const productionSchedule = await activateProductionUsdcSchedule();
      const now = new Date();
      for (const schedule of [sandboxSchedule, productionSchedule]) {
        await setRecurringCollectionDue({
          recurringPaymentId: schedule.id,
          subscriptionId: schedule.subscriptionId,
          dueAt: new Date(now.getTime() - 60 * 1000).toISOString(),
        });
      }

      const requestsBefore = recurringExecution.rpc.requests.length;
      await runInEachClusterScope(async () => {
        await collectDueRecurringPayments(env, now);
      });

      const tokenSupplyReads = recurringExecution.rpc.requests
        .slice(requestsBefore)
        .filter((request) => request.method === "getTokenSupply");
      expect(tokenSupplyReads).toEqual([]);
      const clustersConfirming = (collectionSignature: string) =>
        new Set(
          confirmTransactionMock.mock.calls
            .filter(([, confirmedSignature]) => confirmedSignature === collectionSignature)
            .map(([client]) => clusterOfRpcClient(client))
        );
      expect(
        clustersConfirming(await automatedCollectionSignature(sandboxSchedule.subscriptionId))
      ).toEqual(new Set(["devnet"]));
      expect(
        clustersConfirming(await automatedCollectionSignature(productionSchedule.subscriptionId))
      ).toEqual(new Set(["mainnet-beta"]));
    });
  });

  it("journals an unresolved automated collection once per cooldown", async () => {
    const recurringPayment = await activateRecurringPaymentForTest(RECURRING_HEADERS);
    const now = new Date();
    const dueAt = new Date(now.getTime() - 60 * 1000).toISOString();
    await setRecurringCollectionDue({
      recurringPaymentId: recurringPayment.id,
      subscriptionId: recurringPayment.subscriptionId,
      dueAt,
    });
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET source_custody_wallet_id = NULL WHERE id = ?")
      .bind(recurringPayment.id)
      .run();

    expect(await collectDueRecurringPaymentsIn("sandbox", now)).toEqual({
      recovered: 0,
      collected: 0,
      failed: 1,
      skipped: 0,
      refused: 0,
    });
    expect(
      await collectDueRecurringPaymentsIn("sandbox", new Date(now.getTime() + 60 * 1000))
    ).toEqual({
      recovered: 0,
      collected: 0,
      failed: 0,
      skipped: 0,
      refused: 0,
    });

    const attempts = await getDb(env)
      .prepare(
        `SELECT status, error, metadata, transfer_id
           FROM payment_subscription_collection_attempts
          WHERE subscription_id = ?`
      )
      .bind(recurringPayment.subscriptionId)
      .all<{
        status: string;
        error: string | null;
        metadata: { initialSource?: string; retryAfterAt?: string };
        transfer_id: string | null;
      }>();
    expect(attempts.results).toEqual([
      expect.objectContaining({
        status: "failed",
        transfer_id: null,
        metadata: expect.objectContaining({
          initialSource: "automated",
          retryAfterAt: expect.any(String),
        }),
      }),
    ]);
    expect(attempts.results[0]?.error).toContain("source wallet is unresolved");
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
  });

  it("journals one automated collection attempt when runtime admission denies the wallet", async () => {
    const recurringPayment = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const now = new Date();
    const dueAt = new Date(now.getTime() - 60 * 1000).toISOString();
    await setRecurringCollectionDue({
      recurringPaymentId: recurringPayment.id,
      subscriptionId: recurringPayment.subscriptionId,
      dueAt,
    });

    let admissionCalls = 0;
    let releaseAdmission!: () => void;
    const bothCollectorsReady = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const admission = vi
      .spyOn(SigningService.prototype, "admitRuntimeExecution")
      .mockImplementation(async () => {
        admissionCalls += 1;
        if (admissionCalls === 2) releaseAdmission();
        await bothCollectorsReady;
        throw new AppError("CONFLICT", "Custody wallet is unavailable", {
          reason: "runtime_execution_unavailable",
        });
      });
    try {
      const runs = await Promise.all([
        collectDueRecurringPaymentsIn("sandbox", now),
        collectDueRecurringPaymentsIn("sandbox", now),
      ]);
      expect(runs).toEqual([
        { recovered: 0, collected: 0, failed: 0, skipped: 1, refused: 0 },
        { recovered: 0, collected: 0, failed: 0, skipped: 1, refused: 0 },
      ]);
      expect(
        await collectDueRecurringPaymentsIn("sandbox", new Date(now.getTime() + 60 * 1000))
      ).toEqual({
        recovered: 0,
        collected: 0,
        failed: 0,
        skipped: 0,
        refused: 0,
      });
      expect(admission).toHaveBeenCalledTimes(2);
    } finally {
      admission.mockRestore();
    }

    const attempts = await getDb(env)
      .prepare(
        `SELECT id, status, error, metadata, transfer_id
           FROM payment_subscription_collection_attempts
          WHERE subscription_id = ?`
      )
      .bind(recurringPayment.subscriptionId)
      .all<{
        id: string;
        status: string;
        error: string | null;
        metadata: { initialSource?: string; retryAfterAt?: string };
        transfer_id: string | null;
      }>();
    expect(attempts.results).toHaveLength(1);
    expect(attempts.results[0]).toMatchObject({
      status: "failed",
      transfer_id: null,
      metadata: { initialSource: "automated" },
    });
    expect(attempts.results[0]?.error).toContain("Custody wallet is unavailable");
    expect(attempts.results[0]?.metadata.retryAfterAt).toBeTruthy();

    const collectionTransfers = await getDb(env)
      .prepare(
        `SELECT COUNT(*)::int AS count
           FROM payment_transfers
          WHERE provider_data->>'recurringPaymentId' = ?`
      )
      .bind(recurringPayment.id)
      .first<{ count: number }>();
    expect(collectionTransfers).toEqual({ count: 0 });
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
  });

  it("journals failed activation attempts and allows activation retry", async () => {
    const recurringPayment = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const createRepository =
      paymentSubscriptionsRepositoryPostgres.createPostgresPaymentSubscriptionsRepository;
    const repositorySpy = vi
      .spyOn(paymentSubscriptionsRepositoryPostgres, "createPostgresPaymentSubscriptionsRepository")
      .mockImplementation((db) => {
        const repository = createRepository(db);
        return {
          ...repository,
          updatePlan: vi.fn(async () => {
            throw new Error("plan PDA write unavailable");
          }),
        };
      });

    const failedRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPayment.id}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );
    repositorySpy.mockRestore();

    expect(failedRes.status).toBe(500);
    const getAfterFailureRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPayment.id}`,
      { headers: RECURRING_HEADERS },
      env
    );
    expect(getAfterFailureRes.status).toBe(200);
    const getAfterFailureBody = await parseRecurringResponse(getAfterFailureRes);
    expect(getAfterFailureBody.data.recurringPayment.status).toBe("pending_activation");

    const attempts = await getDb(env)
      .prepare(
        `SELECT status, stage, error
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(recurringPayment.id)
      .all<{ status: string; stage: string; error: string | null }>();
    expect(attempts.results[0]).toMatchObject({
      status: "failed",
      stage: "create_plan",
    });
    expect(attempts.results[0]?.error).toBe(PUBLIC_INTERNAL_ERROR_MESSAGE);

    const retryRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPayment.id}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(retryRes.status).toBe(200);
    const retryBody = await parseRecurringResponse(retryRes);
    expect(retryBody.data.recurringPayment.status).toBe("active");
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
  });

  it("recovers stale activating recurring payments without recreating the plan", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    const recurringPayment = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const planId = `psp_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_plans (
           id,
           organization_id,
           project_id,
           owner_wallet_id,
           owner_address,
           token,
           amount,
           period_hours,
           program_plan_id,
           status,
           created_by,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        planId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        sourceSigner.address,
        DEVNET_USDC_MINT,
        "25.00",
        24,
        "1001",
        "active",
        TEST_USER.id,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payments
            SET status = 'activating',
                plan_id = ?,
                plan_created_at = ?,
                plan_creation_signature = ?,
                updated_at = ?
          WHERE id = ?`
      )
      .bind(
        planId,
        "1770000000",
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
        now,
        recurringPayment.id
      )
      .run();
    const attemptId = `prpa_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_activation_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           status,
           stage,
           plan_creation_signature,
           authorization_signature,
           error,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        recurringPayment.id,
        "processing",
        "create_plan",
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
        null,
        null,
        "{}",
        now,
        now
      )
      .run();

    const freshRetryRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPayment.id}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );
    expect(freshRetryRes.status).toBe(409);

    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET updated_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 16 * 60 * 1000).toISOString(), recurringPayment.id)
      .run();

    const staleRetryRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPayment.id}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(staleRetryRes.status).toBe(200);
    const staleRetryBody = await parseRecurringResponse(staleRetryRes);
    const [authorizationSignature] = poolSentSignatures();
    expect(staleRetryBody.data.recurringPayment).toMatchObject({
      status: "active",
      authorizationSignature,
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(1);
    const recoveredAttempts = await getDb(env)
      .prepare(
        `SELECT id, status, stage, plan_creation_signature, authorization_signature
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(recurringPayment.id)
      .all<{
        id: string;
        status: string;
        stage: string;
        plan_creation_signature: string | null;
        authorization_signature: string | null;
      }>();
    expect(recoveredAttempts.results).toHaveLength(1);
    expect(recoveredAttempts.results[0]).toMatchObject({
      id: attemptId,
      status: "confirmed",
      stage: "finalize",
      authorization_signature: authorizationSignature,
    });
  });

  it.each([
    { via: "the activate route" },
    // Both signatures exist, so recovery only confirms: admission never asks (HOO-1955).
    { via: "the job for a deleted organization" },
  ])(
    "recovers stale authorized recurring payments without re-confirming old signatures, through $via",
    async ({ via }) => {
      const sourceSigner = recurringExecution.sourceSigner();
      confirmTransactionMock.mockRejectedValue(new Error("transaction history expired"));
      const recurringPayment = await createRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        headers: RECURRING_HEADERS,
      });
      const planId = `psp_${crypto.randomUUID()}`;
      const subscriptionId = `psub_${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      const planCreationSignature = signature(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
      );
      const authorizationSignature = signature(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV"
      );

      await getDb(env)
        .prepare(
          `INSERT INTO payment_subscription_plans (
           id,
           organization_id,
           project_id,
           owner_wallet_id,
           owner_address,
           token,
           amount,
           period_hours,
           program_plan_id,
           status,
           created_by,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          planId,
          TEST_ORG.id,
          TEST_PROJECT.id,
          TEST_WALLET_ID,
          sourceSigner.address,
          DEVNET_USDC_MINT,
          "25.00",
          24,
          "1002",
          "active",
          TEST_USER.id,
          now,
          now
        )
        .run();
      await getDb(env)
        .prepare(
          `INSERT INTO payment_subscriptions (
           id,
           organization_id,
           project_id,
           plan_id,
           counterparty_id,
           subscriber_address,
           authorization_signature,
           status,
           created_by,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          subscriptionId,
          TEST_ORG.id,
          TEST_PROJECT.id,
          planId,
          recurringPayment.counterpartyId,
          sourceSigner.address,
          authorizationSignature,
          "pending_authorization",
          TEST_USER.id,
          now,
          now
        )
        .run();
      await getDb(env)
        .prepare(
          `UPDATE payment_recurring_payments
            SET status = 'activating',
                plan_id = ?,
                subscription_id = ?,
                plan_created_at = ?,
                plan_creation_signature = ?,
                authorization_signature = ?,
                updated_at = ?
          WHERE id = ?`
        )
        .bind(
          planId,
          subscriptionId,
          "1770000000",
          planCreationSignature,
          authorizationSignature,
          staleUpdatedAt,
          recurringPayment.id
        )
        .run();

      if (via === "the activate route") {
        const staleRetryRes = await app.request(
          `/v1/payments/recurring-payments/${recurringPayment.id}/activate`,
          { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
          env
        );

        expect(staleRetryRes.status).toBe(200);
        const staleRetryBody = await parseRecurringResponse(staleRetryRes);
        expect(staleRetryBody.data.recurringPayment).toMatchObject({
          status: "active",
          authorizationSignature,
        });
      } else {
        await deleteTestOrganization();
        expect(await collectDueRecurringPaymentsIn("sandbox", new Date())).toMatchObject({
          recovered: 1,
          refused: 0,
        });
        expect((await recurringPaymentDueAt(recurringPayment.id)).status).toBe("active");
      }
      expect(confirmTransactionMock).not.toHaveBeenCalled();
      expect(sendTransactionMock).not.toHaveBeenCalled();
    }
  );

  it("journals failed on-chain activation attempts and retries with a fresh signature", async () => {
    const _sourceSigner = recurringExecution.sourceSigner();
    mockDistinctRecentBlockhashes();
    confirmTransactionMock
      .mockResolvedValueOnce({
        signature: testSignature(1),
        slot: 100n,
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, "Custom"] },
      })
      .mockResolvedValue({
        signature: testSignature(2),
        slot: 101n,
        confirmationStatus: "confirmed",
        err: null,
      });
    const recurringPayment = await createRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });

    const failedRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPayment.id}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(failedRes.status).toBe(400);
    const getAfterFailureRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPayment.id}`,
      { headers: RECURRING_HEADERS },
      env
    );
    const getAfterFailureBody = await parseRecurringResponse(getAfterFailureRes);
    expect(getAfterFailureBody.data.recurringPayment).toMatchObject({
      status: "pending_activation",
      planCreationSignature: null,
    });

    const attempts = await getDb(env)
      .prepare(
        `SELECT status, stage, error
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(recurringPayment.id)
      .all<{ status: string; stage: string; error: string | null }>();
    expect(attempts.results[0]).toMatchObject({
      status: "failed",
      stage: "create_plan",
      error: "Recurring payment activation failed on-chain",
    });
    // The failed plan never landed, so the retry finds no plan at either commitment.
    vi.mocked(subscriptionsProgram.fetchMaybePlan)
      .mockResolvedValueOnce(noAccount)
      .mockResolvedValueOnce(noAccount);

    const retryRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPayment.id}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(retryRes.status).toBe(200);
    const retryBody = await parseRecurringResponse(retryRes);
    const [failedPlanSignature, retryPlanSignature] = poolSentSignatures();
    expect(retryPlanSignature).not.toBe(failedPlanSignature);
    expect(retryBody.data.recurringPayment).toMatchObject({
      status: "active",
      planCreationSignature: retryPlanSignature,
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
  });

  it("resets an activation whose plan creation is refused at preflight, clearing its saved signature so a retry sends again", async () => {
    mockDistinctRecentBlockhashes();
    const recurringPayment = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    sendTransactionMock.mockRejectedValueOnce(sendTransactionPreflightError(17));
    const activate = () =>
      app.request(
        `/v1/payments/recurring-payments/${recurringPayment.id}/activate`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      );

    const refused = await activate();

    expect(refused.status).toBe(400);
    expect(
      await getDb(env)
        .prepare(
          `SELECT rp.status, rp.plan_creation_signature,
                  a.status AS attempt_status,
                  a.plan_creation_signature AS attempt_plan_creation_signature
             FROM payment_recurring_payments rp
             JOIN payment_recurring_payment_activation_attempts a ON a.recurring_payment_id = rp.id
            WHERE rp.id = ?`
        )
        .bind(recurringPayment.id)
        .first<{
          status: string;
          plan_creation_signature: string | null;
          attempt_status: string;
          attempt_plan_creation_signature: string | null;
        }>()
    ).toEqual({
      status: "pending_activation",
      plan_creation_signature: null,
      attempt_status: "failed",
      attempt_plan_creation_signature: null,
    });
    vi.mocked(subscriptionsProgram.fetchMaybePlan)
      .mockResolvedValueOnce(noAccount)
      .mockResolvedValueOnce(noAccount);

    const retried = await activate();

    expect(retried.status).toBe(200);
    expect((await parseRecurringResponse(retried)).data.recurringPayment).toMatchObject({
      status: "active",
      planCreationSignature: poolSentSignatures()[1],
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(3);
  });

  it("keeps an activation in flight when its saved subscription send fails with no answer", async () => {
    const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    rejectPoolSendAfter(1, new Error("RPC response lost"));

    const response = await app.request(
      `/v1/payments/recurring-payments/${created.id}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(response.status).toBe(500);
    expect(await activationState(created.id)).toEqual({
      status: "activating",
      attempt_status: "processing",
      authorization_signature: poolSentSignatures()[1],
      last_valid_block_height: "1000",
    });
  });

  it("keeps a recovered activation in flight when it fails before reading its saved subscription send", async () => {
    const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    rejectPoolSendAfter(1, new Error("RPC response lost"));
    expect(
      (
        await app.request(
          `/v1/payments/recurring-payments/${created.id}/activate`,
          { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
          env
        )
      ).status
    ).toBe(500);
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET updated_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 16 * 60 * 1000).toISOString(), created.id)
      .run();
    getAccountInfoMock.mockRejectedValueOnce(new Error("RPC unavailable"));

    expect(await collectDueRecurringPaymentsIn("sandbox", new Date())).toMatchObject({
      recovered: 0,
      failed: 1,
    });
    expect(await activationState(created.id)).toEqual({
      status: "activating",
      attempt_status: "processing",
      authorization_signature: poolSentSignatures()[1],
      last_valid_block_height: "1000",
    });
  });

  it("keeps an activation in flight while its sent subscription is not visible, and sends it again once that send expires", async () => {
    mockDistinctRecentBlockhashes();
    fetchMaybeSubscriptionDelegationMock.mockResolvedValueOnce(noAccount);
    const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);

    const unsettled = await app.request(
      `/v1/payments/recurring-payments/${created.id}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(unsettled.status).toBe(409);
    const [, savedAuthorizationSignature] = poolSentSignatures();
    expect(await activationState(created.id)).toEqual({
      status: "activating",
      attempt_status: "processing",
      authorization_signature: savedAuthorizationSignature,
      last_valid_block_height: "1000",
    });

    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET updated_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 16 * 60 * 1000).toISOString(), created.id)
      .run();
    fetchMaybeSubscriptionDelegationMock
      .mockResolvedValueOnce(noAccount)
      .mockResolvedValueOnce(noAccount);
    answerChainTip(SAVED_LAST_VALID_BLOCK_HEIGHT + 1);
    expect(await collectDueRecurringPaymentsIn("sandbox", new Date())).toMatchObject({
      recovered: 1,
    });

    const resentAuthorizationSignature = poolSentSignatures()[2];
    expect(resentAuthorizationSignature).not.toBe(savedAuthorizationSignature);
    expect(await activationState(created.id)).toEqual({
      status: "active",
      attempt_status: "confirmed",
      authorization_signature: resentAuthorizationSignature,
      last_valid_block_height: "1000",
    });
  });

  // A key's wallet scope applies when SDP signs (HOO-2099): writes that sign
  // nothing succeed on any project wallet, and every start is refused before
  // its attempt is claimed.
  it("lets a selected-wallet key edit and cancel a pending mandate on a wallet it cannot sign with, signing nothing", async () => {
    await seedUnboundWallet();
    const payment = await seedPendingRecurringPayment();
    await bindApiKeyToWallet(UNBOUND_CUSTODY_WALLET_ID);
    const executionCalls = recurringExecutionCallCounts();

    const update = await app.request(
      `/v1/payments/recurring-payments/${payment.id}`,
      { method: "PATCH", headers: RECURRING_HEADERS, body: JSON.stringify({ amount: "26.00" }) },
      env
    );
    expect(update.status).toBe(200);
    const cancel = await app.request(
      `/v1/payments/recurring-payments/${payment.id}/cancel`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );
    expect(cancel.status).toBe(200);
    expect(recurringExecutionCallCounts()).toEqual(executionCalls);
  });

  it("refuses activation by a selected-wallet key outside the source wallet, before claiming it", async () => {
    await seedUnboundWallet();
    const payment = await seedPendingRecurringPayment();
    await bindApiKeyToWallet(UNBOUND_CUSTODY_WALLET_ID);
    const before = await recurringExecutionSnapshot(payment.id);
    const executionCalls = recurringExecutionCallCounts();

    const response = await app.request(
      `/v1/payments/recurring-payments/${payment.id}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    await expectWalletOutOfScope(response);
    // Refused before the claim commits, so no activation exists for the job
    // to recover as the mandate: the row is exactly as it was.
    expect(await recurringExecutionSnapshot(payment.id)).toEqual(before);
    const attempts = await getDb(env)
      .prepare(
        "SELECT COUNT(*)::int AS count FROM payment_recurring_payment_activation_attempts WHERE recurring_payment_id = ?"
      )
      .bind(payment.id)
      .first<{ count: number }>();
    expect(attempts).toEqual({ count: 0 });
    expect(recurringExecutionCallCounts()).toEqual(executionCalls);
  });

  // The claim and a revocation are ordered on the key row (HOO-2099): an
  // activation admitted just before its key is revoked must not leave a claim
  // the job would later finish as the mandate.
  it("refuses an activation whose key is revoked between admission and claim", async () => {
    const payment = await seedPendingRecurringPayment();
    const before = await recurringExecutionSnapshot(payment.id);

    const response = await revokeKeyWhileClaiming(
      `/v1/payments/recurring-payments/${payment.id}/activate`
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { details: { reason: "principal_not_live" } },
    });
    expect(await recurringExecutionSnapshot(payment.id)).toEqual(before);
  });

  // A key edit writes the key row under the same lock revocation takes, so the
  // claim decides the narrowed key exactly as the signing waist would.
  it.each([
    {
      change: "loses recurring.execute",
      narrowing: "UPDATE api_keys SET grants = '{recurring.read}' WHERE id = ?",
      error: { code: "INSUFFICIENT_PERMISSIONS", details: { action: "recurring.execute" } },
    },
    {
      change: "loses the source wallet",
      narrowing: "UPDATE api_keys SET wallet_scope = 'selected' WHERE id = ?",
      error: { code: "FORBIDDEN", details: { reason: "wallet_out_of_scope" } },
    },
  ])(
    "refuses an activation whose key $change between admission and claim",
    async ({ narrowing, error }) => {
      const payment = await seedPendingRecurringPayment();
      const before = await recurringExecutionSnapshot(payment.id);

      const response = await revokeKeyWhileClaiming(
        `/v1/payments/recurring-payments/${payment.id}/activate`,
        { method: "POST", body: {} },
        narrowing
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error });
      expect(await recurringExecutionSnapshot(payment.id)).toEqual(before);
    }
  );

  // A member is decided the same way: removal writes the membership row the
  // claim share-locks.
  it("refuses an activation whose member is removed between admission and claim", async () => {
    const payment = await seedPendingRecurringPayment();
    const before = await recurringExecutionSnapshot(payment.id);
    const { headers } = await authenticateTestClerkUser(env, getDb(env), {
      userId: TEST_USER.id,
      email: TEST_USER.email,
      clerkUserId: `clerk_${TEST_USER.id}`,
      organizationId: TEST_ORG.id,
      clerkOrgId: "clerk_org_recurring_member",
      orgSlug: TEST_ORG.slug,
      role: "admin",
    });

    const response = await narrowWhileClaiming({
      path: `/v1/payments/recurring-payments/${payment.id}/activate`,
      init: { method: "POST", body: {} },
      headers: { ...headers(TEST_PROJECT.id), "Content-Type": "application/json" },
      table: "organization_members",
      rowId: TEST_USER.id,
      narrowing: "UPDATE organization_members SET status = 'removed' WHERE user_id = ?",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { details: { reason: "principal_not_live" } },
    });
    expect(await recurringExecutionSnapshot(payment.id)).toEqual(before);
  });

  // SOLA9-790: removal from the project is ordered against the claim too.
  it("refuses an activation whose member is removed from the project between admission and claim", async () => {
    const payment = await seedPendingRecurringPayment();
    const before = await recurringExecutionSnapshot(payment.id);
    const { headers } = await authenticateTestClerkUser(env, getDb(env), {
      userId: TEST_USER.id,
      email: TEST_USER.email,
      clerkUserId: `clerk_${TEST_USER.id}`,
      organizationId: TEST_ORG.id,
      clerkOrgId: "clerk_org_recurring_member",
      orgSlug: TEST_ORG.slug,
      role: "admin",
    });

    const response = await narrowWhileClaiming({
      path: `/v1/payments/recurring-payments/${payment.id}/activate`,
      init: { method: "POST", body: {} },
      headers: { ...headers(TEST_PROJECT.id), "Content-Type": "application/json" },
      table: "project_members",
      rowId: TEST_USER.id,
      narrowing: "DELETE FROM project_members WHERE user_id = ?",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { details: { reason: "principal_not_live" } },
    });
    expect(await recurringExecutionSnapshot(payment.id)).toEqual(before);
  });

  it("refuses a resume whose key is revoked between admission and claim", async () => {
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );
    expect(cancelRes.status).toBe(200);
    const before = await recurringExecutionSnapshot(activated.id);

    const response = await revokeKeyWhileClaiming(
      `/v1/payments/recurring-payments/${activated.id}/resume`
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { details: { reason: "principal_not_live" } },
    });
    expect(await recurringExecutionSnapshot(activated.id)).toEqual(before);
  });

  it("refuses an amount change whose key is revoked between admission and claim", async () => {
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const before = await recurringExecutionSnapshot(activated.id);

    const response = await revokeKeyWhileClaiming(
      `/v1/payments/recurring-payments/${activated.id}`,
      { method: "PATCH", body: { amount: "30.00" } }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { details: { reason: "principal_not_live" } },
    });
    expect(await recurringExecutionSnapshot(activated.id)).toEqual(before);
  });

  it.each([
    {
      route: "collect",
      prepare: (activated: { id: string; subscriptionId: string }) =>
        setRecurringCollectionDue({
          recurringPaymentId: activated.id,
          subscriptionId: activated.subscriptionId,
          dueAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      request: (id: string) => ({
        path: `/v1/payments/recurring-payments/${id}/collect`,
        method: "POST",
        body: {},
      }),
    },
    {
      route: "resume",
      prepare: async (activated: { id: string }) => {
        const canceled = await app.request(
          `/v1/payments/recurring-payments/${activated.id}/cancel`,
          { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
          env
        );
        expect(canceled.status).toBe(200);
      },
      request: (id: string) => ({
        path: `/v1/payments/recurring-payments/${id}/resume`,
        method: "POST",
        body: {},
      }),
    },
    {
      route: "cancel",
      prepare: async () => {},
      request: (id: string) => ({
        path: `/v1/payments/recurring-payments/${id}/cancel`,
        method: "POST",
        body: {},
      }),
    },
    {
      route: "an amount change",
      prepare: async () => {},
      request: (id: string) => ({
        path: `/v1/payments/recurring-payments/${id}`,
        method: "PATCH",
        body: { amount: "99.00" },
      }),
    },
  ])(
    "refuses $route on an active mandate by a selected-wallet key outside its source wallet",
    async ({ prepare, request }) => {
      await seedUnboundWallet();
      const activated = await activateRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        headers: RECURRING_HEADERS,
      });
      await prepare(activated);
      await bindApiKeyToWallet(UNBOUND_CUSTODY_WALLET_ID);
      const before = await recurringExecutionSnapshot(activated.id);
      const executionCalls = recurringExecutionCallCounts();

      const { path, method, body } = request(activated.id);
      const response = await app.request(
        path,
        { method, headers: RECURRING_HEADERS, body: JSON.stringify(body) },
        env
      );

      await expectWalletOutOfScope(response);
      expect(await recurringExecutionSnapshot(activated.id)).toEqual(before);
      expect(recurringExecutionCallCounts()).toEqual(executionCalls);
    }
  );

  // Greptile (#2435): the early refusal must leave the key unstored, so the same
  // request runs once the key's scope is fixed, and cancels exactly once.
  it("runs a refused cancel's same-key retry once the key may sign with the source wallet", async () => {
    await seedUnboundWallet();
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    await bindApiKeyToWallet(UNBOUND_CUSTODY_WALLET_ID);
    const headers = { ...RECURRING_HEADERS, "Idempotency-Key": "cancel-after-scope-fix" };
    const cancel = () =>
      app.request(
        `/v1/payments/recurring-payments/${activated.id}/cancel`,
        { method: "POST", headers, body: "{}" },
        env
      );

    await expectWalletOutOfScope(await cancel());

    await seedCachedKey({ walletScope: "all", walletIds: [] });
    const retried = await cancel();

    expect(retried.status).toBe(200);
    const cancelAttempts = await getDb(env)
      .prepare(
        `SELECT COUNT(*)::int AS count FROM payment_recurring_payment_lifecycle_attempts
          WHERE recurring_payment_id = ? AND operation = 'cancel'`
      )
      .bind(activated.id)
      .first<{ count: number }>();
    expect(cancelAttempts).toEqual({ count: 1 });
  });

  // The compromised-key path (APE-343): revoke-and-cancel finds what the key
  // activated under its own id or one it was rotated from.
  describe("cancel what a revoked key activated", () => {
    async function seedKeyRow(id: string, rotatedFrom: string | null) {
      await getDb(env)
        .prepare(
          `INSERT INTO api_keys
             (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
              grants, status, rotated_from)
           VALUES (?, ?, ?, ?, ?, 'sk_test_x', ?, '{}', 'active', ?)`
        )
        .bind(id, TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id, id, `hash_${id}`, rotatedFrom)
        .run();
    }
    // The revoke route runs inside the project's cluster scope (projectContextMiddleware).
    const cancelFor = (apiKeyId: string) =>
      runInClusterScope({ projectId: TEST_PROJECT.id, environment: "sandbox" }, () =>
        cancelRecurringPaymentsActivatedByKey(env, {
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT.id,
          apiKeyId,
        })
      );
    const statusOf = async (id: string) =>
      (
        await getDb(env)
          .prepare("SELECT status FROM payment_recurring_payments WHERE id = ?")
          .bind(id)
          .first<{ status: string }>()
      )?.status;

    it("cancels a payment the key activated", async () => {
      const activated = await activateRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        headers: RECURRING_HEADERS,
      });

      expect(await cancelFor(TEST_API_KEY.id)).toEqual({ canceled: [activated.id], failed: [] });
      expect(await statusOf(activated.id)).toBe("canceled");
    });

    it("cancels a payment a key's rotated-from predecessor activated", async () => {
      const activated = await activateRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        headers: RECURRING_HEADERS,
      });
      await seedKeyRow("key_recurring_rotated_successor", TEST_API_KEY.id);

      expect(await cancelFor("key_recurring_rotated_successor")).toEqual({
        canceled: [activated.id],
        failed: [],
      });
    });

    it.each(["resuming", "canceling"] as const)(
      "reports one %s as failed, and leaves it",
      async (inFlight) => {
        const activated = await activateRecurringPaymentFixture({
          ...DEFAULT_RECURRING_FIXTURE,
          headers: RECURRING_HEADERS,
        });
        // A resume that has signed but not recorded its result becomes active
        // when it settles; a cancel in flight that fails goes back to active.
        // Either way the revoke must surface it.
        await getDb(env)
          .prepare("UPDATE payment_recurring_payments SET status = ? WHERE id = ?")
          .bind(inFlight, activated.id)
          .run();

        expect(await cancelFor(TEST_API_KEY.id)).toEqual({ canceled: [], failed: [activated.id] });
        expect(await statusOf(activated.id)).toBe(inFlight);
      }
    );

    const activatorOf = async (id: string) =>
      (
        await getDb(env)
          .prepare("SELECT activated_by_api_key_id FROM payment_recurring_payments WHERE id = ?")
          .bind(id)
          .first<{ activated_by_api_key_id: string | null }>()
      )?.activated_by_api_key_id;
    const activatedByAnotherKey = async () => {
      const activated = await activateRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        headers: RECURRING_HEADERS,
      });
      await seedKeyRow("key_recurring_original_activator", null);
      await getDb(env)
        .prepare("UPDATE payment_recurring_payments SET activated_by_api_key_id = ? WHERE id = ?")
        .bind("key_recurring_original_activator", activated.id)
        .run();
      return activated;
    };

    // A change to where or how much money moves re-authorizes the mandate, so
    // the key that made it is the one whose revocation cancels it.
    it("hands the payment to the key that changes its amount", async () => {
      const activated = await activatedByAnotherKey();

      const update = await app.request(
        `/v1/payments/recurring-payments/${activated.id}`,
        { method: "PATCH", headers: RECURRING_HEADERS, body: JSON.stringify({ amount: "30.00" }) },
        env
      );

      expect(update.status).toBe(200);
      expect(await activatorOf(activated.id)).toBe(TEST_API_KEY.id);
      expect(await cancelFor("key_recurring_original_activator")).toEqual({
        canceled: [],
        failed: [],
      });
      expect(await cancelFor(TEST_API_KEY.id)).toEqual({ canceled: [activated.id], failed: [] });
    });

    it("gives the payment back to its activator when the change fails before taking effect", async () => {
      const activated = await activatedByAnotherKey();
      recurringExecution
        .signAsFeePayerMock()
        .mockRejectedValueOnce(new Error("signer unavailable"));

      const update = await app.request(
        `/v1/payments/recurring-payments/${activated.id}`,
        { method: "PATCH", headers: RECURRING_HEADERS, body: JSON.stringify({ amount: "30.00" }) },
        env
      );

      expect(update.status).toBeGreaterThanOrEqual(400);
      expect(await statusOf(activated.id)).toBe("active");
      expect(await activatorOf(activated.id)).toBe("key_recurring_original_activator");
      expect(await cancelFor("key_recurring_original_activator")).toEqual({
        canceled: [activated.id],
        failed: [],
      });
    });

    it("reports a payment whose update by another key is in flight to its previous activator", async () => {
      const activated = await activatedByAnotherKey();
      // Key B has claimed an update: the payment names B, and the attempt
      // keeps the activator it would restore if the update failed.
      await getDb(env)
        .prepare(
          "UPDATE payment_recurring_payments SET status = 'updating', activated_by_api_key_id = ? WHERE id = ?"
        )
        .bind(TEST_API_KEY.id, activated.id)
        .run();
      await getDb(env)
        .prepare(
          `INSERT INTO payment_recurring_payment_update_attempts (
             id, organization_id, project_id, recurring_payment_id, mode, status, stage,
             changed_fields, before_values, after_values, previous_activator, created_at, updated_at
           ) VALUES (
             'prpu_in_flight_handover', ?, ?, ?, 'replacement', 'processing', 'claim',
             ARRAY['amount']::text[], '{}'::jsonb, '{}'::jsonb, ?::jsonb, ?, ?
           )`
        )
        .bind(
          TEST_ORG.id,
          TEST_PROJECT.id,
          activated.id,
          JSON.stringify({ apiKeyId: "key_recurring_original_activator", userId: null }),
          new Date().toISOString(),
          new Date().toISOString()
        )
        .run();

      expect(await cancelFor("key_recurring_original_activator")).toEqual({
        canceled: [],
        failed: [activated.id],
      });
    });

    it("leaves the activator in place on a metadata-only update", async () => {
      const activated = await activatedByAnotherKey();

      const update = await app.request(
        `/v1/payments/recurring-payments/${activated.id}`,
        {
          method: "PATCH",
          headers: RECURRING_HEADERS,
          body: JSON.stringify({ metadataUri: "https://example.com/recurring/renamed.json" }),
        },
        env
      );

      expect(update.status).toBe(200);
      expect(await activatorOf(activated.id)).toBe("key_recurring_original_activator");
    });

    it("cancels nothing for an unrelated key", async () => {
      const activated = await activateRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        headers: RECURRING_HEADERS,
      });
      await seedKeyRow("key_recurring_unrelated", null);

      expect(await cancelFor("key_recurring_unrelated")).toEqual({ canceled: [], failed: [] });
      expect(await statusOf(activated.id)).toBe("active");
    });
  });

  it("refuses moving an active mandate to a wallet outside the key's scope, before claiming it", async () => {
    await seedUnboundWallet();
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    await bindApiKeyToWallet(TEST_CUSTODY_WALLET_ID);
    const before = await recurringExecutionSnapshot(activated.id);
    const executionCalls = recurringExecutionCallCounts();

    const response = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers: RECURRING_HEADERS,
        body: JSON.stringify({ sourceCustodyWalletId: UNBOUND_CUSTODY_WALLET_ID }),
      },
      env
    );

    await expectWalletOutOfScope(response);
    expect(await recurringExecutionSnapshot(activated.id)).toEqual(before);
    expect(recurringExecutionCallCounts()).toEqual(executionCalls);
  });

  it("rejects collection attempt metadata without a source discriminator at the database", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const attemptId = `psca_${crypto.randomUUID()}`;
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });
    await seedRecurringCollectionJournal({
      stage: "claimed",
      attemptId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      collectionDueAt: dueAt,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      attemptedAt: new Date().toISOString(),
    });

    await expect(
      getDb(env)
        .prepare(
          "UPDATE payment_subscription_collection_attempts SET metadata = '{}'::jsonb WHERE id = ?"
        )
        .bind(attemptId)
        .run()
    ).rejects.toThrow(/payment_subscription_collection_attempts_metadata_source_check/);
  });

  describe("Idempotency-Key re-entrancy (HOO-1918)", () => {
    const keyed = (key: string) => ({ ...RECURRING_HEADERS, "Idempotency-Key": key });
    /** What the domain rows store for a key: bound to the test API key (ADR 0009). */
    const recordKey = (key: string) =>
      deriveIdempotencyRecordKey(
        { organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id, principal: TEST_API_KEY.id },
        key
      );
    const errorCode = async (response: Response) =>
      z.object({ error: z.object({ code: z.string() }) }).parse(await response.json()).error.code;
    const actionPath = (id: string, action?: string) =>
      action === undefined
        ? `/v1/payments/recurring-payments/${id}`
        : `/v1/payments/recurring-payments/${id}/${action}`;

    it.each(["activate", "resume", "collect", "update", "update_same_source"] as const)(
      "refuses %s from a specialized wallet before claiming its key",
      async (action) => {
        const schedule =
          action === "activate"
            ? await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE)
            : await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        if (action === "resume") {
          const canceled = await app.request(
            actionPath(schedule.id, "cancel"),
            { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
            env
          );
          expect(canceled.status).toBe(200);
        }
        await getDb(env)
          .prepare("UPDATE custody_wallets SET purpose = 'dvp_settlement_authority' WHERE id = ?")
          .bind(TEST_CUSTODY_WALLET_ID)
          .run();
        const key = crypto.randomUUID();
        const updating = action === "update" || action === "update_same_source";
        const signerCalls = createOrgSignerForCustodyWalletMock.mock.calls.length;
        const response = await app.request(
          actionPath(schedule.id, updating ? undefined : action),
          {
            method: updating ? "PATCH" : "POST",
            headers: keyed(key),
            body: JSON.stringify(
              action === "update_same_source"
                ? { sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID, amount: "30.00" }
                : updating
                  ? { amount: "30.00" }
                  : {}
            ),
          },
          env
        );
        expect(response.status).toBe(403);
        expect(await errorCode(response)).toBe("FORBIDDEN");
        expect(await storedKeyCount(key)).toBe(0);
        expect(createOrgSignerForCustodyWalletMock).toHaveBeenCalledTimes(signerCalls);
      }
    );

    it("cancels an active schedule from a specialized wallet, signing the exit", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      await getDb(env)
        .prepare("UPDATE custody_wallets SET purpose = 'dvp_settlement_authority' WHERE id = ?")
        .bind(TEST_CUSTODY_WALLET_ID)
        .run();

      const response = await app.request(
        actionPath(activated.id, "cancel"),
        { method: "POST", headers: keyed(crypto.randomUUID()), body: "{}" },
        env
      );

      expect(response.status).toBe(200);
      expect((await parseRecurringResponse(response)).data.recurringPayment).toMatchObject({
        id: activated.id,
        status: "canceled",
      });
      expect(createOrgSignerForCustodyWalletMock).toHaveBeenLastCalledWith(
        env,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_CUSTODY_WALLET_ID,
        "recurring.cancel"
      );
    });

    /** The original request crashed after its effects: its key is in progress, its lease lapsed. */
    async function crashIdempotencyKey(key: string) {
      await getDb(env)
        .prepare(
          `UPDATE idempotency_keys
              SET status = 'in_progress',
                  claim_token = 'crashed',
                  locked_until = now() - interval '1 minute',
                  -- Past the renewal cap plus the lease too, so the claim counts as dead.
                  claimed_at = now() - interval '1 hour',
                  response_status = NULL,
                  response_headers = NULL,
                  response_body = NULL
            WHERE idempotency_key = ?`
        )
        .bind(key)
        .run();
    }

    /** The key's shared record is past its 24 hours; only the attempt row remembers it. */
    async function forgetIdempotencyKey(key: string) {
      await getDb(env)
        .prepare("DELETE FROM idempotency_keys WHERE idempotency_key = ?")
        .bind(key)
        .run();
    }

    /** Puts the schedule back mid-transition (not stale) and its keyed attempt in flight. */
    async function leaveMidTransition(input: {
      recurringPaymentId: string;
      status: string;
      attemptTable: string;
      key: string;
    }) {
      const now = new Date().toISOString();
      await getDb(env)
        .prepare("UPDATE payment_recurring_payments SET status = ?, updated_at = ? WHERE id = ?")
        .bind(input.status, now, input.recurringPaymentId)
        .run();
      const updated = await getDb(env)
        .prepare(
          `UPDATE ${input.attemptTable} SET status = 'processing', updated_at = ? WHERE idempotency_key = ?`
        )
        .bind(now, recordKey(input.key))
        .run();
      expect(updated).toBe(1);
    }

    it("answers an activate takeover from its attempt while the schedule is activating", async () => {
      const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const key = crypto.randomUUID();
      const request = () =>
        app.request(
          actionPath(created.id, "activate"),
          { method: "POST", headers: keyed(key), body: "{}" },
          env
        );
      expect((await request()).status).toBe(200);
      await leaveMidTransition({
        recurringPaymentId: created.id,
        status: "activating",
        attemptTable: "payment_recurring_payment_activation_attempts",
        key,
      });
      await crashIdempotencyKey(key);
      const sendsBefore = sendTransactionMock.mock.calls.length;

      const retry = await request();

      expect(retry.status).toBe(200);
      expect((await parseRecurringResponse(retry)).data.recurringPayment).toMatchObject({
        id: created.id,
        status: "activating",
      });
      expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);
    });

    it("answers a cancel takeover from its attempt while the schedule is canceling", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const key = crypto.randomUUID();
      const request = () =>
        app.request(
          actionPath(activated.id, "cancel"),
          { method: "POST", headers: keyed(key), body: "{}" },
          env
        );
      expect((await request()).status).toBe(200);
      await leaveMidTransition({
        recurringPaymentId: activated.id,
        status: "canceling",
        attemptTable: "payment_recurring_payment_lifecycle_attempts",
        key,
      });
      await crashIdempotencyKey(key);
      const sendsBefore = sendTransactionMock.mock.calls.length;

      const retry = await request();

      expect(retry.status).toBe(200);
      expect((await parseRecurringResponse(retry)).data.recurringPayment.status).toBe("canceling");
      expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);
    });

    it("answers a pending schedule's cancel from the attempt it wrote", async () => {
      const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const key = crypto.randomUUID();
      const request = () =>
        app.request(
          actionPath(created.id, "cancel"),
          { method: "POST", headers: keyed(key), body: "{}" },
          env
        );
      expect((await request()).status).toBe(200);
      const attempt = await getDb(env)
        .prepare(
          "SELECT operation, status, stage FROM payment_recurring_payment_lifecycle_attempts WHERE idempotency_key = ?"
        )
        .bind(recordKey(key))
        .first<{ operation: string; status: string; stage: string }>();
      expect(attempt).toEqual({ operation: "cancel", status: "confirmed", stage: "finalize" });
      await forgetIdempotencyKey(key);

      const retry = await request();

      expect(retry.status).toBe(200);
      expect((await parseRecurringResponse(retry)).data.recurringPayment.status).toBe("canceled");
    });

    it("answers a resume takeover from its attempt before admission, which would refuse", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      expect(
        (
          await app.request(
            actionPath(activated.id, "cancel"),
            { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
            env
          )
        ).status
      ).toBe(200);
      const key = crypto.randomUUID();
      const request = () =>
        app.request(
          actionPath(activated.id, "resume"),
          { method: "POST", headers: keyed(key), body: "{}" },
          env
        );
      expect((await request()).status).toBe(200);
      await leaveMidTransition({
        recurringPaymentId: activated.id,
        status: "resuming",
        attemptTable: "payment_recurring_payment_lifecycle_attempts",
        key,
      });
      await crashIdempotencyKey(key);
      // Admission now refuses any new start for the organization. Deleted just
      // after authentication, which reads organization status fresh (#2262).
      deleteTestOrganizationAfterAuth();
      const sendsBefore = sendTransactionMock.mock.calls.length;

      const retry = await request();

      expect(retry.status).toBe(200);
      expect((await parseRecurringResponse(retry)).data.recurringPayment.status).toBe("resuming");
      expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);
    });

    // An in-flight update is never an answer: stored, it would hold the key on
    // `updating` for 24 hours, and the cron never finishes an update.
    it("refuses a PATCH takeover while its attempt is still fresh: 409 in flight with Retry-After, unstored", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const key = crypto.randomUUID();
      const body = JSON.stringify({ metadataUri: "https://example.com/recurring/keyed.json" });
      const request = () =>
        app.request(actionPath(activated.id), { method: "PATCH", headers: keyed(key), body }, env);
      expect((await request()).status).toBe(200);
      await leaveMidTransition({
        recurringPaymentId: activated.id,
        status: "updating",
        attemptTable: "payment_recurring_payment_update_attempts",
        key,
      });
      await crashIdempotencyKey(key);
      const sendsBefore = sendTransactionMock.mock.calls.length;

      const retry = await request();

      expect(retry.status).toBe(409);
      expect(await errorCode(retry)).toBe("IDEMPOTENCY_KEY_IN_FLIGHT");
      const retryAfter = Number(retry.headers.get("Retry-After"));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(15 * 60);
      const record = await getDb(env)
        .prepare("SELECT response_status FROM idempotency_keys WHERE idempotency_key = ?")
        .bind(key)
        .first<{ response_status: number | null }>();
      expect(record?.response_status ?? null).toBeNull();
      expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);
    });

    it("resumes a PATCH that crashed after its claim when the same key retries it after the stale timeout", async () => {
      mockDistinctRecentBlockhashes();
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const key = crypto.randomUUID();
      const metadataUri = "https://example.com/recurring/resumed.json";
      const request = () =>
        app.request(
          actionPath(activated.id),
          { method: "PATCH", headers: keyed(key), body: JSON.stringify({ metadataUri }) },
          env
        );
      expect((await request()).status).toBe(200);
      // The process died right after the claim: the schedule is `updating` with
      // its old terms, the attempt is in flight at its first stage, and the key
      // never recorded an outcome. The cron does not recover `updating`.
      const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      await getDb(env)
        .prepare(
          `UPDATE payment_recurring_payments
              SET status = 'updating', metadata_uri = ?, updated_at = ?
            WHERE id = ?`
        )
        .bind(activated.metadataUri, staleAt, activated.id)
        .run();
      await getDb(env)
        .prepare(
          `UPDATE payment_recurring_payment_update_attempts
              SET status = 'processing', stage = 'claim', plan_update_signature = NULL,
                  last_valid_block_height = NULL, updated_at = ?
            WHERE idempotency_key = ?`
        )
        .bind(staleAt, recordKey(key))
        .run();
      await crashIdempotencyKey(key);

      const retry = await request();

      expect(retry.status).toBe(200);
      expect((await parseRecurringResponse(retry)).data.recurringPayment).toMatchObject({
        status: "active",
        metadataUri,
      });
      const attempts = await getDb(env)
        .prepare(
          `SELECT status, stage, plan_update_signature IS NOT NULL AS signed
             FROM payment_recurring_payment_update_attempts WHERE recurring_payment_id = ?`
        )
        .bind(activated.id)
        .all<{ status: string; stage: string; signed: boolean }>();
      expect(attempts.results).toEqual([{ status: "confirmed", stage: "finalize", signed: true }]);
    });

    it("answers a collect retry after the due date advanced without pulling a second period", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      // Two periods behind: after one pull the next period is still due.
      await setRecurringCollectionDue({
        recurringPaymentId: activated.id,
        subscriptionId: activated.subscriptionId,
        dueAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      });
      const key = crypto.randomUUID();
      const request = () =>
        app.request(
          actionPath(activated.id, "collect"),
          { method: "POST", headers: keyed(key), body: "{}" },
          env
        );
      const first = await request();
      expect(first.status).toBe(200);
      const collected = (await parseCollectionResponse(first)).data;
      expect((await recurringPaymentDueAt(activated.id)).dueAt).toBeLessThan(Date.now());

      for (const lose of [crashIdempotencyKey, forgetIdempotencyKey]) {
        await lose(key);
        const retry = await request();

        expect(retry.status).toBe(200);
        const replayed = (await parseCollectionResponse(retry)).data;
        expect(replayed.collectionAttempt.id).toBe(collected.collectionAttempt.id);
        expect(replayed.transfer.id).toBe(collected.transfer.id);
        expect(replayed.transfer.signature).toBe(collected.transfer.signature);
      }
      expect(sendTransactionMock).toHaveBeenCalledTimes(3);
      expect(await collectionAttempts(activated.subscriptionId)).toHaveLength(1);
    });

    it("re-runs a failed keyed attempt under the same key", async () => {
      mockDistinctRecentBlockhashes();
      const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      confirmTransactionMock.mockResolvedValueOnce({
        signature: testSignature(1),
        slot: 100n,
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, "Custom"] },
      });
      const key = crypto.randomUUID();
      const request = () =>
        app.request(
          actionPath(created.id, "activate"),
          { method: "POST", headers: keyed(key), body: "{}" },
          env
        );
      expect((await request()).status).toBe(400);

      const retry = await request();

      expect(retry.status).toBe(200);
      expect((await parseRecurringResponse(retry)).data.recurringPayment.status).toBe("active");
      const attempts = await getDb(env)
        .prepare(
          `SELECT status FROM payment_recurring_payment_activation_attempts
            WHERE idempotency_key = ? ORDER BY created_at`
        )
        .bind(recordKey(key))
        .all<{ status: string }>();
      expect(attempts.results).toEqual([{ status: "failed" }, { status: "confirmed" }]);
    });

    it("refuses the same key on another schedule (422)", async () => {
      const first = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const second = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const key = crypto.randomUUID();
      expect(
        (
          await app.request(
            actionPath(first.id, "activate"),
            { method: "POST", headers: keyed(key), body: "{}" },
            env
          )
        ).status
      ).toBe(200);
      await forgetIdempotencyKey(key);
      const sendsBefore = sendTransactionMock.mock.calls.length;

      const response = await app.request(
        actionPath(second.id, "activate"),
        { method: "POST", headers: keyed(key), body: "{}" },
        env
      );

      expect(response.status).toBe(422);
      expect(await errorCode(response)).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);
      expect((await recurringPaymentDueAt(second.id)).status).toBe("pending_activation");
    });

    it("refuses the same key with a different PATCH body (422) and replays the same one", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const key = crypto.randomUUID();
      const patch = (metadataUri: string) =>
        app.request(
          actionPath(activated.id),
          { method: "PATCH", headers: keyed(key), body: JSON.stringify({ metadataUri }) },
          env
        );
      expect((await patch("https://example.com/recurring/first.json")).status).toBe(200);
      await forgetIdempotencyKey(key);

      const different = await patch("https://example.com/recurring/second.json");
      expect(different.status).toBe(422);
      expect(await errorCode(different)).toBe("IDEMPOTENCY_KEY_REUSED");

      // The refusal is stored under the key too; past 24 hours the attempt answers.
      await forgetIdempotencyKey(key);
      const same = await patch("https://example.com/recurring/first.json");
      expect(same.status).toBe(200);
      expect((await parseRecurringResponse(same)).data.recurringPayment.metadataUri).toBe(
        "https://example.com/recurring/first.json"
      );
    });

    // Editing an active schedule signs and broadcasts a replacement subscription,
    // so a PATCH without a key could broadcast twice on a retry.
    it("refuses a PATCH without an Idempotency-Key before it signs anything", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const sendsBefore = sendTransactionMock.mock.calls.length;

      const response = await baseApp.request(
        actionPath(activated.id),
        { method: "PATCH", headers: RECURRING_HEADERS, body: JSON.stringify({ amount: "2" }) },
        env
      );

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("IDEMPOTENCY_KEY_REQUIRED");
      expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);
    });

    it("lets a failed and a live attempt share a key, never two live ones", async () => {
      const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const key = crypto.randomUUID();
      const insert = (status: string) =>
        getDb(env)
          .prepare(
            `INSERT INTO payment_recurring_payment_activation_attempts
               (id, organization_id, project_id, recurring_payment_id, status, stage, idempotency_key)
             VALUES (?, ?, ?, ?, ?, 'claim', ?)`
          )
          .bind(
            `prpa_${crypto.randomUUID()}`,
            TEST_ORG.id,
            TEST_PROJECT.id,
            created.id,
            status,
            recordKey(key)
          )
          .run();

      await insert("failed");
      await insert("failed");
      await insert("processing");
      await expect(insert("confirmed")).rejects.toThrow();
    });

    /** How many shared key records the request left: 0 means it was refused before the claim. */
    async function keyRecords(key: string): Promise<number> {
      const row = await getDb(env)
        .prepare(
          "SELECT COUNT(*)::integer AS count FROM idempotency_keys WHERE idempotency_key = ?"
        )
        .bind(key)
        .first<{ count: number }>();
      if (row === null) throw new Error("COUNT(*) returned no row");
      return row.count;
    }

    /** The create body the default fixture sends, for a schedule it made. */
    function createBody(created: { counterpartyId: string; counterpartyAccountId: string }) {
      return {
        sourceCustodyWalletId: DEFAULT_RECURRING_FIXTURE.sourceCustodyWalletId,
        counterpartyId: created.counterpartyId,
        counterpartyAccountId: created.counterpartyAccountId,
        token: DEFAULT_RECURRING_FIXTURE.token,
        amount: DEFAULT_RECURRING_FIXTURE.amount,
        periodHours: DEFAULT_RECURRING_FIXTURE.periodHours,
      };
    }

    const postCreate = (key: string, body: Record<string, unknown>) =>
      app.request(
        "/v1/payments/recurring-payments",
        { method: "POST", headers: keyed(key), body: JSON.stringify(body) },
        env
      );

    it("refuses a new schedule on an inactive source wallet (404) but answers one made before", async () => {
      const key = crypto.randomUUID();
      const created = await createRecurringPaymentFixture({
        ...DEFAULT_RECURRING_FIXTURE,
        headers: keyed(key),
      });
      await getDb(env)
        .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
        .bind(TEST_CUSTODY_WALLET_ID)
        .run();
      await forgetIdempotencyKey(key);

      const replay = await postCreate(key, createBody(created));
      expect(replay.status).toBe(201);
      expect((await parseRecurringResponse(replay)).data.recurringPayment.id).toBe(created.id);

      const fresh = await postCreate(crypto.randomUUID(), createBody(created));
      expect(fresh.status).toBe(404);
      const schedules = await getDb(env)
        .prepare(
          "SELECT COUNT(*)::integer AS count FROM payment_recurring_payments WHERE counterparty_id = ?"
        )
        .bind(created.counterpartyId)
        .first<{ count: number }>();
      expect(schedules).toEqual({ count: 1 });
    });

    it("refuses a PATCH naming a counterparty account outside the project before claiming the key", async () => {
      const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const key = crypto.randomUUID();

      const response = await app.request(
        actionPath(created.id),
        {
          method: "PATCH",
          headers: keyed(key),
          body: JSON.stringify({ counterpartyAccountId: "counterparty_account_other_tenant" }),
        },
        env
      );

      expect(response.status).toBe(404);
      expect(errorResponseSchema.parse(await response.json()).error.message).toBe(
        "Counterparty account not found"
      );
      // Refused before the claim: no 404 is stored under the key for 24 hours.
      expect(await keyRecords(key)).toBe(0);
    });

    it("answers a keyed action from its attempt after the wallet pin is lost; new work is a 409", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const key = crypto.randomUUID();
      const cancel = (idempotencyKey: string) =>
        app.request(
          actionPath(activated.id, "cancel"),
          { method: "POST", headers: keyed(idempotencyKey), body: "{}" },
          env
        );
      expect((await cancel(key)).status).toBe(200);
      await forgetIdempotencyKey(key);
      await getDb(env)
        .prepare(
          "UPDATE payment_recurring_payments SET source_custody_wallet_id = NULL WHERE id = ?"
        )
        .bind(activated.id)
        .run();

      // An unresolved pin is state: the retry of a cancel that ran is still answered.
      const retry = await cancel(key);
      expect(retry.status).toBe(200);
      expect((await parseRecurringResponse(retry)).data.recurringPayment.status).toBe("canceled");

      const resume = await app.request(
        actionPath(activated.id, "resume"),
        { method: "POST", headers: keyed(crypto.randomUUID()), body: "{}" },
        env
      );
      expect(resume.status).toBe(409);
    });

    it("fingerprints a create's amount canonically, so 25.0 and 25.00 are one request", async () => {
      const first = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const key = crypto.randomUUID();
      const created = await postCreate(key, { ...createBody(first), amount: "25.0" });
      expect(created.status).toBe(201);

      const respelled = await postCreate(key, { ...createBody(first), amount: "25.00" });

      expect(respelled.status).toBe(201);
      expect(respelled.headers.get("Idempotent-Replayed")).toBe("true");
      expect((await parseRecurringResponse(respelled)).data.recurringPayment.id).toBe(
        (await parseRecurringResponse(created)).data.recurringPayment.id
      );
    });

    it("records a keyed collect's key on the collection it recovers, so its retry pulls nothing", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      // Two periods behind: after one pull the next period is still due.
      await setRecurringCollectionDue({
        recurringPaymentId: activated.id,
        subscriptionId: activated.subscriptionId,
        dueAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      });
      sendTransactionMock.mockRejectedValueOnce(new Error("RPC response lost"));
      const ambiguous = await app.request(
        actionPath(activated.id, "collect"),
        { method: "POST", headers: keyed(crypto.randomUUID()), body: "{}" },
        env
      );
      expect(ambiguous.status).toBe(200);
      // As if the cron had claimed the period: the in-flight attempt carries no key.
      await getDb(env)
        .prepare(
          "UPDATE payment_subscription_collection_attempts SET idempotency_key = NULL WHERE subscription_id = ?"
        )
        .bind(activated.subscriptionId)
        .run();

      const key = crypto.randomUUID();
      const collect = () =>
        app.request(
          actionPath(activated.id, "collect"),
          { method: "POST", headers: keyed(key), body: "{}" },
          env
        );
      recordSignatureStatus(poolSentSignatures()[2], null);
      const recovered = await collect();
      expect(recovered.status).toBe(200);
      const recoveredAttempt = (await parseCollectionResponse(recovered)).data.collectionAttempt;
      expect(recoveredAttempt.status).toBe("confirmed");
      expect((await recurringPaymentDueAt(activated.id)).dueAt).toBeLessThan(Date.now());

      await crashIdempotencyKey(key);
      const retry = await collect();

      expect(retry.status).toBe(200);
      expect((await parseCollectionResponse(retry)).data.collectionAttempt.id).toBe(
        recoveredAttempt.id
      );
      expect(sendTransactionMock).toHaveBeenCalledTimes(3);
      expect(await collectionAttempts(activated.subscriptionId)).toHaveLength(1);
    });

    it("refuses a keyed collect that would recover another key's collection, unstored", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      await setRecurringCollectionDue({
        recurringPaymentId: activated.id,
        subscriptionId: activated.subscriptionId,
        dueAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      });
      sendTransactionMock.mockRejectedValueOnce(new Error("RPC response lost"));
      const firstKey = crypto.randomUUID();
      const ambiguous = await app.request(
        actionPath(activated.id, "collect"),
        { method: "POST", headers: keyed(firstKey), body: "{}" },
        env
      );
      expect(ambiguous.status).toBe(200);

      const otherKey = crypto.randomUUID();
      const other = await app.request(
        actionPath(activated.id, "collect"),
        { method: "POST", headers: keyed(otherKey), body: "{}" },
        env
      );

      expect(other.status).toBe(409);
      const stored = await getDb(env)
        .prepare(
          "SELECT COUNT(*)::integer AS count FROM idempotency_keys WHERE idempotency_key = ?"
        )
        .bind(otherKey)
        .first<{ count: number }>();
      expect(stored).toEqual({ count: 0 });
      const attempts = await getDb(env)
        .prepare(
          "SELECT idempotency_key FROM payment_subscription_collection_attempts WHERE subscription_id = ?"
        )
        .bind(activated.subscriptionId)
        .all<{ idempotency_key: string | null }>();
      expect(attempts.results).toEqual([{ idempotency_key: recordKey(firstKey) }]);
      expect(sendTransactionMock).toHaveBeenCalledTimes(3);
    });

    it("answers an account-only PATCH retry after a later edit moved the schedule to another counterparty", async () => {
      const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const other = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      // A second account under the schedule's own counterparty.
      const sameCounterpartyAccountId = `counterparty_account_${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      await getDb(env)
        .prepare(
          `INSERT INTO counterparty_accounts (
             id, organization_id, project_id, counterparty_id, account_kind, label,
             details, provider_account_data, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'crypto_wallet', 'Second wallet', ?, '{}', 'active', ?, ?)`
        )
        .bind(
          sameCounterpartyAccountId,
          TEST_ORG.id,
          TEST_PROJECT.id,
          created.counterpartyId,
          JSON.stringify({ network: "solana", address: TEST_SOLANA_ADDRESSES.wallet3 }),
          now,
          now
        )
        .run();
      const patch = (key: string, body: Record<string, string>) =>
        app.request(
          actionPath(created.id),
          { method: "PATCH", headers: keyed(key), body: JSON.stringify(body) },
          env
        );
      const accountOnlyKey = crypto.randomUUID();
      const accountOnly = { counterpartyAccountId: sameCounterpartyAccountId };
      expect((await patch(accountOnlyKey, accountOnly)).status).toBe(200);
      // A later edit points the schedule at another counterparty and its account.
      expect(
        (
          await patch(crypto.randomUUID(), {
            counterpartyId: other.counterpartyId,
            counterpartyAccountId: other.counterpartyAccountId,
          })
        ).status
      ).toBe(200);
      await forgetIdempotencyKey(accountOnlyKey);

      const retry = await patch(accountOnlyKey, accountOnly);

      expect(retry.status).toBe(200);
      expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
      expect((await parseRecurringResponse(retry)).data.recurringPayment).toMatchObject({
        counterpartyId: other.counterpartyId,
        counterpartyAccountId: other.counterpartyAccountId,
      });
    });

    it("journals a pending schedule's PATCH as a keyed attempt and answers its retry from it", async () => {
      const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const key = crypto.randomUUID();
      const patch = (amount: string) =>
        app.request(
          actionPath(created.id),
          { method: "PATCH", headers: keyed(key), body: JSON.stringify({ amount }) },
          env
        );
      expect((await patch("30.00")).status).toBe(200);
      const attempt = await getDb(env)
        .prepare(
          `SELECT status, stage, idempotency_fingerprint IS NOT NULL AS fingerprinted
             FROM payment_recurring_payment_update_attempts
            WHERE idempotency_key = ?`
        )
        .bind(recordKey(key))
        .first<{ status: string; stage: string; fingerprinted: boolean }>();
      expect(attempt).toEqual({ status: "confirmed", stage: "finalize", fingerprinted: true });
      await forgetIdempotencyKey(key);

      const different = await patch("31.00");
      expect(different.status).toBe(422);
      expect(await errorCode(different)).toBe("IDEMPOTENCY_KEY_REUSED");
      expect((await recurringPaymentDueAt(created.id)).status).toBe("pending_activation");
      const row = await getDb(env)
        .prepare("SELECT amount FROM payment_recurring_payments WHERE id = ?")
        .bind(created.id)
        .first<{ amount: string }>();
      expect(row?.amount).toBe("30.00");

      await forgetIdempotencyKey(key);
      const same = await patch("30.00");
      expect(same.status).toBe(200);
      expect((await parseRecurringResponse(same)).data.recurringPayment.amount).toBe("30.00");
    });

    it("creates once when two same-key creates race; the loser is told the key is in flight", async () => {
      const first = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const key = crypto.randomUUID();
      const body = { ...createBody(first), periodHours: 48 };

      // Hold new schedules back so the request that claims the key is still
      // running when the other arrives; two unblocked requests can run one
      // after the other, and the second is then a plain replay.
      const pending = await getDb(env).transaction(async (tx) => {
        await tx.execute("LOCK TABLE payment_recurring_payments IN EXCLUSIVE MODE");
        const both = [postCreate(key, body), postCreate(key, body)];
        // The loser answers without writing a schedule, so it settles while the lock is held.
        expect((await Promise.race(both)).status).toBe(409);
        return both;
      });
      const responses = await Promise.all(pending);

      const winner = responses.find((response) => response.status === 201);
      const loser = responses.find((response) => response.status === 409);
      if (!winner || !loser) {
        throw new Error(`expected one 201 and one 409, got ${responses.map((r) => r.status)}`);
      }
      expect(await errorCode(loser)).toBe("IDEMPOTENCY_KEY_IN_FLIGHT");
      const retry = await postCreate(key, body);
      expect(retry.status).toBe(201);
      expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
      const created = (await parseRecurringResponse(winner)).data.recurringPayment;
      expect((await parseRecurringResponse(retry)).data.recurringPayment.id).toBe(created.id);
      const schedules = await getDb(env)
        .prepare(
          "SELECT COUNT(*)::integer AS count FROM payment_recurring_payments WHERE idempotency_key = ?"
        )
        .bind(recordKey(key))
        .first<{ count: number }>();
      expect(schedules).toEqual({ count: 1 });
    });

    /** How many shared key records exist for the key; a missing COUNT row fails the test. */
    const storedKeyCount = async (key: string): Promise<number> => {
      const row = await getDb(env)
        .prepare(
          "SELECT COUNT(*)::integer AS count FROM idempotency_keys WHERE idempotency_key = ?"
        )
        .bind(key)
        .first<{ count: number }>();
      if (row === null) throw new Error("COUNT(*) returned no row");
      return row.count;
    };

    const recurringMetadataUri = async (id: string) =>
      (
        await getDb(env)
          .prepare("SELECT metadata_uri FROM payment_recurring_payments WHERE id = ?")
          .bind(id)
          .first<{ metadata_uri: string | null }>()
      )?.metadata_uri;

    // Greptile (#2334): the 422 for a key reused on another schedule was stored
    // under that request, so the original request's own retry then got the 422.
    it("refuses a key reused on another schedule unstored, so the original retry is still answered", async () => {
      const original = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const other = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const key = crypto.randomUUID();
      const activate = (id: string) =>
        app.request(
          actionPath(id, "activate"),
          { method: "POST", headers: keyed(key), body: "{}" },
          env
        );
      expect((await activate(original.id)).status).toBe(200);
      await forgetIdempotencyKey(key);

      const reused = await activate(other.id);
      expect(reused.status).toBe(422);
      expect(await errorCode(reused)).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(await storedKeyCount(key)).toBe(0);
      const sendsBefore = sendTransactionMock.mock.calls.length;

      const retry = await activate(original.id);
      expect(retry.status).toBe(200);
      expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
      expect((await parseRecurringResponse(retry)).data.recurringPayment.id).toBe(original.id);
      expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);
    });

    it("refuses a keyed activate that would finish another key's stale activation, unstored; the cron finishes it", async () => {
      const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const firstKey = crypto.randomUUID();
      expect(
        (
          await app.request(
            actionPath(created.id, "activate"),
            { method: "POST", headers: keyed(firstKey), body: "{}" },
            env
          )
        ).status
      ).toBe(200);
      // The first activation crashed before it finalized, long enough ago to be recoverable.
      const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      await getDb(env)
        .prepare(
          "UPDATE payment_recurring_payments SET status = 'activating', updated_at = ? WHERE id = ?"
        )
        .bind(staleAt, created.id)
        .run();
      await getDb(env)
        .prepare(
          `UPDATE payment_recurring_payment_activation_attempts
              SET status = 'processing', updated_at = ?
            WHERE idempotency_key = ?`
        )
        .bind(staleAt, recordKey(firstKey))
        .run();
      const sendsBefore = sendTransactionMock.mock.calls.length;

      const otherKey = crypto.randomUUID();
      const other = await app.request(
        actionPath(created.id, "activate"),
        { method: "POST", headers: keyed(otherKey), body: "{}" },
        env
      );

      expect(other.status).toBe(409);
      expect(await storedKeyCount(otherKey)).toBe(0);
      // The claim rolled back with the refusal: the schedule is still the stale activation.
      const schedule = await getDb(env)
        .prepare("SELECT status, updated_at FROM payment_recurring_payments WHERE id = ?")
        .bind(created.id)
        .first<{ status: string; updated_at: string }>();
      expect(schedule).toEqual({ status: "activating", updated_at: staleAt });
      expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);

      const tick = await collectDueRecurringPaymentsIn("sandbox", new Date());
      expect(tick.recovered).toBe(1);
      expect((await recurringPaymentDueAt(created.id)).status).toBe("active");
      const attempts = await getDb(env)
        .prepare(
          `SELECT idempotency_key, status
             FROM payment_recurring_payment_activation_attempts
            WHERE recurring_payment_id = ?`
        )
        .bind(created.id)
        .all<{ idempotency_key: string | null; status: string }>();
      expect(attempts.results).toEqual([
        { idempotency_key: recordKey(firstKey), status: "confirmed" },
      ]);
    });

    it("refuses a keyed cancel that would finish another key's stale cancel, unstored", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const firstKey = crypto.randomUUID();
      expect(
        (
          await app.request(
            actionPath(activated.id, "cancel"),
            { method: "POST", headers: keyed(firstKey), body: "{}" },
            env
          )
        ).status
      ).toBe(200);
      // The first cancel crashed mid-transition long enough ago to be recoverable.
      const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      await getDb(env)
        .prepare(
          "UPDATE payment_recurring_payments SET status = 'canceling', updated_at = ? WHERE id = ?"
        )
        .bind(staleAt, activated.id)
        .run();
      await getDb(env)
        .prepare(
          `UPDATE payment_recurring_payment_lifecycle_attempts
              SET status = 'processing', stage = 'claim', signature = NULL,
                  last_valid_block_height = NULL, updated_at = ?
            WHERE idempotency_key = ?`
        )
        .bind(staleAt, recordKey(firstKey))
        .run();
      const sendsBefore = sendTransactionMock.mock.calls.length;

      const otherKey = crypto.randomUUID();
      const other = await app.request(
        actionPath(activated.id, "cancel"),
        { method: "POST", headers: keyed(otherKey), body: "{}" },
        env
      );

      expect(other.status).toBe(409);
      expect(await storedKeyCount(otherKey)).toBe(0);
      const attempts = await getDb(env)
        .prepare(
          `SELECT idempotency_key, status
             FROM payment_recurring_payment_lifecycle_attempts
            WHERE recurring_payment_id = ? AND operation = 'cancel'`
        )
        .bind(activated.id)
        .all<{ idempotency_key: string | null; status: string }>();
      expect(attempts.results).toEqual([
        { idempotency_key: recordKey(firstKey), status: "processing" },
      ]);
      // The claim rolled back with the refusal: the schedule is still the stale cancel.
      expect(await recurringPaymentDueAt(activated.id)).toMatchObject({ status: "canceling" });
      const schedule = await getDb(env)
        .prepare("SELECT updated_at FROM payment_recurring_payments WHERE id = ?")
        .bind(activated.id)
        .first<{ updated_at: string }>();
      expect(schedule?.updated_at).toBe(staleAt);
      expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);
    });

    it("answers a keyed cancel of a canceled schedule from an attempt, so its retry never cancels a later resume", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const lifecycle = (action: "cancel" | "resume", key: string) =>
        app.request(
          actionPath(activated.id, action),
          { method: "POST", headers: keyed(key), body: "{}" },
          env
        );
      expect((await lifecycle("cancel", crypto.randomUUID())).status).toBe(200);
      const noOpKey = crypto.randomUUID();
      expect((await lifecycle("cancel", noOpKey)).status).toBe(200);
      expect((await lifecycle("resume", crypto.randomUUID())).status).toBe(200);
      await forgetIdempotencyKey(noOpKey);
      const sendsBefore = sendTransactionMock.mock.calls.length;

      const retry = await lifecycle("cancel", noOpKey);

      expect(retry.status).toBe(200);
      expect((await parseRecurringResponse(retry)).data.recurringPayment.status).toBe("active");
      expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);
    });

    it("answers a pending schedule's no-change PATCH from an attempt, so its retry never overwrites a later edit", async () => {
      const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const patch = (key: string, amount: string) =>
        app.request(
          actionPath(created.id),
          { method: "PATCH", headers: keyed(key), body: JSON.stringify({ amount }) },
          env
        );
      const noOpKey = crypto.randomUUID();
      expect((await patch(noOpKey, DEFAULT_RECURRING_FIXTURE.amount)).status).toBe(200);
      expect((await patch(crypto.randomUUID(), "30.00")).status).toBe(200);
      await forgetIdempotencyKey(noOpKey);

      const retry = await patch(noOpKey, DEFAULT_RECURRING_FIXTURE.amount);

      expect(retry.status).toBe(200);
      expect((await parseRecurringResponse(retry)).data.recurringPayment.amount).toBe("30.00");
      const row = await getDb(env)
        .prepare("SELECT amount FROM payment_recurring_payments WHERE id = ?")
        .bind(created.id)
        .first<{ amount: string }>();
      expect(row?.amount).toBe("30.00");
    });

    it("answers an active schedule's no-change PATCH from an attempt, so its retry never overwrites a later edit", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const patch = (key: string, metadataUri: string) =>
        app.request(
          actionPath(activated.id),
          { method: "PATCH", headers: keyed(key), body: JSON.stringify({ metadataUri }) },
          env
        );
      const first = "https://example.com/recurring/first.json";
      const later = "https://example.com/recurring/later.json";
      expect((await patch(crypto.randomUUID(), first)).status).toBe(200);
      const noOpKey = crypto.randomUUID();
      expect((await patch(noOpKey, first)).status).toBe(200);
      expect((await patch(crypto.randomUUID(), later)).status).toBe(200);
      await forgetIdempotencyKey(noOpKey);
      const sendsBefore = sendTransactionMock.mock.calls.length;

      const retry = await patch(noOpKey, first);

      expect(retry.status).toBe(200);
      expect(await recurringMetadataUri(activated.id)).toBe(later);
      expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);
    });

    it("answers a PATCH that finished another key's stale update under its own key too", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const recovered = "https://example.com/recurring/recovered.json";
      const later = "https://example.com/recurring/later.json";
      const snapshot = {
        sourceCustodyWalletId: activated.sourceCustodyWalletId,
        counterpartyId: activated.counterpartyId,
        counterpartyAccountId: activated.counterpartyAccountId,
        token: activated.token,
        amount: activated.amount,
        periodHours: activated.periodHours,
        firstCollectionAt: activated.firstCollectionAt,
        nextCollectionDueAt: activated.nextCollectionDueAt,
        metadataUri: activated.metadataUri,
      };
      // Another key's PATCH to the same terms crashed after its claim.
      const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      await getDb(env)
        .prepare(
          "UPDATE payment_recurring_payments SET status = 'updating', updated_at = ? WHERE id = ?"
        )
        .bind(staleAt, activated.id)
        .run();
      await getDb(env)
        .prepare(
          `INSERT INTO payment_recurring_payment_update_attempts (
             id, organization_id, project_id, recurring_payment_id, mode, status, stage,
             old_plan_id, old_subscription_id, changed_fields, before_values, after_values,
             idempotency_key, idempotency_fingerprint, created_at, updated_at
           ) VALUES (
             ?, ?, ?, ?, 'metadata_schedule', 'processing', 'claim', ?, ?,
             ARRAY['metadataUri']::text[], ?::jsonb, ?::jsonb, ?, 'fingerprint_of_another_key', ?, ?
           )`
        )
        .bind(
          `prpu_${crypto.randomUUID()}`,
          TEST_ORG.id,
          TEST_PROJECT.id,
          activated.id,
          activated.planId,
          activated.subscriptionId,
          JSON.stringify(snapshot),
          JSON.stringify({ ...snapshot, metadataUri: recovered }),
          recordKey(crypto.randomUUID()),
          staleAt,
          staleAt
        )
        .run();
      const patch = (key: string, metadataUri: string) =>
        app.request(
          actionPath(activated.id),
          { method: "PATCH", headers: keyed(key), body: JSON.stringify({ metadataUri }) },
          env
        );
      const recoveringKey = crypto.randomUUID();
      const recovering = await patch(recoveringKey, recovered);
      expect(recovering.status).toBe(200);
      expect(await recurringMetadataUri(activated.id)).toBe(recovered);
      expect((await patch(crypto.randomUUID(), later)).status).toBe(200);
      await forgetIdempotencyKey(recoveringKey);
      const sendsBefore = sendTransactionMock.mock.calls.length;

      const retry = await patch(recoveringKey, recovered);

      expect(retry.status).toBe(200);
      expect(await recurringMetadataUri(activated.id)).toBe(later);
      expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);
    });

    it("commits a PATCH that finishes another key's stale update together with its own answer, or neither", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const recovered = "https://example.com/recurring/recovered.json";
      const later = "https://example.com/recurring/later.json";
      const snapshot = {
        sourceCustodyWalletId: activated.sourceCustodyWalletId,
        counterpartyId: activated.counterpartyId,
        counterpartyAccountId: activated.counterpartyAccountId,
        token: activated.token,
        amount: activated.amount,
        periodHours: activated.periodHours,
        firstCollectionAt: activated.firstCollectionAt,
        nextCollectionDueAt: activated.nextCollectionDueAt,
        metadataUri: activated.metadataUri,
      };
      // Another key's PATCH to the same terms crashed after its claim.
      const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      const backdate = () =>
        getDb(env)
          .prepare(
            "UPDATE payment_recurring_payments SET status = 'updating', updated_at = ? WHERE id = ?"
          )
          .bind(staleAt, activated.id)
          .run();
      await backdate();
      await getDb(env)
        .prepare(
          `INSERT INTO payment_recurring_payment_update_attempts (
             id, organization_id, project_id, recurring_payment_id, mode, status, stage,
             old_plan_id, old_subscription_id, changed_fields, before_values, after_values,
             idempotency_key, idempotency_fingerprint, created_at, updated_at
           ) VALUES (
             ?, ?, ?, ?, 'metadata_schedule', 'processing', 'claim', ?, ?,
             ARRAY['metadataUri']::text[], ?::jsonb, ?::jsonb, ?, 'fingerprint_of_another_key', ?, ?
           )`
        )
        .bind(
          `prpu_${crypto.randomUUID()}`,
          TEST_ORG.id,
          TEST_PROJECT.id,
          activated.id,
          activated.planId,
          activated.subscriptionId,
          JSON.stringify(snapshot),
          JSON.stringify({ ...snapshot, metadataUri: recovered }),
          recordKey(crypto.randomUUID()),
          staleAt,
          staleAt
        )
        .run();
      const patch = (key: string, metadataUri: string) =>
        app.request(
          actionPath(activated.id),
          { method: "PATCH", headers: keyed(key), body: JSON.stringify({ metadataUri }) },
          env
        );
      // The write of this request's own answer fails, right after the finalize.
      const createRepository =
        paymentRecurringPaymentsRepositoryPostgres.createPostgresPaymentRecurringPaymentsRepository;
      const repositorySpy = vi
        .spyOn(
          paymentRecurringPaymentsRepositoryPostgres,
          "createPostgresPaymentRecurringPaymentsRepository"
        )
        .mockImplementation((db) => {
          const repository = createRepository(db);
          return {
            ...repository,
            createUpdateAttempt: vi.fn(async (input) => {
              if (input.status === "confirmed" && input.changedFields.length === 0) {
                throw new Error("answered update attempt insert unavailable");
              }
              return repository.createUpdateAttempt(input);
            }),
          };
        });
      onTestFinished(() => repositorySpy.mockRestore());
      const recoveringKey = crypto.randomUUID();
      const answeredAttempts = async () =>
        (
          await getDb(env)
            .prepare(
              "SELECT status FROM payment_recurring_payment_update_attempts WHERE idempotency_key = ?"
            )
            .bind(recordKey(recoveringKey))
            .all<{ status: string }>()
        ).results;

      const failed = await patch(recoveringKey, recovered);

      expect(failed.status).toBeGreaterThanOrEqual(500);
      // Neither half landed: the schedule is still the stale update, and this
      // key has no attempt, so no later edit can slip in for its retry to undo.
      expect(await recurringPaymentDueAt(activated.id)).toMatchObject({ status: "updating" });
      expect(await recurringMetadataUri(activated.id)).toBe(activated.metadataUri);
      expect(await answeredAttempts()).toEqual([]);
      expect((await patch(crypto.randomUUID(), later)).status).toBe(409);
      repositorySpy.mockRestore();
      // The failed request's plan update landed: the plan holds the recovered URI.
      vi.mocked(subscriptionsProgram.fetchMaybePlan).mockResolvedValue(planAccount(recovered));

      // Once stale again, the retry finishes the update and records its answer with it.
      await backdate();
      const retry = await patch(recoveringKey, recovered);

      expect(retry.status).toBe(200);
      expect(await recurringMetadataUri(activated.id)).toBe(recovered);
      expect(await answeredAttempts()).toEqual([{ status: "confirmed" }]);
    });

    it("refuses a keyed resume that would finish another key's stale resume, unstored", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const lifecycle = (action: "cancel" | "resume", key: string) =>
        app.request(
          actionPath(activated.id, action),
          { method: "POST", headers: keyed(key), body: "{}" },
          env
        );
      expect((await lifecycle("cancel", crypto.randomUUID())).status).toBe(200);
      const firstKey = crypto.randomUUID();
      expect((await lifecycle("resume", firstKey)).status).toBe(200);
      // The first resume crashed mid-transition long enough ago to be recoverable.
      const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      await getDb(env)
        .prepare(
          "UPDATE payment_recurring_payments SET status = 'resuming', updated_at = ? WHERE id = ?"
        )
        .bind(staleAt, activated.id)
        .run();
      await getDb(env)
        .prepare(
          `UPDATE payment_recurring_payment_lifecycle_attempts
              SET status = 'processing', stage = 'claim', signature = NULL,
                  last_valid_block_height = NULL, updated_at = ?
            WHERE idempotency_key = ?`
        )
        .bind(staleAt, recordKey(firstKey))
        .run();
      const sendsBefore = sendTransactionMock.mock.calls.length;

      const otherKey = crypto.randomUUID();
      const other = await lifecycle("resume", otherKey);

      expect(other.status).toBe(409);
      expect(await storedKeyCount(otherKey)).toBe(0);
      const attempts = await getDb(env)
        .prepare(
          `SELECT idempotency_key, status
             FROM payment_recurring_payment_lifecycle_attempts
            WHERE recurring_payment_id = ? AND operation = 'resume'`
        )
        .bind(activated.id)
        .all<{ idempotency_key: string | null; status: string }>();
      expect(attempts.results).toEqual([
        { idempotency_key: recordKey(firstKey), status: "processing" },
      ]);
      // The claim rolled back with the refusal: the schedule is still the stale resume.
      expect(await recurringPaymentDueAt(activated.id)).toMatchObject({ status: "resuming" });
      const schedule = await getDb(env)
        .prepare("SELECT updated_at FROM payment_recurring_payments WHERE id = ?")
        .bind(activated.id)
        .first<{ updated_at: string }>();
      expect(schedule?.updated_at).toBe(staleAt);
      expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);
    });

    it("answers a keyed resume of an active schedule from an attempt, so its retry never resumes after a later cancel", async () => {
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      const lifecycle = (action: "cancel" | "resume", key: string) =>
        app.request(
          actionPath(activated.id, action),
          { method: "POST", headers: keyed(key), body: "{}" },
          env
        );
      const noOpKey = crypto.randomUUID();
      expect((await lifecycle("resume", noOpKey)).status).toBe(200);
      expect((await lifecycle("cancel", crypto.randomUUID())).status).toBe(200);
      await forgetIdempotencyKey(noOpKey);
      const sendsBefore = sendTransactionMock.mock.calls.length;

      const retry = await lifecycle("resume", noOpKey);

      expect(retry.status).toBe(200);
      expect((await parseRecurringResponse(retry)).data.recurringPayment.status).toBe("canceled");
      expect(sendTransactionMock).toHaveBeenCalledTimes(sendsBefore);
    });

    describe("a resumed attempt reads the chain before it sends a step again (HOO-2044)", () => {
      /** Every subscription send. */
      const sends = () => {
        const spy = vi.spyOn(recurringShared, "sendSubscriptionInstructions");
        onTestFinished(() => spy.mockRestore());
        return spy;
      };
      /** How many of a fetch's calls read at `finalized`, the resumed-step commitment. */
      const finalizedReads = (
        calls: ReadonlyArray<Parameters<typeof subscriptionsProgram.fetchMaybePlan>>
      ) => calls.filter(([, , config]) => config?.commitment === "finalized").length;

      /** A plan row for a schedule the test puts mid-activation. */
      async function seedPlanRow(planId: string, status: "draft" | "active", at: string) {
        await getDb(env)
          .prepare(
            `INSERT INTO payment_subscription_plans (
               id, organization_id, project_id, owner_wallet_id, owner_address, token,
               amount, period_hours, program_plan_id, status, created_by, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, '25.00', 24, '1001', ?, ?, ?, ?)`
          )
          .bind(
            planId,
            TEST_ORG.id,
            TEST_PROJECT.id,
            TEST_WALLET_ID,
            recurringExecution.sourceSigner().address,
            DEVNET_USDC_MINT,
            status,
            TEST_USER.id,
            at,
            at
          )
          .run();
      }

      /**
       * Puts a finished lifecycle operation back to the moment after its send
       * returned and before its signature was saved, long enough ago to recover.
       * The attempt keeps no key, so a request under a new key adopts it.
       */
      async function leaveUnsavedSend(input: {
        recurringPaymentId: string;
        operation: PaymentRecurringPaymentLifecycleOperation;
        key: string;
      }) {
        const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
        await getDb(env)
          .prepare("UPDATE payment_recurring_payments SET status = ?, updated_at = ? WHERE id = ?")
          .bind(
            input.operation === "cancel" ? "canceling" : "resuming",
            staleAt,
            input.recurringPaymentId
          )
          .run();
        const updated = await getDb(env)
          .prepare(
            `UPDATE payment_recurring_payment_lifecycle_attempts
                SET status = 'processing', stage = 'submit', signature = NULL,
                    last_valid_block_height = NULL, idempotency_key = NULL, updated_at = ?
              WHERE idempotency_key = ?`
          )
          .bind(staleAt, recordKey(input.key))
          .run();
        expect(updated).toBe(1);
      }

      const lifecycleAttempts = (
        recurringPaymentId: string,
        operation: PaymentRecurringPaymentLifecycleOperation
      ) =>
        getDb(env)
          .prepare(
            `SELECT status, stage, signature
               FROM payment_recurring_payment_lifecycle_attempts
              WHERE recurring_payment_id = ? AND operation = ?`
          )
          .bind(recurringPaymentId, operation)
          .all<{
            status: PaymentRecurringPaymentAttemptStatus;
            stage: PaymentRecurringPaymentLifecycleAttemptStage;
            signature: string | null;
          }>();

      it("finishes a cancel whose send landed without sending it again", async () => {
        const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        const key = crypto.randomUUID();
        expect(
          (
            await app.request(
              actionPath(activated.id, "cancel"),
              { method: "POST", headers: keyed(key), body: "{}" },
              env
            )
          ).status
        ).toBe(200);
        // A fresh attempt has sent nothing, so it reads nothing extra.
        expect(finalizedReads(fetchMaybeSubscriptionDelegationMock.mock.calls)).toBe(0);
        await leaveUnsavedSend({ recurringPaymentId: activated.id, operation: "cancel", key });
        // The chain shows the cancel: the period's end is set.
        fetchMaybeSubscriptionDelegationMock.mockResolvedValue(delegation(1_800_000_000n));
        const sent = sends();

        const retry = await app.request(
          actionPath(activated.id, "cancel"),
          { method: "POST", headers: keyed(crypto.randomUUID()), body: "{}" },
          env
        );

        expect(retry.status).toBe(200);
        expect((await parseRecurringResponse(retry)).data.recurringPayment.status).toBe("canceled");
        expect(sent).not.toHaveBeenCalled();
        expect(finalizedReads(fetchMaybeSubscriptionDelegationMock.mock.calls)).toBe(1);
        expect((await lifecycleAttempts(activated.id, "cancel")).results).toEqual([
          { status: "confirmed", stage: "finalize", signature: null },
        ]);
      });

      it("keeps a cancel recoverable when the chain read fails", async () => {
        const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        const key = crypto.randomUUID();
        const cancel = (requestKey: string) =>
          app.request(
            actionPath(activated.id, "cancel"),
            { method: "POST", headers: keyed(requestKey), body: "{}" },
            env
          );
        expect((await cancel(key)).status).toBe(200);
        await leaveUnsavedSend({ recurringPaymentId: activated.id, operation: "cancel", key });
        fetchMaybeSubscriptionDelegationMock.mockRejectedValueOnce(new Error("RPC unavailable"));
        const sent = sends();

        const failed = await cancel(crypto.randomUUID());

        expect(failed.status).toBe(409);
        expect(sent).not.toHaveBeenCalled();
        // Neither failed nor reset: the attempt waits at `submit` for the chain to answer.
        expect((await lifecycleAttempts(activated.id, "cancel")).results).toEqual([
          { status: "processing", stage: "submit", signature: null },
        ]);
        expect((await recurringPaymentDueAt(activated.id)).status).toBe("canceling");
      });

      it("never finishes a resume from a delegation that does not exist", async () => {
        const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        const lifecycle = (action: PaymentRecurringPaymentLifecycleOperation, key: string) =>
          app.request(
            actionPath(activated.id, action),
            { method: "POST", headers: keyed(key), body: "{}" },
            env
          );
        expect((await lifecycle("cancel", crypto.randomUUID())).status).toBe(200);
        const key = crypto.randomUUID();
        expect((await lifecycle("resume", key)).status).toBe(200);
        await leaveUnsavedSend({ recurringPaymentId: activated.id, operation: "resume", key });
        // No delegation at all: its expiry reads as cleared, but nothing was resumed.
        fetchMaybeSubscriptionDelegationMock.mockResolvedValue({
          exists: false,
          address: address(TEST_SOLANA_ADDRESSES.wallet3),
        });
        const sent = sends();

        const retry = await lifecycle("resume", crypto.randomUUID());

        expect(retry.status).toBe(409);
        expect(sent).not.toHaveBeenCalled();
        expect((await recurringPaymentDueAt(activated.id)).status).not.toBe("active");
      });

      it("keeps a resumed metadata update in flight when the chain read fails", async () => {
        const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        const key = crypto.randomUUID();
        const metadataUri = "https://example.com/recurring/unsettled.json";
        const request = () =>
          app.request(
            actionPath(activated.id),
            { method: "PATCH", headers: keyed(key), body: JSON.stringify({ metadataUri }) },
            env
          );
        sendTransactionMock.mockRejectedValueOnce(new Error("process died after broadcast"));
        expect((await request()).status).toBe(500);
        await leaveUpdateCrashedAt(activated.id, key);
        await getDb(env)
          .prepare(
            `UPDATE payment_recurring_payment_update_attempts SET stage = 'update_plan'
              WHERE recurring_payment_id = ?`
          )
          .bind(activated.id)
          .run();
        vi.mocked(subscriptionsProgram.fetchMaybePlan).mockRejectedValueOnce(
          new Error("RPC unavailable")
        );
        const sent = sends();

        const retry = await request();

        expect(retry.status).toBe(409);
        expect(sent).not.toHaveBeenCalled();
        // The new URI may have landed: neither failed nor reset to the old metadata.
        expect((await recurringPaymentDueAt(activated.id)).status).toBe("updating");
        const attempt = await getDb(env)
          .prepare(
            "SELECT status FROM payment_recurring_payment_update_attempts WHERE recurring_payment_id = ?"
          )
          .bind(activated.id)
          .first<{ status: PaymentRecurringPaymentAttemptStatus }>();
        expect(attempt?.status).toBe("processing");
      });

      it.each([
        { metadataUri: "https://example.com/recurring/paused-before-send.json" },
        { amount: "35.00" },
      ])(
        "refuses a claimed update before sending when its issued token pauses: %j",
        async (update) => {
          const { activated, issuedMint, pauseToken } = await activateOnIssuedToken();
          const key = crypto.randomUUID();
          const request = () =>
            app.request(
              actionPath(activated.id),
              {
                method: "PATCH",
                headers: keyed(key),
                body: JSON.stringify({ token: issuedMint, ...update }),
              },
              env
            );
          const sent = sends();
          sent.mockRejectedValueOnce(new Error("process died before signing"));
          expect((await request()).status).toBe(500);
          await leaveUpdateCrashedAt(activated.id, key);
          await getDb(env)
            .prepare(
              `UPDATE payment_recurring_payment_update_attempts SET stage = 'claim'
              WHERE recurring_payment_id = ?`
            )
            .bind(activated.id)
            .run();
          await pauseToken();
          sent.mockClear();

          const retry = await request();

          expect(retry.status).toBe(400);
          expect(sent).not.toHaveBeenCalled();
        }
      );

      it("settles a landed replacement plan but refuses new authorization when its token pauses", async () => {
        const { activated, issuedMint, pauseToken } = await activateOnIssuedToken();
        const key = crypto.randomUUID();
        const request = () =>
          app.request(
            actionPath(activated.id),
            {
              method: "PATCH",
              headers: keyed(key),
              body: JSON.stringify({ token: issuedMint, amount: "35.00" }),
            },
            env
          );
        sendTransactionMock.mockRejectedValueOnce(new Error("process died after broadcast"));
        expect((await request()).status).toBe(500);
        await leaveUpdateCrashedAt(activated.id, key);
        await pauseToken();
        delegationsBesideActiveOld(required(activated.subscriptionPda), {
          exists: false,
          address: address(TEST_SOLANA_ADDRESSES.wallet2),
        });
        const sent = sends();

        const retry = await request();

        expect(retry.status).toBe(400);
        expect(sent).not.toHaveBeenCalled();
        expect(finalizedReads(vi.mocked(subscriptionsProgram.fetchMaybePlan).mock.calls)).toBe(1);
      });

      it("finishes a landed update naming its issued token after the token pauses, without sending it again", async () => {
        const { activated, issuedMint, pauseToken } = await activateOnIssuedToken();
        const key = crypto.randomUUID();
        const metadataUri = "https://example.com/recurring/paused-token.json";
        const request = () =>
          app.request(
            actionPath(activated.id),
            {
              method: "PATCH",
              headers: keyed(key),
              body: JSON.stringify({ token: issuedMint, metadataUri }),
            },
            env
          );
        sendTransactionMock.mockRejectedValueOnce(new Error("process died after broadcast"));
        expect((await request()).status).toBe(500);
        await leaveUpdateCrashedAt(activated.id, key);
        await getDb(env)
          .prepare(
            `UPDATE payment_recurring_payment_update_attempts SET stage = 'update_plan'
              WHERE recurring_payment_id = ?`
          )
          .bind(activated.id)
          .run();
        await pauseToken();
        vi.mocked(subscriptionsProgram.fetchMaybePlan).mockResolvedValue(planAccount(metadataUri));
        const sent = sends();

        const retry = await request();

        expect(retry.status).toBe(200);
        expect((await parseRecurringResponse(retry)).data.recurringPayment).toMatchObject({
          status: "active",
          metadataUri,
        });
        expect(sent).not.toHaveBeenCalled();
        const attempt = await getDb(env)
          .prepare(
            "SELECT status FROM payment_recurring_payment_update_attempts WHERE recurring_payment_id = ?"
          )
          .bind(activated.id)
          .first<{ status: PaymentRecurringPaymentAttemptStatus }>();
        expect(attempt).toEqual({ status: "confirmed" });
      });

      it("keeps a stale cancel in flight when only a lagging `confirmed` view shows it", async () => {
        const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        const key = crypto.randomUUID();
        expect(
          (
            await app.request(
              actionPath(activated.id, "cancel"),
              { method: "POST", headers: keyed(key), body: "{}" },
              env
            )
          ).status
        ).toBe(200);
        await leaveUnsavedSend({ recurringPaymentId: activated.id, operation: "cancel", key });
        // Finality stalled: the cancel shows at `confirmed`, not yet at `finalized`.
        fetchMaybeSubscriptionDelegationMock.mockImplementation(async (_rpc, _pda, config) =>
          delegation(config?.commitment === "confirmed" ? 1_800_000_000n : 0n)
        );
        const sent = sends();

        const retry = await app.request(
          actionPath(activated.id, "cancel"),
          { method: "POST", headers: keyed(crypto.randomUUID()), body: "{}" },
          env
        );

        expect(retry.status).toBe(409);
        expect(sent).not.toHaveBeenCalled();
        expect((await lifecycleAttempts(activated.id, "cancel")).results).toEqual([
          { status: "processing", stage: "submit", signature: null },
        ]);
        expect((await recurringPaymentDueAt(activated.id)).status).toBe("canceling");
      });

      it("sends a cancel the chain does not show", async () => {
        mockDistinctRecentBlockhashes();
        const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        const key = crypto.randomUUID();
        expect(
          (
            await app.request(
              actionPath(activated.id, "cancel"),
              { method: "POST", headers: keyed(key), body: "{}" },
              env
            )
          ).status
        ).toBe(200);
        await leaveUnsavedSend({ recurringPaymentId: activated.id, operation: "cancel", key });
        fetchMaybeSubscriptionDelegationMock.mockResolvedValue(delegation(0n));
        const sent = sends();

        const retry = await app.request(
          actionPath(activated.id, "cancel"),
          { method: "POST", headers: keyed(crypto.randomUUID()), body: "{}" },
          env
        );

        expect(retry.status).toBe(200);
        expect(sent).toHaveBeenCalledTimes(1);
        expect((await lifecycleAttempts(activated.id, "cancel")).results).toEqual([
          { status: "confirmed", stage: "finalize", signature: poolSentSignatures()[3] },
        ]);
      });

      it("finishes a resume whose send landed without sending it again", async () => {
        const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        const lifecycle = (action: "cancel" | "resume", key: string) =>
          app.request(
            actionPath(activated.id, action),
            { method: "POST", headers: keyed(key), body: "{}" },
            env
          );
        expect((await lifecycle("cancel", crypto.randomUUID())).status).toBe(200);
        const key = crypto.randomUUID();
        expect((await lifecycle("resume", key)).status).toBe(200);
        await leaveUnsavedSend({ recurringPaymentId: activated.id, operation: "resume", key });
        // The chain shows the resume: the cancellation's end is cleared.
        fetchMaybeSubscriptionDelegationMock.mockResolvedValue(delegation(0n));
        const sent = sends();

        const retry = await lifecycle("resume", crypto.randomUUID());

        expect(retry.status).toBe(200);
        expect((await parseRecurringResponse(retry)).data.recurringPayment.status).toBe("active");
        expect(sent).not.toHaveBeenCalled();
        expect((await lifecycleAttempts(activated.id, "resume")).results).toEqual([
          { status: "confirmed", stage: "finalize", signature: null },
        ]);
      });

      it("finishes a landed resume after its issued token pauses, without sending it again", async () => {
        const { activated, pauseToken } = await activateOnIssuedToken();
        const lifecycle = (action: "cancel" | "resume", key: string) =>
          app.request(
            actionPath(activated.id, action),
            { method: "POST", headers: keyed(key), body: "{}" },
            env
          );
        expect((await lifecycle("cancel", crypto.randomUUID())).status).toBe(200);
        const key = crypto.randomUUID();
        expect((await lifecycle("resume", key)).status).toBe(200);
        await leaveUnsavedSend({ recurringPaymentId: activated.id, operation: "resume", key });
        await pauseToken();
        fetchMaybeSubscriptionDelegationMock.mockResolvedValue(delegation(0n));
        const sent = sends();

        const retry = await lifecycle("resume", crypto.randomUUID());

        expect(retry.status).toBe(200);
        expect((await parseRecurringResponse(retry)).data.recurringPayment.status).toBe("active");
        expect(sent).not.toHaveBeenCalled();
        expect((await lifecycleAttempts(activated.id, "resume")).results).toEqual([
          { status: "confirmed", stage: "finalize", signature: null },
        ]);
      });

      it("refuses a resume that did not land once its issued token pauses, back to canceled and sending nothing", async () => {
        const { activated, pauseToken } = await activateOnIssuedToken();
        const lifecycle = (action: "cancel" | "resume", key: string) =>
          app.request(
            actionPath(activated.id, action),
            { method: "POST", headers: keyed(key), body: "{}" },
            env
          );
        expect((await lifecycle("cancel", crypto.randomUUID())).status).toBe(200);
        const key = crypto.randomUUID();
        expect((await lifecycle("resume", key)).status).toBe(200);
        await leaveUnsavedSend({ recurringPaymentId: activated.id, operation: "resume", key });
        await pauseToken();
        fetchMaybeSubscriptionDelegationMock.mockResolvedValue(delegation(1_800_000_000n));
        const sent = sends();

        const retry = await lifecycle("resume", crypto.randomUUID());

        expect(retry.status).toBe(400);
        expect(errorResponseSchema.parse(await retry.json()).error.message).toBe(
          "Recurring payments support USD stablecoins and tokens issued in this project; native SOL is not supported"
        );
        expect(sent).not.toHaveBeenCalled();
        expect((await recurringPaymentDueAt(activated.id)).status).toBe("canceled");
      });

      it("finishes an activation whose plan landed before its signature was saved, sending only the subscription", async () => {
        const sourceSigner = recurringExecution.sourceSigner();
        const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        const planId = `psp_${crypto.randomUUID()}`;
        const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
        await getDb(env)
          .prepare(
            `INSERT INTO payment_subscription_plans (
               id, organization_id, project_id, owner_wallet_id, owner_address, token,
               amount, period_hours, program_plan_id, status, created_by, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            planId,
            TEST_ORG.id,
            TEST_PROJECT.id,
            TEST_WALLET_ID,
            sourceSigner.address,
            DEVNET_USDC_MINT,
            "25.00",
            24,
            "1001",
            "draft",
            TEST_USER.id,
            staleAt,
            staleAt
          )
          .run();
        // The earlier run recorded the plan's address, sent the plan, and died
        // before it saved the signature.
        await getDb(env)
          .prepare(
            `UPDATE payment_recurring_payments
                SET status = 'activating', plan_id = ?, plan_pda = ?, updated_at = ?
              WHERE id = ?`
          )
          .bind(planId, TEST_SOLANA_ADDRESSES.wallet3, staleAt, created.id)
          .run();
        await getDb(env)
          .prepare(
            `INSERT INTO payment_recurring_payment_activation_attempts (
               id, organization_id, project_id, recurring_payment_id, status, stage,
               plan_creation_signature, authorization_signature, error, metadata,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'processing', 'create_plan', NULL, NULL, NULL, '{}'::jsonb, ?, ?)`
          )
          .bind(
            `prpa_${crypto.randomUUID()}`,
            TEST_ORG.id,
            TEST_PROJECT.id,
            created.id,
            staleAt,
            staleAt
          )
          .run();
        const fetchMaybePlanMock = vi.mocked(subscriptionsProgram.fetchMaybePlan);
        const sent = sends();

        const retry = await app.request(
          actionPath(created.id, "activate"),
          { method: "POST", headers: keyed(crypto.randomUUID()), body: "{}" },
          env
        );

        expect(retry.status).toBe(200);
        expect((await parseRecurringResponse(retry)).data.recurringPayment).toMatchObject({
          status: "active",
          planCreationSignature: null,
        });
        expect(finalizedReads(fetchMaybePlanMock.mock.calls)).toBe(1);
        expect(sent).toHaveBeenCalledTimes(1);
      });

      it("finishes an update whose old-subscription cancel went out with no answer, without sending it again", async () => {
        const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        // The plan and the subscription land; the old subscription's cancel is
        // sent and its answer is lost.
        rejectPoolSendAfter(2, new Error("RPC response lost"));
        const key = crypto.randomUUID();
        const request = () =>
          app.request(
            actionPath(activated.id),
            { method: "PATCH", headers: keyed(key), body: JSON.stringify({ amount: "35.00" }) },
            env
          );
        expect((await request()).status).toBe(500);
        const [, , , authorizationSignature, oldCancelSignature] = poolSentSignatures();
        const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
        await getDb(env)
          .prepare("UPDATE payment_recurring_payments SET updated_at = ? WHERE id = ?")
          .bind(staleAt, activated.id)
          .run();
        const left = await getDb(env)
          .prepare(
            `UPDATE payment_recurring_payment_update_attempts SET updated_at = ?
              WHERE recurring_payment_id = ? AND status = 'processing'
                AND stage = 'cancel_old_subscription' AND old_cancel_signature = ?`
          )
          .bind(staleAt, activated.id, oldCancelSignature)
          .run();
        expect(left).toBe(1);
        await crashIdempotencyKey(key);
        // The chain shows the old subscription canceled.
        fetchMaybeSubscriptionDelegationMock.mockResolvedValue(delegation(1_800_000_000n));
        const sent = sends();

        const retry = await request();

        expect(retry.status).toBe(200);
        expect((await parseRecurringResponse(retry)).data.recurringPayment).toMatchObject({
          status: "active",
          amount: "35.00",
          authorizationSignature,
        });
        expect(sent).not.toHaveBeenCalled();
        const attempt = await getDb(env)
          .prepare(
            `SELECT status, stage, old_cancel_signature
               FROM payment_recurring_payment_update_attempts WHERE recurring_payment_id = ?`
          )
          .bind(activated.id)
          .first<{
            status: PaymentRecurringPaymentAttemptStatus;
            stage: PaymentRecurringPaymentUpdateAttemptStage;
            old_cancel_signature: string | null;
          }>();
        expect(attempt).toEqual({
          status: "confirmed",
          stage: "finalize",
          old_cancel_signature: oldCancelSignature,
        });
      });

      /**
       * Puts an update that failed at a send back to the moment its process
       * died there: the attempt in flight at that stage and the schedule
       * `updating`, both long enough ago to recover.
       */
      async function leaveUpdateCrashedAt(recurringPaymentId: string, key: string) {
        const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
        await getDb(env)
          .prepare(
            "UPDATE payment_recurring_payments SET status = 'updating', updated_at = ? WHERE id = ?"
          )
          .bind(staleAt, recurringPaymentId)
          .run();
        const updated = await getDb(env)
          .prepare(
            `UPDATE payment_recurring_payment_update_attempts
                SET status = 'processing', error = NULL, updated_at = ?
              WHERE recurring_payment_id = ?`
          )
          .bind(staleAt, recurringPaymentId)
          .run();
        expect(updated).toBe(1);
        await crashIdempotencyKey(key);
      }

      /** Delegations by address: the old subscription active, any other as given. */
      function delegationsBesideActiveOld(
        oldSubscriptionPda: string,
        other: MaybeAccount<subscriptionsProgram.SubscriptionDelegation>
      ) {
        fetchMaybeSubscriptionDelegationMock.mockImplementation(async (_rpc, pda) =>
          pda === oldSubscriptionPda ? { ...delegation(0n), address: pda } : other
        );
      }

      it("finishes an update whose replacement plan landed without sending it again", async () => {
        const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        sendTransactionMock.mockRejectedValueOnce(new Error("process died after broadcast"));
        const key = crypto.randomUUID();
        const request = () =>
          app.request(
            actionPath(activated.id),
            { method: "PATCH", headers: keyed(key), body: JSON.stringify({ amount: "35.00" }) },
            env
          );
        expect((await request()).status).toBe(500);
        await leaveUpdateCrashedAt(activated.id, key);
        // The plan is on chain (the default plan read); no replacement subscription yet.
        delegationsBesideActiveOld(required(activated.subscriptionPda), {
          exists: false,
          address: address(TEST_SOLANA_ADDRESSES.wallet2),
        });
        const sent = sends();

        const retry = await request();

        expect(retry.status).toBe(200);
        expect((await parseRecurringResponse(retry)).data.recurringPayment).toMatchObject({
          status: "active",
          amount: "35.00",
          planCreationSignature: poolSentSignatures()[2],
        });
        // Subscribe and the old subscription's cancel; the plan is not sent again.
        expect(sent).toHaveBeenCalledTimes(2);
      });

      it("refuses a stale same-key retry whose counterparty account now resolves to another address than its replacement plan", async () => {
        const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        const accountId = `counterparty_account_${crypto.randomUUID()}`;
        const now = new Date().toISOString();
        await getDb(env)
          .prepare(
            `INSERT INTO counterparty_accounts (
               id, organization_id, project_id, counterparty_id, account_kind, label,
               details, provider_account_data, status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'crypto_wallet', 'Second wallet', ?, '{}', 'active', ?, ?)`
          )
          .bind(
            accountId,
            TEST_ORG.id,
            TEST_PROJECT.id,
            activated.counterpartyId,
            JSON.stringify({ network: "solana", address: TEST_SOLANA_ADDRESSES.wallet3 }),
            now,
            now
          )
          .run();
        sendTransactionMock.mockRejectedValueOnce(new Error("process died after broadcast"));
        const key = crypto.randomUUID();
        const request = () =>
          app.request(
            actionPath(activated.id),
            {
              method: "PATCH",
              headers: keyed(key),
              body: JSON.stringify({ counterpartyAccountId: accountId }),
            },
            env
          );
        expect((await request()).status).toBe(500);
        await leaveUpdateCrashedAt(activated.id, key);
        // The replacement plan landed whitelisting wallet3; the account now names wallet1.
        delegationsBesideActiveOld(required(activated.subscriptionPda), {
          exists: false,
          address: address(TEST_SOLANA_ADDRESSES.wallet2),
        });
        await getDb(env)
          .prepare("UPDATE counterparty_accounts SET details = ? WHERE id = ?")
          .bind(
            JSON.stringify({ network: "solana", address: TEST_SOLANA_ADDRESSES.wallet1 }),
            accountId
          )
          .run();
        const sent = sends();

        const retry = await request();

        expect(retry.status).toBe(409);
        expect(sent).not.toHaveBeenCalled();
        const row = await getDb(env)
          .prepare(
            "SELECT destination_address, plan_id FROM payment_recurring_payments WHERE id = ?"
          )
          .bind(activated.id)
          .first<{ destination_address: string; plan_id: string }>();
        expect(row).toEqual({
          destination_address: DEFAULT_RECURRING_FIXTURE.destinationAddress,
          plan_id: activated.planId,
        });
      });

      it("finishes an update whose replacement subscription landed without sending it again", async () => {
        const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        rejectPoolSendAfter(1, new Error("process died after broadcast"));
        const key = crypto.randomUUID();
        const request = () =>
          app.request(
            actionPath(activated.id),
            { method: "PATCH", headers: keyed(key), body: JSON.stringify({ amount: "35.00" }) },
            env
          );
        expect((await request()).status).toBe(500);
        await leaveUpdateCrashedAt(activated.id, key);
        // The replacement subscription is on chain and active; the old one still active.
        delegationsBesideActiveOld(required(activated.subscriptionPda), delegation(0n));
        const sent = sends();

        const retry = await request();

        expect(retry.status).toBe(200);
        expect((await parseRecurringResponse(retry)).data.recurringPayment).toMatchObject({
          status: "active",
          amount: "35.00",
          planCreationSignature: poolSentSignatures()[2],
          authorizationSignature: poolSentSignatures()[3],
        });
        // Only the old subscription's cancel.
        expect(sent).toHaveBeenCalledTimes(1);
      });

      async function leaveReplacementAuthorizationUnanswered() {
        mockDistinctRecentBlockhashes();
        const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        rejectPoolSendAfter(1, new Error("RPC response lost"));
        const key = crypto.randomUUID();
        const request = () =>
          app.request(
            actionPath(activated.id),
            { method: "PATCH", headers: keyed(key), body: JSON.stringify({ amount: "35.00" }) },
            env
          );
        expect((await request()).status).toBe(500);
        await leaveUpdateCrashedAt(activated.id, key);
        delegationsBesideActiveOld(required(activated.subscriptionPda), noAccount);
        return {
          recurringPaymentId: activated.id,
          request,
          savedSignature: poolSentSignatures()[3],
        };
      }

      it("sends a replacement subscription again once its saved send expired, finishing the update", async () => {
        const { request, savedSignature } = await leaveReplacementAuthorizationUnanswered();
        answerChainTip(SAVED_LAST_VALID_BLOCK_HEIGHT + 1);
        const sent = sends();

        const retry = await request();

        expect(retry.status).toBe(200);
        const resentSignature = poolSentSignatures()[4];
        expect(resentSignature).not.toBe(savedSignature);
        expect((await parseRecurringResponse(retry)).data.recurringPayment).toMatchObject({
          status: "active",
          amount: "35.00",
          authorizationSignature: resentSignature,
        });
        expect(sent).toHaveBeenCalledTimes(2);
      });

      it("refuses a replacement update retry while its saved subscription send may still land", async () => {
        const { recurringPaymentId, request, savedSignature } =
          await leaveReplacementAuthorizationUnanswered();
        const sent = sends();

        const retry = await request();

        expect(retry.status).toBe(409);
        expect(sent).not.toHaveBeenCalled();
        expect((await recurringPaymentDueAt(recurringPaymentId)).status).toBe("updating");
        expect(
          await getDb(env)
            .prepare(
              `SELECT status, authorization_signature
                 FROM payment_recurring_payment_update_attempts WHERE recurring_payment_id = ?`
            )
            .bind(recurringPaymentId)
            .first<{ status: string; authorization_signature: string | null }>()
        ).toEqual({ status: "processing", authorization_signature: savedSignature });
      });

      it("finishes a stale activation whose subscription landed without sending it again", async () => {
        const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        const planId = `psp_${crypto.randomUUID()}`;
        const subscriptionId = `psub_${crypto.randomUUID()}`;
        const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
        await seedPlanRow(planId, "active", staleAt);
        await getDb(env)
          .prepare(
            `INSERT INTO payment_subscriptions (
               id, organization_id, project_id, plan_id, counterparty_id, subscriber_address,
               status, created_by, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'pending_authorization', ?, ?, ?)`
          )
          .bind(
            subscriptionId,
            TEST_ORG.id,
            TEST_PROJECT.id,
            planId,
            created.counterpartyId,
            recurringExecution.sourceSigner().address,
            TEST_USER.id,
            staleAt,
            staleAt
          )
          .run();
        // The earlier run sent the subscription after recording its address, and died.
        await getDb(env)
          .prepare(
            `UPDATE payment_recurring_payments
                SET status = 'activating', plan_id = ?, subscription_id = ?, plan_pda = ?,
                    plan_created_at = '1770000000', plan_creation_signature = ?,
                    subscription_pda = ?, updated_at = ?
              WHERE id = ?`
          )
          .bind(
            planId,
            subscriptionId,
            TEST_SOLANA_ADDRESSES.wallet3,
            testSignature(1),
            TEST_SOLANA_ADDRESSES.wallet3,
            staleAt,
            created.id
          )
          .run();
        await getDb(env)
          .prepare(
            `INSERT INTO payment_recurring_payment_activation_attempts (
               id, organization_id, project_id, recurring_payment_id, status, stage,
               plan_creation_signature, authorization_signature, error, metadata,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'processing', 'authorize_subscription', ?, NULL, NULL,
               '{}'::jsonb, ?, ?)`
          )
          .bind(
            `prpa_${crypto.randomUUID()}`,
            TEST_ORG.id,
            TEST_PROJECT.id,
            created.id,
            testSignature(1),
            staleAt,
            staleAt
          )
          .run();
        const sent = sends();

        const retry = await app.request(
          actionPath(created.id, "activate"),
          { method: "POST", headers: keyed(crypto.randomUUID()), body: "{}" },
          env
        );

        expect(retry.status).toBe(200);
        expect((await parseRecurringResponse(retry)).data.recurringPayment).toMatchObject({
          status: "active",
          planCreationSignature: testSignature(1),
          authorizationSignature: null,
        });
        expect(sent).not.toHaveBeenCalled();
      });

      it("sends a cancel again once its saved send expired without landing", async () => {
        mockDistinctRecentBlockhashes();
        const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        const key = crypto.randomUUID();
        expect(
          (
            await app.request(
              actionPath(activated.id, "cancel"),
              { method: "POST", headers: keyed(key), body: "{}" },
              env
            )
          ).status
        ).toBe(200);
        await leaveUnsavedSend({ recurringPaymentId: activated.id, operation: "cancel", key });
        await getDb(env)
          .prepare(
            `UPDATE payment_recurring_payment_lifecycle_attempts
                SET signature = ?, last_valid_block_height = ?
              WHERE recurring_payment_id = ? AND operation = 'cancel'`
          )
          .bind(testSignature(7), SAVED_LAST_VALID_BLOCK_HEIGHT, activated.id)
          .run();
        fetchMaybeSubscriptionDelegationMock.mockResolvedValue(delegation(0n));
        answerChainTip(SAVED_LAST_VALID_BLOCK_HEIGHT + 1);
        const sent = sends();

        const retry = await app.request(
          actionPath(activated.id, "cancel"),
          { method: "POST", headers: keyed(crypto.randomUUID()), body: "{}" },
          env
        );

        expect(retry.status).toBe(200);
        expect(sent).toHaveBeenCalledTimes(1);
        expect((await lifecycleAttempts(activated.id, "cancel")).results).toEqual([
          { status: "confirmed", stage: "finalize", signature: poolSentSignatures()[3] },
        ]);
      });

      it("keeps a cancel recoverable when its saved send landed but the account does not show it yet", async () => {
        const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        const key = crypto.randomUUID();
        expect(
          (
            await app.request(
              actionPath(activated.id, "cancel"),
              { method: "POST", headers: keyed(key), body: "{}" },
              env
            )
          ).status
        ).toBe(200);
        await leaveUnsavedSend({ recurringPaymentId: activated.id, operation: "cancel", key });
        await getDb(env)
          .prepare(
            `UPDATE payment_recurring_payment_lifecycle_attempts SET signature = ?
              WHERE recurring_payment_id = ? AND operation = 'cancel'`
          )
          .bind(testSignature(7), activated.id)
          .run();
        // History has the signature succeeding; this node's account read lags behind it.
        fetchMaybeSubscriptionDelegationMock.mockResolvedValue(delegation(0n));
        recordSignatureStatus(testSignature(7), null);
        const sent = sends();

        const retry = await app.request(
          actionPath(activated.id, "cancel"),
          { method: "POST", headers: keyed(crypto.randomUUID()), body: "{}" },
          env
        );

        expect(retry.status).toBe(409);
        expect(sent).not.toHaveBeenCalled();
        expect((await lifecycleAttempts(activated.id, "cancel")).results).toEqual([
          { status: "processing", stage: "submit", signature: testSignature(7) },
        ]);
        expect((await recurringPaymentDueAt(activated.id)).status).toBe("canceling");
      });

      it("refuses a reset activation retry while its plan is still landing, instead of sending it again", async () => {
        const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
        const planId = `psp_${crypto.randomUUID()}`;
        const now = new Date().toISOString();
        await seedPlanRow(planId, "draft", now);
        // Seconds ago a run recorded the plan's address and sent it, its save
        // failed, and the activation was reset: it can be retried at once.
        await getDb(env)
          .prepare(
            `UPDATE payment_recurring_payments
                SET status = 'pending_activation', plan_id = ?, plan_pda = ?, updated_at = ?
              WHERE id = ?`
          )
          .bind(planId, TEST_SOLANA_ADDRESSES.wallet3, now, created.id)
          .run();
        // The plan has landed at `confirmed` but is not final yet.
        vi.mocked(subscriptionsProgram.fetchMaybePlan)
          .mockResolvedValueOnce(noAccount)
          .mockResolvedValueOnce(planAccount());
        const sent = sends();
        const activate = () =>
          app.request(
            actionPath(created.id, "activate"),
            { method: "POST", headers: keyed(crypto.randomUUID()), body: "{}" },
            env
          );

        const landing = await activate();

        expect(landing.status).toBe(409);
        expect(sent).not.toHaveBeenCalled();
        // The plan may be on chain: the schedule stays `activating` for recovery,
        // not reset to `pending_activation`, where the cron would never pick it up.
        expect((await recurringPaymentDueAt(created.id)).status).toBe("activating");

        // Once stale and final, the cron takes the plan as landed and sends only the subscription.
        await getDb(env)
          .prepare("UPDATE payment_recurring_payments SET updated_at = ? WHERE id = ?")
          .bind(new Date(Date.now() - 16 * 60 * 1000).toISOString(), created.id)
          .run();
        expect(await collectDueRecurringPaymentsIn("sandbox", new Date())).toMatchObject({
          recovered: 1,
        });

        expect((await recurringPaymentDueAt(created.id)).status).toBe("active");
        expect(sent).toHaveBeenCalledTimes(1);
      });
    });
  });
});
