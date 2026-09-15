import type * as solanaRpc from "@sdp/rpc/solana";
import {
  isCollectableRecurringPaymentStatus,
  PAYMENT_RECURRING_PAYMENT_LIFECYCLE_OPERATIONS,
  type PaymentSubscriptionCollectionAttemptMetadata,
  RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS,
  RECURRING_PAYMENT_STATUSES_WITH_RECOVERABLE_COLLECTION,
  SUCCESSFUL_PAYMENT_TRANSFER_STATUSES,
  type TokenStatus,
} from "@sdp/types";
import { getBase58Codec } from "@solana/codecs";
import {
  address,
  blockhash,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  signature,
} from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories";
import * as paymentRecurringPaymentsRepositoryPostgres from "@/db/repositories/payment-recurring-payments.repository.postgres";
import * as paymentSubscriptionsRepositoryPostgres from "@/db/repositories/payment-subscriptions.repository.postgres";
import * as paymentsRepositoryPostgres from "@/db/repositories/payments.repository.postgres";
import app from "@/index";
import { AppError, PUBLIC_INTERNAL_ERROR_MESSAGE } from "@/lib/errors";
import { errorResponseSchema, successResponseSchema } from "@/openapi/schemas/base";
import { paymentRecurringPaymentListResponseSchema } from "@/openapi/schemas/payments";
import { rootLogger } from "@/runtime/logger";
import { SigningService } from "@/services/domain/signing.service";
import { collectDueRecurringPayments } from "@/services/jobs/collect-recurring-payments";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  confirmTransactionMock,
  createFeePaymentAdapterMock,
  createOrgSignerForCustodyWalletMock,
  createOrgSignerMock,
  DEVNET_USDC_MINT,
  fetchMaybeSubscriptionDelegationMock,
  getAccountInfoMock,
  getRecentBlockhashMock,
  getTransactionMock,
  installPaymentsRouteTestHooks,
  mockRecurringActivationRpc,
  mockTokenSupplyDecimalsOnce,
  recurringCollectionTransactionForSignature,
  seedCachedKey,
  seedCounterparty,
  sendTransactionMock,
  sendTransactionPreflightError,
  TEST_API_KEY,
  TEST_CONFIG_ID,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

import {
  activateRecurringPaymentFixture,
  createRecurringPaymentFixture,
  DEFAULT_RECURRING_FIXTURE,
  installRecurringExecutionHooks,
  parseCollectionResponse,
  parseRecurringResponse,
  RECURRING_HEADERS,
  seedRecurringCollectionJournal,
  setRecurringCollectionDue,
  testSignature,
} from "@/test/helpers/recurring-payments";

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

async function activateRecurringPaymentForTest(headers: Record<string, string>) {
  return activateRecurringPaymentFixture({ ...DEFAULT_RECURRING_FIXTURE, headers });
}

function recurringExecutionCallCounts() {
  return {
    feePaymentAdapter: createFeePaymentAdapterMock.mock.calls.length,
    custodySigner: createOrgSignerForCustodyWalletMock.mock.calls.length,
    providerSigner: createOrgSignerMock.mock.calls.length,
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
                WHERE t.provider_data->>'recurringPaymentId' = rp.id) AS collection_transfers,
              (SELECT COUNT(*)::int
                 FROM policy_evaluations) AS policy_evaluations,
              (SELECT COUNT(*)::int
                 FROM approval_requests) AS approval_requests,
              (SELECT COUNT(*)::int
                 FROM wallet_operations) AS all_wallet_operations,
              (SELECT COUNT(*)::int
                 FROM wallet_operations wo
                WHERE wo.organization_id = rp.organization_id
                  AND wo.project_id = rp.project_id
                  AND wo.raw_payload->>'recurringPaymentId' = rp.id) AS wallet_operations
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
         (id, custody_config_id, wallet_id, public_key, status)
       VALUES (?, ?, ?, ?, 'active')`
    )
    .bind(UNBOUND_CUSTODY_WALLET_ID, TEST_CONFIG_ID, UNBOUND_WALLET_ID, unboundWallet.address)
    .run();
}

async function bindApiKeyToWallet(walletId: string, custodyWalletId: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
       VALUES (?, ?, ?, '["*"]')`
    )
    .bind(`akw_${custodyWalletId}`, TEST_API_KEY.id, walletId)
    .run();
  await seedCachedKey({
    walletScope: "selected",
    signingWalletId: walletId,
    signingWalletIds: [walletId],
    walletBindings: [{ walletId, custodyWalletId, permissions: ["*"] }],
  });
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

