import { WELL_KNOWN_TOKENS } from "@sdp/types";
import {
  address,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import {
  AccountDiscriminator,
  CURRENT_PROGRAM_VERSION,
  getSubscriptionDelegationEncoder,
  SUBSCRIPTION_SIZE,
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
} from "@solana/subscriptions";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories/payment-subscriptions.repository.postgres";
import app from "@/index";
import { errorResponseSchema, successResponseSchema } from "@/openapi/schemas/base";
import { counterpartyResponseSchema } from "@/openapi/schemas/counterparties";
import {
  paymentSubscriptionListResponseSchema,
  paymentSubscriptionPlanListResponseSchema,
  paymentSubscriptionPlanResponseSchema,
  paymentSubscriptionResponseSchema,
  preparePaymentSubscriptionAuthorizationResponseSchema,
  preparePaymentSubscriptionCollectionResponseSchema,
  preparePaymentSubscriptionLifecycleResponseSchema,
  preparePaymentSubscriptionPlanResponseSchema,
} from "@/openapi/schemas/payments";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcStub, type JsonRpcResult } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  DEVNET_USDC_MINT,
  fetchMaybeSubscriptionDelegationMock,
  getAccountInfoMock,
  getRecentBlockhashMock,
  installPaymentsRouteTestHooks,
  seedCachedKey,
  seedCounterparty,
  seedProductionPrivyWalletUnderTestKey,
  TEST_ORG,
  TEST_PRODUCTION_PROJECT_ID,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
  USDC_TOKEN_SUPPLY_RESULT,
} from "@/test/helpers/payments-routes";
import { TEST_MOCK_FEE_PAYER } from "@/test/helpers/sponsor-signing";

const SUBSCRIPTION_HEADERS = {
  Authorization: "Bearer sk_test_payments_policy",
  "Content-Type": "application/json",
};