const unboundWalletCases: Array<{
  route: string;
  expectedStatus: number;
  expectedMessage: string;
  request: (payment: SeededPendingRecurringPayment) => {
    path: string;
    method?: string;
    body: Record<string, unknown>;
  };
}> = [
  {
    route: "create",
    expectedStatus: 403,
    expectedMessage: "API key is not authorized for the requested wallet",
    request: (payment) => ({
      path: "/v1/payments/recurring-payments",
      body: {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        counterpartyId: payment.counterpartyId,
        counterpartyAccountId: payment.counterpartyAccountId,
        token: DEVNET_USDC_MINT,
        amount: "25.00",
        periodHours: 24,
      },
    }),
  },
  {
    route: "update",
    expectedStatus: 404,
    expectedMessage: "Recurring payment not found",
    request: (payment) => ({
      path: `/v1/payments/recurring-payments/${payment.id}`,
      method: "PATCH",
      body: { amount: "26.00" },
    }),
  },
  {
    route: "activate",
    expectedStatus: 404,
    expectedMessage: "Recurring payment not found",
    request: (payment) => ({
      path: `/v1/payments/recurring-payments/${payment.id}/activate`,
      body: {},
    }),
  },
  {
    route: "cancel",
    expectedStatus: 404,
    expectedMessage: "Recurring payment not found",
    request: (payment) => ({
      path: `/v1/payments/recurring-payments/${payment.id}/cancel`,
      body: {},
    }),
  },
  {
    route: "collect",
    expectedStatus: 404,
    expectedMessage: "Recurring payment not found",
    request: (payment) => ({
      path: `/v1/payments/recurring-payments/${payment.id}/collect`,
      body: {},
    }),
  },
  {
    route: "resume",
    expectedStatus: 404,
    expectedMessage: "Recurring payment not found",
    request: (payment) => ({
      path: `/v1/payments/recurring-payments/${payment.id}/resume`,
      body: {},
    }),
  },
];

describe("Payments routes — recurring", () => {
  installPaymentsRouteTestHooks();
  const recurringExecution = installRecurringExecutionHooks();

  beforeEach(() => {
    createOrgSignerForCustodyWalletMock.mockImplementation((signerEnv, orgId, projectId) =>
      createOrgSignerMock(signerEnv, orgId, projectId)
    );
  });

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
        recurringExecution
          .signAndSendMock()
          .mockResolvedValue(
            signature(
              "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe"
            )
          );
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
    await expectTokenRejected(pausedMint);

    const issuedRes = await createRecurring(issuedMint);
    expect(issuedRes.status).toBe(201);
    const issuedBody = await parseRecurringResponse(issuedRes);
    expect(issuedBody.data.recurringPayment.token).toBe(issuedMint);

    const stableRes = await createRecurring("USDC");
    expect(stableRes.status).toBe(201);
    const stableBody = await parseRecurringResponse(stableRes);
    expect(stableBody.data.recurringPayment.token).toBe(DEVNET_USDC_MINT);
  });

  it("activates recurring payments through SDP API routes", async () => {
    const signAndSendMock = recurringExecution.signAndSendMock();
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
    expect(activateBody.data.recurringPayment).toMatchObject({
      id: created.id,
      status: "active",
      planCreatedAt: "1770000000",
      planCreationSignature: testSignature(1),
      authorizationSignature: testSignature(2),
    });
    expect(activateBody.data.recurringPayment.planId).toMatch(/^psp_/);
    expect(activateBody.data.recurringPayment.subscriptionId).toMatch(/^psub_/);
    expect(activateBody.data.recurringPayment.planPda).toBeTruthy();
    expect(activateBody.data.recurringPayment.subscriptionPda).toBeTruthy();
    expect(activateBody.data.recurringPayment.subscriptionAuthorityAddress).toBeTruthy();
    expect(activateBody.data.recurringPayment.nextCollectionDueAt).toBeTruthy();
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("repairs a finalized activation attempt on replay", async () => {
    const signAndSendMock = recurringExecution.signAndSendMock();
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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
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

  it("rolls back subscription and recurring activation finalization together", async () => {
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

    expect(response.status).toBe(500);
    const rows = await getDb(env)
      .prepare(
        `SELECT rp.status AS recurring_status,
                rp.plan_id,
                rp.subscription_id,
                ps.status AS subscription_status,
                ps.authorization_signature,
                a.status AS attempt_status,
                a.stage AS attempt_stage
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
      }>();
    expect(rows).toMatchObject({
      recurring_status: "pending_activation",
      plan_id: expect.any(String),
      subscription_id: expect.any(String),
      subscription_status: "pending_authorization",
      authorization_signature: null,
      attempt_status: "failed",
      attempt_stage: "finalize",
    });
  });

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

  it("updates active recurring payment metadata in place on the existing on-chain plan", async () => {
    const updatePlanSignature = signature(
      "3agLAsjf2Qba9W59cqxbXFoPRJFDFKB3efqYRhT6wLxaM4KwV31NVrLDjKAw22hR1GFcQc4mePSjZ6XZEHUAjN4c"
    );
    const signAndSendMock = recurringExecution.signAndSendMock();
    signAndSendMock.mockResolvedValueOnce(updatePlanSignature);
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
    expect(signAndSendMock).toHaveBeenCalledTimes(3);

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
      plan_update_signature: updatePlanSignature,
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

  it("replaces active recurring payment records for term changes and cancels the old subscription", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    const replacementCustodyWalletId = "cwlt_recurring_replacement";
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted,
              encryption_version, status)
           VALUES ('cust_cfg_recurring_replacement', ?, ?, 'local', 'test-config',
                   'sdp-custody-encryption-v1', 'active')`
        )
        .bind(TEST_ORG.id, TEST_PROJECT.id),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, status)
           VALUES (?, 'cust_cfg_recurring_replacement', ?, ?, 'active')`
        )
        .bind(replacementCustodyWalletId, TEST_WALLET_ID, sourceSigner.address),
    ]);
    const replacementPlanSignature = signature(
      "3agLAsjf2Qba9W59cqxbXFoPRJFDFKB3efqYRhT6wLxaM4KwV31NVrLDjKAw22hR1GFcQc4mePSjZ6XZEHUAjN4c"
    );
    const replacementAuthSignature = signature(
      "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
    );
    const oldCancelSignature = signature(
      "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV"
    );
    const signAndSendMock = recurringExecution
      .signAndSendMock()
      .mockResolvedValueOnce(replacementPlanSignature)
      .mockResolvedValueOnce(replacementAuthSignature)
      .mockResolvedValueOnce(oldCancelSignature);
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });
    const firstCollectionAt = "2026-07-02T00:00:00.000Z";
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET first_collection_at = ? WHERE id = ?")
      .bind(firstCollectionAt, activated.id)
      .run();

    const approvalOperationId = "wop_recurring_source_change_fence";
    const approvalRequestId = "appr_recurring_source_change_fence";
    const policyEvaluationId = "peval_recurring_source_change_fence";
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO wallet_operations
             (id, organization_id, project_id, custody_wallet_id, wallet_id, source,
              operation_family, operation_type, raw_payload, status)
           VALUES (?, ?, ?, ?, ?, 'api', 'payment', 'recurring_payment_collection',
                   ?::jsonb, 'pending_approval')`
        )
        .bind(
          approvalOperationId,
          TEST_ORG.id,
          TEST_PROJECT.id,
          TEST_CUSTODY_WALLET_ID,
          TEST_WALLET_ID,
          JSON.stringify({
            recurringPaymentId: activated.id,
            collectionDueAt: activated.nextCollectionDueAt,
          })
        ),
      getDb(env)
        .prepare(
          `INSERT INTO approval_requests
             (id, organization_id, project_id, wallet_operation_id, status)
           VALUES (?, ?, ?, ?, 'pending')`
        )
        .bind(approvalRequestId, TEST_ORG.id, TEST_PROJECT.id, approvalOperationId),
      getDb(env)
        .prepare(
          `INSERT INTO policy_evaluations
             (id, wallet_operation_id, decision, reason_code, requires_approval,
              approval_request_id)
           VALUES (?, ?, 'approval_required', 'test_source_change_fence', true, ?)`
        )
        .bind(policyEvaluationId, approvalOperationId, approvalRequestId),
    ]);

    const replacementRequest = {
      sourceCustodyWalletId: replacementCustodyWalletId,
      amount: "35.00",
      periodHours: 48,
      nextCollectionDueAt: null,
    };
    const signerCallsBeforeFence = createOrgSignerForCustodyWalletMock.mock.calls.length;
    const providerCallsBeforeFence = signAndSendMock.mock.calls.length;
    const blockedUpdateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers: RECURRING_HEADERS,
        body: JSON.stringify(replacementRequest),
      },
      env
    );
    expect(blockedUpdateRes.status).toBe(409);
    const blockedUpdateBody = errorResponseSchema.parse(await blockedUpdateRes.json());
    expect(blockedUpdateBody.error.details).toEqual({
      walletOperationId: approvalOperationId,
      policyEvaluationId,
      approvalRequestId,
    });
    expect(createOrgSignerForCustodyWalletMock).toHaveBeenCalledTimes(signerCallsBeforeFence);
    expect(signAndSendMock).toHaveBeenCalledTimes(providerCallsBeforeFence);
    expect(
      await getDb(env)
        .prepare(
          `SELECT COUNT(*)::int AS count
             FROM wallet_operations
            WHERE operation_type = 'recurring_payment_update'`
        )
        .first<{ count: number }>()
    ).toEqual({ count: 0 });
    expect(
      await getDb(env)
        .prepare("SELECT source_custody_wallet_id FROM payment_recurring_payments WHERE id = ?")
        .bind(activated.id)
        .first<{ source_custody_wallet_id: string | null }>()
    ).toEqual({ source_custody_wallet_id: TEST_CUSTODY_WALLET_ID });

    await getDb(env)
      .prepare("UPDATE approval_requests SET status = 'rejected' WHERE id = ?")
      .bind(approvalRequestId)
      .run();

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
    expect(signAndSendMock).toHaveBeenCalledTimes(5);

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
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted,
              encryption_version, status)
           VALUES ('cust_cfg_recurring_race_replacement', ?, ?, 'local', 'test-config',
                   'sdp-custody-encryption-v1', 'active')`
        )
        .bind(TEST_ORG.id, TEST_PROJECT.id),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, status)
           VALUES (?, 'cust_cfg_recurring_race_replacement', ?, ?, 'active')`
        )
        .bind(replacementCustodyWalletId, TEST_WALLET_ID, sourceSigner.address),
    ]);
    const signAndSendMock = recurringExecution
      .signAndSendMock()
      .mockResolvedValueOnce(
        signature(
          "3agLAsjf2Qba9W59cqxbXFoPRJFDFKB3efqYRhT6wLxaM4KwV31NVrLDjKAw22hR1GFcQc4mePSjZ6XZEHUAjN4c"
        )
      )
      .mockResolvedValueOnce(
        signature(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        )
      )
      .mockResolvedValueOnce(
        signature(
          "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV"
        )
      );
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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    expect(sendTransactionMock).toHaveBeenCalledOnce();
  });

  it("rejects active replacement next due dates before replacement transactions are submitted", async () => {
    const signAndSendMock = recurringExecution.signAndSendMock();
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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);

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
    const signAndSendMock = recurringExecution.signAndSendMock();
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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("clamps stale metadata update retries after the subscription period advances", async () => {
    const updatePlanSignature = signature(
      "3agLAsjf2Qba9W59cqxbXFoPRJFDFKB3efqYRhT6wLxaM4KwV31NVrLDjKAw22hR1GFcQc4mePSjZ6XZEHUAjN4c"
    );
    const signAndSendMock = recurringExecution.signAndSendMock();
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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);

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
    mockRecurringActivationRpc({ tokenAccounts: [] });
    const sourceSigner = recurringExecution.sourceSigner();
    const signAndSendMock = recurringExecution.signAndSendMock();
    signAndSendMock.mockResolvedValue(
      signature(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV"
      )
    );
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
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
    const subscriptionRow = await getDb(env)
      .prepare("SELECT subscriber_token_account FROM payment_subscriptions WHERE id = ?")
      .bind(activateBody.data.recurringPayment.subscriptionId)
      .first<{ subscriber_token_account: string | null }>();
    expect(subscriptionRow?.subscriber_token_account).toBe(expectedSourceAta);
  });

  it("cancels active recurring payments through SDP API routes", async () => {
    const cancelSignature = signature(
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13"
    );
    const signAndSendMock = recurringExecution.signAndSendMock();
    signAndSendMock.mockResolvedValue(cancelSignature);
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
      signature: cancelSignature,
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
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
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
    const resumeSignature = signature(
      "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe"
    );
    const signAndSendMock = recurringExecution.signAndSendMock();
    signAndSendMock.mockResolvedValue(resumeSignature);
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
      signature: resumeSignature,
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
    expect(signAndSendMock).toHaveBeenCalledTimes(4);
  });

  it.each(PAYMENT_RECURRING_PAYMENT_LIFECYCLE_OPERATIONS)(
    "recovers submitted recurring payment $operation attempts",
    async (operation) => {
      const submittedSignature = signature(
        operation === "cancel"
          ? "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13"
          : "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe"
      );
      const signAndSendMock = recurringExecution.signAndSendMock();
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
      if (operation === "resume") {
        signAndSendMock.mockResolvedValue(
          signature(
            "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe"
          )
        );
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

      const response = await app.request(
        `/v1/payments/recurring-payments/${activated.id}/${operation}`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      );

      expect(response.status).toBe(200);
      const body = await parseRecurringResponse(response);
      expect(body.data.recurringPayment.status).toBe(transition.finalStatus);
      expect(signAndSendMock).toHaveBeenCalledTimes(operation === "cancel" ? 2 : 3);
      expect(confirmTransactionMock).toHaveBeenCalledWith(
        expect.anything(),
        submittedSignature,
        expect.objectContaining({ commitment: "confirmed" })
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
    const signAndSendMock = recurringExecution.signAndSendMock();
    signAndSendMock.mockResolvedValue(
      signature(
        "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe"
      )
    );
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
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("resets recurring payment cancellation claims when subscription validation fails", async () => {
    const signAndSendMock = recurringExecution.signAndSendMock();
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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("cancels without waiting for confirmed collection finalization", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    const collectionSignature = signature(
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13"
    );
    const cancelSignature = signature(
      "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe"
    );
    const signAndSendMock = recurringExecution.signAndSendMock();
    signAndSendMock.mockResolvedValue(cancelSignature);
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
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("collects with the exact custody wallet when a Provider wallet ID could select another signer", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    const signAsFeePayerMock = recurringExecution.signAsFeePayerMock();
    const signAndSendMock = recurringExecution.signAndSendMock();
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const duplicateProviderWalletSigner = await generateKeyPairSigner();
    createOrgSignerMock.mockResolvedValue(duplicateProviderWalletSigner);
    createOrgSignerForCustodyWalletMock.mockResolvedValue(sourceSigner);
    const providerSignerCallsBeforeCollection = createOrgSignerMock.mock.calls.length;
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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    expect(signAsFeePayerMock).toHaveBeenCalledTimes(1);
    expect(sendTransactionMock).toHaveBeenCalledTimes(1);
    expect(createOrgSignerForCustodyWalletMock).toHaveBeenCalledWith(
      env,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_CUSTODY_WALLET_ID
    );
    expect(createOrgSignerMock).toHaveBeenCalledTimes(providerSignerCallsBeforeCollection);
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
    expect(sendTransactionMock).toHaveBeenCalledOnce();
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
    expect(sendTransactionMock).not.toHaveBeenCalled();
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

  it("rolls back the collection transfer when attempt linking fails", async () => {
    const signAndSendMock = recurringExecution.signAndSendMock();
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
    expect(sendTransactionMock).not.toHaveBeenCalled();
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    const attempt = await getDb(env)
      .prepare(
        `SELECT status, transfer_id
           FROM payment_subscription_collection_attempts
          WHERE subscription_id = ? AND due_at = ?`
      )
      .bind(activated.subscriptionId, dueAt)
      .first<{ status: string; transfer_id: string | null }>();
    expect(attempt).toEqual({ status: "failed", transfer_id: null });
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
    const signAndSendMock = recurringExecution.signAndSendMock();
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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    expect(sendTransactionMock).toHaveBeenCalledTimes(1);
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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    expect(sendTransactionMock).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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
      const signAndSendMock = recurringExecution.signAndSendMock();
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
      expect(signAndSendMock).toHaveBeenCalledTimes(2);
      expect(sendTransactionMock).toHaveBeenCalledTimes(1);
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
    const getAccountInfo = getAccountInfoMock.getMockImplementation();
    if (!getAccountInfo) {
      throw new Error("Account info mock is not installed");
    }
    getAccountInfoMock.mockImplementationOnce(async (...args) => {
      if (signalMintLookupReached) {
        signalMintLookupReached();
      }
      await mintLookupReleased;
      return getAccountInfo(...args);
    });
    mockTokenSupplyDecimalsOnce();

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
      const signAndSendMock = recurringExecution.signAndSendMock();
      const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
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
      expect(signAndSendMock).toHaveBeenCalledTimes(2);
    }
  );

  it("retries recurring payment collection after pre-submission crash", async () => {
    const signAndSendMock = recurringExecution.signAndSendMock();
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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    expect(sendTransactionMock).toHaveBeenCalledTimes(1);
  });

  it("does not fail fresh transferless recurring payment attempts during recovery", async () => {
    const signAndSendMock = recurringExecution.signAndSendMock();
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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("does not fail fresh unsigned recurring payment transfers during recovery", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    const signAndSendMock = recurringExecution.signAndSendMock();
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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("journals failed recovered recurring payment collection attempts and allows retry", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    const submittedSignature = signature(
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13"
    );
    const signAndSendMock = recurringExecution.signAndSendMock();
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
    confirmTransactionMock.mockImplementation(async (_rpc, signature) => ({
      signature,
      slot: 101n,
      confirmationStatus: "confirmed",
      err: signature === submittedSignature ? { InstructionError: [0, "Custom"] } : null,
    }));

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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it.each(SUCCESSFUL_PAYMENT_TRANSFER_STATUSES)(
    "recovers %s collection transfers without reopening the due period",
    async (transferStatus) => {
      const sourceSigner = recurringExecution.sourceSigner();
      const submittedSignature = signature(
        "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13"
      );
      const signAndSendMock = recurringExecution.signAndSendMock();
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
      confirmTransactionMock.mockRejectedValue(
        new Error("Transaction history expired from the status cache")
      );
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
      expect(confirmTransactionMock).toHaveBeenCalledWith(
        expect.anything(),
        submittedSignature,
        expect.objectContaining({ commitment: "confirmed" })
      );
      const attempt = await getDb(env)
        .prepare("SELECT status, error FROM payment_subscription_collection_attempts WHERE id = ?")
        .bind(attemptId)
        .first<{ status: string; error: string | null }>();
      expect(attempt).toMatchObject({ status: "confirmed", error: null });
      expect(signAndSendMock).toHaveBeenCalledTimes(2);
    }
  );

  it("rejects early recurring payment collection", async () => {
    const signAndSendMock = recurringExecution.signAndSendMock();
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(collectRes.status).toBe(400);
    const collectBody = errorResponseSchema.parse(await collectRes.json());
    expect(collectBody.error.message).toContain("not due yet");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    const attempts = await getDb(env)
      .prepare("SELECT id FROM payment_subscription_collection_attempts")
      .all<{ id: string }>();
    expect(attempts.results).toHaveLength(0);
  });

  it("journals failed pre-submission recurring payment collection attempts", async () => {
    const signAndSendMock = recurringExecution.signAndSendMock();
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });
    createOrgSignerMock.mockRejectedValueOnce(new Error("collection signer unavailable"));

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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("journals an unresolved automated collection once per cooldown", async () => {
    const signAndSendMock = recurringExecution.signAndSendMock();
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

    expect(await collectDueRecurringPayments(env, now)).toEqual({
      recovered: 0,
      collected: 0,
      failed: 1,
      skipped: 0,
    });
    expect(await collectDueRecurringPayments(env, new Date(now.getTime() + 60 * 1000))).toEqual({
      recovered: 0,
      collected: 0,
      failed: 0,
      skipped: 0,
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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("journals one automated collection attempt when runtime admission denies the wallet", async () => {
    const signAndSendMock = recurringExecution.signAndSendMock();
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
        collectDueRecurringPayments(env, now),
        collectDueRecurringPayments(env, now),
      ]);
      expect(runs).toEqual([
        { recovered: 0, collected: 0, failed: 0, skipped: 1 },
        { recovered: 0, collected: 0, failed: 0, skipped: 1 },
      ]);
      expect(await collectDueRecurringPayments(env, new Date(now.getTime() + 60 * 1000))).toEqual({
        recovered: 0,
        collected: 0,
        failed: 0,
        skipped: 0,
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

    const collectionOperations = await getDb(env)
      .prepare(
        `SELECT COUNT(*)::int AS count
           FROM wallet_operations
          WHERE operation_type = 'recurring_payment_collection'`
      )
      .first<{ count: number }>();
    const collectionTransfers = await getDb(env)
      .prepare(
        `SELECT COUNT(*)::int AS count
           FROM payment_transfers
          WHERE provider_data->>'recurringPaymentId' = ?`
      )
      .bind(recurringPayment.id)
      .first<{ count: number }>();
    expect(collectionOperations).toEqual({ count: 0 });
    expect(collectionTransfers).toEqual({ count: 0 });
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("journals failed activation attempts and allows activation retry", async () => {
    const signAndSendMock = recurringExecution.signAndSendMock();
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
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("recovers stale activating recurring payments without recreating the plan", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    const authorizationSignature = testSignature(1);
    const signAndSendMock = recurringExecution.signAndSendMock();
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
    expect(staleRetryBody.data.recurringPayment).toMatchObject({
      status: "active",
      authorizationSignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(1);
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

  it("recovers stale authorized recurring payments without re-confirming old signatures", async () => {
    const sourceSigner = recurringExecution.sourceSigner();
    confirmTransactionMock.mockRejectedValue(new Error("transaction history expired"));
    const signAndSendMock = recurringExecution.signAndSendMock();
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
    expect(confirmTransactionMock).not.toHaveBeenCalled();
    expect(signAndSendMock).not.toHaveBeenCalled();
  });

  it("journals failed on-chain activation attempts and retries with a fresh signature", async () => {
    const _sourceSigner = recurringExecution.sourceSigner();
    mockDistinctRecentBlockhashes();
    const failedPlanSignature = testSignature(1);
    const retryPlanSignature = testSignature(2);
    const retryAuthorizationSignature = signature(
      "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV"
    );
    const signAndSendMock = recurringExecution.signAndSendMock();
    signAndSendMock.mockResolvedValueOnce(retryAuthorizationSignature);
    confirmTransactionMock
      .mockResolvedValueOnce({
        signature: failedPlanSignature,
        slot: 100n,
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, "Custom"] },
      })
      .mockResolvedValue({
        signature: retryPlanSignature,
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

    const retryRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPayment.id}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(retryRes.status).toBe(200);
    const retryBody = await parseRecurringResponse(retryRes);
    expect(retryBody.data.recurringPayment).toMatchObject({
      status: "active",
      planCreationSignature: retryPlanSignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("clears failed authorization signatures when finalization cannot find the subscription", async () => {
    const _sourceSigner = recurringExecution.sourceSigner();
    mockDistinctRecentBlockhashes();
    fetchMaybeSubscriptionDelegationMock.mockResolvedValueOnce({
      exists: false,
      address: address(TEST_SOLANA_ADDRESSES.wallet3),
    });
    const planSignature = testSignature(1);
    const retryAuthorizationSignature = signature(
      "3eWxmHfS3EPf7nmtdDQ6CTwWqCnX2bAdtc9h1kReBLbqjP99kphnf3UhpSGA8qpmkHxnhqsWyVbRoQY2yagRZkzp"
    );
    const signAndSendMock = recurringExecution.signAndSendMock();
    signAndSendMock.mockResolvedValueOnce(retryAuthorizationSignature);
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
      planCreationSignature: planSignature,
      authorizationSignature: null,
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
      stage: "finalize",
      error: "Subscription authorization was not found on-chain",
    });

    const retryRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPayment.id}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(retryRes.status).toBe(200);
    const retryBody = await parseRecurringResponse(retryRes);
    expect(retryBody.data.recurringPayment).toMatchObject({
      status: "active",
      planCreationSignature: planSignature,
      authorizationSignature: retryAuthorizationSignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it.each(unboundWalletCases)(
    "rejects a selected-wallet API key bound to another wallet on $route",
    async ({ expectedStatus, expectedMessage, request }) => {
      await seedUnboundWallet();
      const payment = await seedPendingRecurringPayment();
      await bindApiKeyToWallet(UNBOUND_WALLET_ID, UNBOUND_CUSTODY_WALLET_ID);
      const before = await recurringExecutionSnapshot(payment.id);
      const executionCalls = recurringExecutionCallCounts();

      const { path, method = "POST", body } = request(payment);
      const response = await app.request(
        path,
        { method, headers: RECURRING_HEADERS, body: JSON.stringify(body) },
        env
      );

      expect(response.status).toBe(expectedStatus);
      const responseBody = errorResponseSchema.parse(await response.json());
      expect(responseBody.error.message).toBe(expectedMessage);
      expect(await recurringExecutionSnapshot(payment.id)).toEqual(before);
      expect(recurringExecutionCallCounts()).toEqual(executionCalls);
    }
  );

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

  it("rejects a source change to a wallet outside the API key bindings", async () => {
    await seedUnboundWallet();
    const payment = await seedPendingRecurringPayment();
    await bindApiKeyToWallet(TEST_WALLET_ID, TEST_CUSTODY_WALLET_ID);

    const allowedResponse = await app.request(
      `/v1/payments/recurring-payments/${payment.id}`,
      {
        method: "PATCH",
        headers: RECURRING_HEADERS,
        body: JSON.stringify({ amount: "26.00" }),
      },
      env
    );
    expect(allowedResponse.status).toBe(200);
    const before = await recurringExecutionSnapshot(payment.id);
    const executionCalls = recurringExecutionCallCounts();

    const response = await app.request(
      `/v1/payments/recurring-payments/${payment.id}`,
      {
        method: "PATCH",
        headers: RECURRING_HEADERS,
        body: JSON.stringify({ sourceCustodyWalletId: UNBOUND_CUSTODY_WALLET_ID }),
      },
      env
    );

    expect(response.status).toBe(403);
    const responseBody = errorResponseSchema.parse(await response.json());
    expect(responseBody.error.message).toBe("API key is not authorized for the requested wallet");
    expect(await recurringExecutionSnapshot(payment.id)).toEqual(before);
    expect(recurringExecutionCallCounts()).toEqual(executionCalls);
  });
});