const TEST_COUNTERPARTY_IDENTITY = {
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

function expectPreparedSubscriptionTransaction(
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

const PRODUCTION_PLAN_ID = "psp_subscriptions_production";

const PRODUCTION_OWNER_WALLET_ID = "privy_subscriptions_production";

const PREPARED_BLOCKHASH_RESULT = {
  context: { slot: 1 },
  value: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 1000 },
} as const satisfies JsonRpcResult;

describe("Payments routes — subscriptions", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcStub();

  async function seedProductionSubscriptionPlan(): Promise<void> {
    await seedProductionPrivyWalletUnderTestKey({
      custodyWalletId: "cwlt_subscriptions_production",
      walletId: PRODUCTION_OWNER_WALLET_ID,
      publicKey: TEST_SOLANA_ADDRESSES.wallet1,
      stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "ciphertext" },
    });
    const now = new Date().toISOString();
    await createPostgresPaymentSubscriptionsRepository(getDb(env)).createPlan({
      id: PRODUCTION_PLAN_ID,
      organizationId: TEST_ORG.id,
      projectId: TEST_PRODUCTION_PROJECT_ID,
      ownerWalletId: PRODUCTION_OWNER_WALLET_ID,
      ownerAddress: TEST_SOLANA_ADDRESSES.wallet1,
      token: WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address,
      amount: "25.00",
      periodHours: 720,
      programPlanId: "1001",
      planPda: null,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet3,
      pullerWalletId: null,
      pullerAddress: null,
      metadataUri: null,
      status: "active",
      createdBy: TEST_USER.id,
      createdAt: now,
      updatedAt: now,
    });
  }

  function expectMainnetBetaReadsOnly(methods: readonly string[]): void {
    for (const method of methods) {
      expect(rpc.calls).toContainEqual({ cluster: "mainnet-beta", method });
    }
    expect(rpc.calls.filter((call) => call.cluster !== "mainnet-beta")).toEqual([]);
  }

  it("requires owner wallet access when updating subscription plans", async () => {
    const planRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          ownerWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 720,
        }),
      },
      env
    );
    expect(planRes.status).toBe(201);
    const planBody = successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(
      await planRes.json()
    );

    await seedCachedKey({
      walletBindings: [{ walletId: "wal_other_wallet", permissions: ["payments:write"] }],
    });

    const updateRes = await app.request(
      `/v1/payments/subscription-plans/${planBody.data.subscriptionPlan.id}`,
      {
        method: "PATCH",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({ status: "archived" }),
      },
      env
    );

    expect(updateRes.status).toBe(403);
    const updateBody = errorResponseSchema.parse(await updateRes.json());
    expect(updateBody.error.code).toBe("FORBIDDEN");
    expect(updateBody.error.message).toContain("requested wallet");
  });

  it("rejects archived counterparties when creating subscriptions", async () => {
    const counterpartyRes = await app.request(
      "/v1/counterparties",
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          externalId: "subscription_archived_counterparty",
          entityType: "individual",
          displayName: "Archived Subscription Counterparty",
          email: "subscription-archived-counterparty@example.com",
          identity: TEST_COUNTERPARTY_IDENTITY,
        }),
      },
      env
    );
    expect(counterpartyRes.status).toBe(201);
    const counterpartyBody = successResponseSchema(counterpartyResponseSchema).parse(
      await counterpartyRes.json()
    );

    const planRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          ownerWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 720,
        }),
      },
      env
    );
    expect(planRes.status).toBe(201);
    const planBody = successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(
      await planRes.json()
    );

    const archiveRes = await app.request(
      `/v1/counterparties/${counterpartyBody.data.counterparty.id}`,
      {
        method: "DELETE",
        headers: SUBSCRIPTION_HEADERS,
      },
      env
    );
    expect(archiveRes.status).toBe(204);

    const subscriptionRes = await app.request(
      "/v1/payments/subscriptions",
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          planId: planBody.data.subscriptionPlan.id,
          counterpartyId: counterpartyBody.data.counterparty.id,
          subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
        }),
      },
      env
    );

    expect(subscriptionRes.status).toBe(404);
    const subscriptionBody = errorResponseSchema.parse(await subscriptionRes.json());
    expect(subscriptionBody.error.code).toBe("NOT_FOUND");
    expect(subscriptionBody.error.message).toContain("Counterparty not found");
  });

  it("exercises the recurring subscription lifecycle through SDP API routes", async () => {
    const subscriberTokenAccount = TEST_SOLANA_ADDRESSES.wallet3;

    const counterpartyRes = await app.request(
      "/v1/counterparties",
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          externalId: "subscription_counterparty_001",
          entityType: "individual",
          displayName: "Subscription API Counterparty",
          email: "subscription-counterparty@example.com",
          identity: TEST_COUNTERPARTY_IDENTITY,
        }),
      },
      env
    );

    expect(counterpartyRes.status).toBe(201);
    const counterpartyBody = successResponseSchema(counterpartyResponseSchema).parse(
      await counterpartyRes.json()
    );
    const counterpartyId = counterpartyBody.data.counterparty.id;
    expect(counterpartyBody.data.counterparty.status).toBe("active");

    const planRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          ownerWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 720,
          destinationAddress: TEST_SOLANA_ADDRESSES.wallet3,
          metadataUri: "https://sdp.dev/plan.json",
        }),
      },
      env
    );

    expect(planRes.status).toBe(201);
    const planBody = successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(
      await planRes.json()
    );
    const planId = planBody.data.subscriptionPlan.id;
    expect(planBody.data.subscriptionPlan).toMatchObject({
      ownerWalletId: TEST_WALLET_ID,
      ownerAddress: TEST_SOLANA_ADDRESSES.wallet1,
      amount: "25.00",
      periodHours: 720,
      status: "draft",
      metadataUri: "https://sdp.dev/plan.json",
    });
    expect(planBody.data.subscriptionPlan.programPlanId).toMatch(/^\d+$/);

    const duplicatePlanRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          ownerWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 720,
          programPlanId: planBody.data.subscriptionPlan.programPlanId,
        }),
      },
      env
    );
    expect(duplicatePlanRes.status).toBe(409);

    const draftPlansRes = await app.request(
      "/v1/payments/subscription-plans?status=draft",
      {
        headers: SUBSCRIPTION_HEADERS,
      },
      env
    );

    expect(draftPlansRes.status).toBe(200);
    const draftPlansBody = successResponseSchema(paymentSubscriptionPlanListResponseSchema).parse(
      await draftPlansRes.json()
    );
    expect(draftPlansBody.data.subscriptionPlans.map((plan) => plan.id)).toContain(planId);
    expect(draftPlansBody.data.total).toBe(1);

    const updatePlanRes = await app.request(
      `/v1/payments/subscription-plans/${planId}`,
      {
        method: "PATCH",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          metadataUri: "https://sdp.dev/plan-active.json",
          pullerWalletId: TEST_WALLET_ID,
          status: "active",
        }),
      },
      env
    );

    expect(updatePlanRes.status).toBe(200);
    const updatePlanBody = successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(
      await updatePlanRes.json()
    );
    expect(updatePlanBody.data.subscriptionPlan).toMatchObject({
      id: planId,
      pullerWalletId: TEST_WALLET_ID,
      pullerAddress: TEST_SOLANA_ADDRESSES.wallet1,
      metadataUri: "https://sdp.dev/plan-active.json",
      status: "active",
    });

    const getPlanRes = await app.request(
      `/v1/payments/subscription-plans/${planId}`,
      {
        headers: SUBSCRIPTION_HEADERS,
      },
      env
    );

    expect(getPlanRes.status).toBe(200);
    const getPlanBody = successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(
      await getPlanRes.json()
    );
    expect(getPlanBody.data.subscriptionPlan).toMatchObject({
      id: planId,
      status: "active",
    });

    rpc.answer("getTokenSupply", USDC_TOKEN_SUPPLY_RESULT);
    const preparePlanRes = await app.request(
      `/v1/payments/subscription-plans/${planId}/prepare-create`,
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          destinations: [TEST_SOLANA_ADDRESSES.wallet3],
          endTs: "1770000000",
          metadataUri: "https://sdp.dev/plan-chain.json",
          pullers: [TEST_SOLANA_ADDRESSES.wallet1],
        }),
      },
      env
    );

    expect(preparePlanRes.status).toBe(200);
    const preparePlanBody = successResponseSchema(
      preparePaymentSubscriptionPlanResponseSchema
    ).parse(await preparePlanRes.json());
    expect(preparePlanBody.data.planPda).toBeTruthy();
    expect(preparePlanBody.data.subscriptionPlan.id).toBe(planId);
    expect(preparePlanBody.data.subscriptionPlan.planPda).toBe(preparePlanBody.data.planPda);
    expectPreparedSubscriptionTransaction(preparePlanBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet1,
      TEST_MOCK_FEE_PAYER,
    ]);

    const activePlansRes = await app.request(
      "/v1/payments/subscription-plans?status=active",
      {
        headers: SUBSCRIPTION_HEADERS,
      },
      env
    );

    expect(activePlansRes.status).toBe(200);
    const activePlansBody = successResponseSchema(paymentSubscriptionPlanListResponseSchema).parse(
      await activePlansRes.json()
    );
    expect(activePlansBody.data.subscriptionPlans).toContainEqual(
      expect.objectContaining({ id: planId, planPda: preparePlanBody.data.planPda })
    );

    const subscriptionRes = await app.request(
      "/v1/payments/subscriptions",
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          planId,
          counterpartyId,
          subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
        }),
      },
      env
    );

    expect(subscriptionRes.status).toBe(201);
    const subscriptionBody = successResponseSchema(paymentSubscriptionResponseSchema).parse(
      await subscriptionRes.json()
    );
    const subscriptionId = subscriptionBody.data.subscription.id;
    expect(subscriptionBody.data.subscription).toMatchObject({
      planId,
      counterpartyId,
      subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
      subscriberTokenAccount: null,
      subscriptionPda: null,
      subscriptionAuthorityAddress: null,
      status: "pending_authorization",
    });
    expect(subscriptionBody.data.subscription.nextCollectionDueAt).toBeNull();

    const listSubscriptionsRes = await app.request(
      `/v1/payments/subscriptions?planId=${planId}&counterpartyId=${counterpartyId}&status=pending_authorization`,
      {
        headers: SUBSCRIPTION_HEADERS,
      },
      env
    );

    expect(listSubscriptionsRes.status).toBe(200);
    const listSubscriptionsBody = successResponseSchema(
      paymentSubscriptionListResponseSchema
    ).parse(await listSubscriptionsRes.json());
    expect(listSubscriptionsBody.data.subscriptions.map((subscription) => subscription.id)).toEqual(
      [subscriptionId]
    );
    expect(listSubscriptionsBody.data.total).toBe(1);

    const getSubscriptionRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}`,
      {
        headers: SUBSCRIPTION_HEADERS,
      },
      env
    );

    expect(getSubscriptionRes.status).toBe(200);
    const getSubscriptionBody = successResponseSchema(paymentSubscriptionResponseSchema).parse(
      await getSubscriptionRes.json()
    );
    expect(getSubscriptionBody.data.subscription).toMatchObject({
      id: subscriptionId,
      status: "pending_authorization",
    });

    const prepareAuthorizationRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-authorization`,
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          expectedSubscriptionAuthorityInitId: "0",
          subscriberTokenAccount,
          expectedPlanCreatedAt: "1700000000",
        }),
      },
      env
    );

    expect(prepareAuthorizationRes.status).toBe(200);
    const prepareAuthorizationBody = successResponseSchema(
      preparePaymentSubscriptionAuthorizationResponseSchema
    ).parse(await prepareAuthorizationRes.json());
    expect(prepareAuthorizationBody.data.subscription).toMatchObject({
      id: subscriptionId,
      subscriberTokenAccount,
      subscriptionAuthorityAddress: prepareAuthorizationBody.data.subscriptionAuthorityAddress,
      subscriptionPda: prepareAuthorizationBody.data.subscriptionPda,
    });
    expectPreparedSubscriptionTransaction(prepareAuthorizationBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet2,
      TEST_MOCK_FEE_PAYER,
    ]);

    const authorizedAt = new Date().toISOString();
    const authorizedSubscription = await createPostgresPaymentSubscriptionsRepository(
      getDb(env)
    ).updateSubscription({
      subscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      authorizationSignature:
        "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe",
      status: "active",
      currentPeriodStartAt: authorizedAt,
      nextCollectionDueAt: authorizedAt,
      expectedStatus: "pending_authorization",
      updatedAt: authorizedAt,
    });
    expect(authorizedSubscription).not.toBeNull();

    const prepareCancelRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-cancel`,
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
      },
      env
    );

    expect(prepareCancelRes.status).toBe(200);
    const prepareCancelBody = successResponseSchema(
      preparePaymentSubscriptionLifecycleResponseSchema
    ).parse(await prepareCancelRes.json());
    expect(prepareCancelBody.data.subscription.id).toBe(subscriptionId);
    expectPreparedSubscriptionTransaction(prepareCancelBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet2,
      TEST_MOCK_FEE_PAYER,
    ]);

    const prepareResumeRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-resume`,
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
      },
      env
    );

    expect(prepareResumeRes.status).toBe(200);
    const prepareResumeBody = successResponseSchema(
      preparePaymentSubscriptionLifecycleResponseSchema
    ).parse(await prepareResumeRes.json());
    expect(prepareResumeBody.data.subscription.id).toBe(subscriptionId);
    expectPreparedSubscriptionTransaction(prepareResumeBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet2,
      TEST_MOCK_FEE_PAYER,
    ]);

    const amountOverrideRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-collection`,
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          amount: "10.50",
          receiverTokenAccount: TEST_SOLANA_ADDRESSES.wallet3,
        }),
      },
      env
    );
    expect(amountOverrideRes.status).toBe(400);

    const prepareCollectionRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-collection`,
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({ receiverTokenAccount: TEST_SOLANA_ADDRESSES.wallet3 }),
      },
      env
    );

    expect(prepareCollectionRes.status).toBe(200);
    const prepareCollectionBody = successResponseSchema(
      preparePaymentSubscriptionCollectionResponseSchema
    ).parse(await prepareCollectionRes.json());
    expect(prepareCollectionBody.data.subscription.id).toBe(subscriptionId);
    expectPreparedSubscriptionTransaction(prepareCollectionBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet1,
      TEST_MOCK_FEE_PAYER,
    ]);
  });

  it("prepares a Production project's subscription plan from mainnet-beta only", async () => {
    await seedProductionSubscriptionPlan();
    getAccountInfoMock.mockReset();
    getRecentBlockhashMock.mockReset();
    rpc.answer("getAccountInfo", {
      context: { slot: 1 },
      value: {
        data: ["", "base64"],
        executable: false,
        lamports: 1_461_600,
        owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        rentEpoch: 0,
        space: 0,
      },
    });
    rpc.answer("getTokenSupply", USDC_TOKEN_SUPPLY_RESULT);
    rpc.answer("getLatestBlockhash", PREPARED_BLOCKHASH_RESULT);

    const response = await app.request(
      `/v1/payments/subscription-plans/${PRODUCTION_PLAN_ID}/prepare-create`,
      { method: "POST", headers: SUBSCRIPTION_HEADERS, body: JSON.stringify({}) },
      env
    );

    expect(response.status).toBe(200);
    const body = successResponseSchema(preparePaymentSubscriptionPlanResponseSchema).parse(
      await response.json()
    );
    expectPreparedSubscriptionTransaction(body.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet1,
      TEST_MOCK_FEE_PAYER,
    ]);
    expectMainnetBetaReadsOnly(["getAccountInfo", "getTokenSupply", "getLatestBlockhash"]);
  });

  it("prepares a Production project's subscription resume from mainnet-beta only", async () => {
    await seedProductionSubscriptionPlan();
    const counterpartyId = await seedCounterparty({
      id: "cpty_subscriptions_production",
      projectId: TEST_PRODUCTION_PROJECT_ID,
    });
    const now = new Date().toISOString();
    await createPostgresPaymentSubscriptionsRepository(getDb(env)).createSubscription({
      id: "psub_subscriptions_production",
      organizationId: TEST_ORG.id,
      projectId: TEST_PRODUCTION_PROJECT_ID,
      planId: PRODUCTION_PLAN_ID,
      counterpartyId,
      subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
      subscriberTokenAccount: TEST_SOLANA_ADDRESSES.wallet3,
      subscriptionPda: null,
      subscriptionAuthorityAddress: null,
      authorizationSignature: null,
      status: "canceled",
      currentPeriodStartAt: now,
      nextCollectionDueAt: null,
      createdBy: TEST_USER.id,
      createdAt: now,
      updatedAt: now,
    });
    fetchMaybeSubscriptionDelegationMock.mockReset();
    getRecentBlockhashMock.mockReset();
    const delegationData = getSubscriptionDelegationEncoder().encode({
      header: {
        discriminator: AccountDiscriminator.SubscriptionDelegation,
        version: CURRENT_PROGRAM_VERSION,
        bump: 255,
        delegator: address(TEST_SOLANA_ADDRESSES.wallet2),
        delegatee: address(TEST_SOLANA_ADDRESSES.wallet1),
        payer: address(TEST_SOLANA_ADDRESSES.wallet2),
        initId: 0,
      },
      terms: { amount: 25_000_000, periodHours: 720, createdAt: 1_700_000_000 },
      amountPulledInPeriod: 0,
      currentPeriodStartTs: 1_700_000_000,
      expiresAtTs: 1_702_592_000,
    });
    rpc.answer("getAccountInfo", {
      context: { slot: 1 },
      value: {
        data: [getBase64Decoder().decode(delegationData), "base64"],
        executable: false,
        lamports: 2_000_000,
        owner: SUBSCRIPTIONS_PROGRAM_ADDRESS,
        rentEpoch: 0,
        space: SUBSCRIPTION_SIZE,
      },
    });
    rpc.answer("getLatestBlockhash", PREPARED_BLOCKHASH_RESULT);

    const response = await app.request(
      "/v1/payments/subscriptions/psub_subscriptions_production/prepare-resume",
      { method: "POST", headers: SUBSCRIPTION_HEADERS },
      env
    );

    expect(response.status).toBe(200);
    const body = successResponseSchema(preparePaymentSubscriptionLifecycleResponseSchema).parse(
      await response.json()
    );
    expectPreparedSubscriptionTransaction(body.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet2,
      TEST_MOCK_FEE_PAYER,
    ]);
    expectMainnetBetaReadsOnly(["getAccountInfo", "getLatestBlockhash"]);
  });
});
