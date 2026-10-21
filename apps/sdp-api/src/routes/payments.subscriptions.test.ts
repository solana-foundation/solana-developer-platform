import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories/payment-subscriptions.repository.postgres";
import { app } from "@/index";
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
import { installClusterRpcStub, tokenSupplyResult } from "@/test/helpers/cluster-rpc";
import { seedTestPrivyConnection } from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import {
  createKoraAdapterMock,
  createOrgSignerForCustodyWalletMock,
  DEVNET_USDC_MINT,
  fetchMaybeSubscriptionDelegationMock,
  getAccountInfoMock,
  getRecentBlockhashMock,
  installPaymentsRouteTestHooks,
  MAINNET_USDC_MINT,
  seedCachedKey,
  seedProductionPrivyWallet,
  sendTransactionMock,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PRODUCTION_PROJECT_ID,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { seedDefaultProjects } from "@/test/helpers/projects";
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

describe("Payments routes — subscriptions", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcStub();

  beforeEach(() => {
    rpc.answer("getTokenSupply", tokenSupplyResult(1, 6));
  });

  it("stores a Production plan's USDC as the mainnet mint", async () => {
    await seedProductionPrivyWallet({
      custodyWalletId: "cwlt_subscription_plan_production",
      publicKey: TEST_SOLANA_ADDRESSES.wallet3,
    });

    const planRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: { ...SUBSCRIPTION_HEADERS, "Idempotency-Key": "plan-production-usdc" },
        body: JSON.stringify({
          ownerCustodyWalletId: "cwlt_subscription_plan_production",
          token: "USDC",
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
    expect(planBody.data.subscriptionPlan).toMatchObject({
      projectId: TEST_PRODUCTION_PROJECT_ID,
      token: MAINNET_USDC_MINT,
    });
  });

  it.each(["project", "organization"] as const)(
    "rejects an exact plan wallet outside its %s scope",
    async (scope) => {
      const organizationId = scope === "organization" ? "org_subscription_foreign" : TEST_ORG.id;
      const projectId =
        scope === "organization" ? "prj_subscription_foreign" : TEST_PRODUCTION_PROJECT_ID;
      if (scope === "organization") {
        await getDb(env)
          .prepare(
            "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Foreign subscription', 'foreign-subscription', 'enterprise', 'active')"
          )
          .bind(organizationId)
          .run();
        await seedDefaultProjects(getDb(env), {
          organizationId,
          createdBy: TEST_USER.id,
          members: [],
          ids: { sandbox: projectId, production: `${projectId}_production` },
        });
      }
      await seedTestPrivyConnection(getDb(env), {
        organizationId,
        projectId,
        connectionId: "cconn_subscription_foreign",
        credentialId: "pcred_subscription_foreign",
        createdBy: TEST_USER.id,
        stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "not-read" },
        providerAccountFingerprint: "sha256:subscription-foreign",
        lastCheckStatus: "success",
        defaultCustodyWalletId: "cwlt_subscription_foreign",
        wallets: [
          {
            id: "cwlt_subscription_foreign",
            walletId: TEST_WALLET_ID,
            publicKey: TEST_SOLANA_ADDRESSES.wallet1,
            label: null,
            purpose: "transfer",
            status: "active",
          },
        ],
      });
      const response = await app.request(
        "/v1/payments/subscription-plans",
        {
          method: "POST",
          headers: SUBSCRIPTION_HEADERS,
          body: JSON.stringify({
            ownerCustodyWalletId: "cwlt_subscription_foreign",
            token: DEVNET_USDC_MINT,
            amount: "25",
            periodHours: 720,
          }),
        },
        env
      );
      expect(response.status).toBe(404);
      expect(getRecentBlockhashMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    { ownerWalletId: TEST_WALLET_ID },
    { ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID, pullerWalletId: TEST_WALLET_ID },
    { ownerWalletId: TEST_WALLET_ID, ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID },
    {
      ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      pullerWalletId: TEST_WALLET_ID,
      pullerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
    },
    { ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID, pullerWalletID: TEST_WALLET_ID },
    {},
  ])("rejects legacy or unknown subscription plan selectors: %j", async (selectors) => {
    const response = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          ...selectors,
          token: DEVNET_USDC_MINT,
          amount: "25",
          periodHours: 720,
        }),
      },
      env
    );
    expect(response.status).toBe(400);
  });

  it.each([
    { pullerWalletId: TEST_WALLET_ID },
    { pullerWalletId: null },
    { pullerWalletId: TEST_WALLET_ID, pullerCustodyWalletId: TEST_CUSTODY_WALLET_ID },
    { pullerWalletId: null, pullerCustodyWalletId: null },
  ])("rejects legacy subscription plan updates: %j", async (patch) => {
    const created = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          pullerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25",
          periodHours: 720,
        }),
      },
      env
    );
    expect(created.status).toBe(201);
    const planId = (await created.json()).data.subscriptionPlan.id;
    const rejected = await app.request(
      `/v1/payments/subscription-plans/${planId}`,
      {
        method: "PATCH",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({ status: "active", ...patch }),
      },
      env
    );
    expect(rejected.status).toBe(400);
    const retained = await app.request(
      `/v1/payments/subscription-plans/${planId}`,
      { headers: SUBSCRIPTION_HEADERS },
      env
    );
    expect((await retained.json()).data.subscriptionPlan).toMatchObject({
      status: "draft",
      pullerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      pullerAddress: TEST_SOLANA_ADDRESSES.wallet1,
    });
  });

  it("never interprets an exact owner selector as a provider reference", async () => {
    const response = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          ownerCustodyWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25",
          periodHours: 720,
        }),
      },
      env
    );
    expect(response.status).toBe(404);
  });

  it("prepares unsigned plans without signing scope and enforces live action grants", async () => {
    const response = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25",
          periodHours: 720,
          destinationAddress: TEST_SOLANA_ADDRESSES.wallet3,
        }),
      },
      env
    );
    expect(response.status).toBe(201);
    const planId = (await response.json()).data.subscriptionPlan.id;
    await seedCachedKey({
      walletScope: "selected",
      walletIds: [],
    });
    const prepare = () =>
      app.request(
        `/v1/payments/subscription-plans/${planId}/prepare-create`,
        {
          method: "POST",
          headers: SUBSCRIPTION_HEADERS,
          body: "{}",
        },
        env
      );
    expect((await prepare()).status).toBe(200);
    await seedCachedKey({ walletScope: "selected", walletIds: [], grants: ["recurring.read"] });
    getRecentBlockhashMock.mockClear();
    expect((await prepare()).status).toBe(403);
    expect(getRecentBlockhashMock).not.toHaveBeenCalled();
  });

  it("persists exact subscription plan roles and preserves omission versus clear", async () => {
    const response = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          pullerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 720,
        }),
      },
      env
    );
    expect(response.status).toBe(201);
    const rawBody = await response.json();
    const body = successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(rawBody);
    expect(body.data.subscriptionPlan).toMatchObject({
      ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      pullerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
    });
    expect(rawBody.data.subscriptionPlan).not.toHaveProperty("ownerWalletId");
    expect(rawBody.data.subscriptionPlan).not.toHaveProperty("pullerWalletId");
    const planId = body.data.subscriptionPlan.id;
    const savedRoles = () =>
      getDb(env)
        .prepare(
          "SELECT owner_custody_wallet_id, puller_custody_wallet_id FROM payment_subscription_plans WHERE id = ?"
        )
        .bind(planId)
        .first();
    expect(await savedRoles()).toEqual({
      owner_custody_wallet_id: TEST_CUSTODY_WALLET_ID,
      puller_custody_wallet_id: TEST_CUSTODY_WALLET_ID,
    });
    for (const patch of [
      { pullerWalletId: null, pullerCustodyWalletId: null },
      { status: "active", pullerWalletID: TEST_WALLET_ID },
    ]) {
      const rejected = await app.request(
        `/v1/payments/subscription-plans/${planId}`,
        { method: "PATCH", headers: SUBSCRIPTION_HEADERS, body: JSON.stringify(patch) },
        env
      );
      expect(rejected.status).toBe(400);
    }
    const unchanged = await app.request(
      `/v1/payments/subscription-plans/${planId}`,
      {
        method: "PATCH",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({ status: "active" }),
      },
      env
    );
    expect(unchanged.status).toBe(200);
    expect((await unchanged.json()).data.subscriptionPlan.pullerCustodyWalletId).toBe(
      TEST_CUSTODY_WALLET_ID
    );
    expect(await savedRoles()).toEqual({
      owner_custody_wallet_id: TEST_CUSTODY_WALLET_ID,
      puller_custody_wallet_id: TEST_CUSTODY_WALLET_ID,
    });
    const cleared = await app.request(
      `/v1/payments/subscription-plans/${planId}`,
      {
        method: "PATCH",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({ pullerCustodyWalletId: null }),
      },
      env
    );
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).data.subscriptionPlan).toMatchObject({
      pullerCustodyWalletId: null,
      pullerAddress: null,
    });
    expect(await savedRoles()).toEqual({
      owner_custody_wallet_id: TEST_CUSTODY_WALLET_ID,
      puller_custody_wallet_id: null,
    });
  });

  // A plan is a record and an unsigned transaction the owner signs; SDP signs
  // nothing, so a key's wallet scope does not limit it (HOO-2099).
  it("lets a key that signs with no wallet archive a project plan", async () => {
    const planRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({
          ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
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

    await seedCachedKey({ walletScope: "selected", walletIds: [] });

    const detail = await app.request(
      `/v1/payments/subscription-plans/${planBody.data.subscriptionPlan.id}`,
      { headers: SUBSCRIPTION_HEADERS },
      env
    );
    expect(detail.status).toBe(200);
    const list = await app.request(
      "/v1/payments/subscription-plans",
      { headers: SUBSCRIPTION_HEADERS },
      env
    );
    expect(list.status).toBe(200);
    expect((await list.json()).data.total).toBe(1);

    const updateRes = await app.request(
      `/v1/payments/subscription-plans/${planBody.data.subscriptionPlan.id}`,
      {
        method: "PATCH",
        headers: SUBSCRIPTION_HEADERS,
        body: JSON.stringify({ status: "archived" }),
      },
      env
    );

    expect(updateRes.status).toBe(200);
    const updated = successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(
      await updateRes.json()
    );
    expect(updated.data.subscriptionPlan.status).toBe("archived");
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
          ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
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
    await seedCachedKey({ walletScope: "selected", walletIds: [] });
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
          ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
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
      ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
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
          ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
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
          pullerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
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
      pullerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
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
    expect(rpc.calls.filter((call) => call.method === "getTokenSupply")).toHaveLength(1);
    expect(getAccountInfoMock).toHaveBeenCalledTimes(1);
    expect(getRecentBlockhashMock).toHaveBeenCalledTimes(1);
    expect(fetchMaybeSubscriptionDelegationMock).toHaveBeenCalledTimes(0);
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

    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind(TEST_CUSTODY_WALLET_ID)
      .run();

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
    expect(rpc.calls.filter((call) => call.method === "getTokenSupply")).toHaveLength(2);
    expect(getAccountInfoMock).toHaveBeenCalledTimes(2);
    expect(getRecentBlockhashMock).toHaveBeenCalledTimes(2);
    expect(fetchMaybeSubscriptionDelegationMock).toHaveBeenCalledTimes(0);
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
    expect(rpc.calls.filter((call) => call.method === "getTokenSupply")).toHaveLength(2);
    expect(getAccountInfoMock).toHaveBeenCalledTimes(2);
    expect(getRecentBlockhashMock).toHaveBeenCalledTimes(3);
    expect(fetchMaybeSubscriptionDelegationMock).toHaveBeenCalledTimes(0);
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
    expect(rpc.calls.filter((call) => call.method === "getTokenSupply")).toHaveLength(2);
    expect(getAccountInfoMock).toHaveBeenCalledTimes(2);
    expect(getRecentBlockhashMock).toHaveBeenCalledTimes(4);
    expect(fetchMaybeSubscriptionDelegationMock).toHaveBeenCalledTimes(1);
    const prepareResumeBody = successResponseSchema(
      preparePaymentSubscriptionLifecycleResponseSchema
    ).parse(await prepareResumeRes.json());
    expect(prepareResumeBody.data.subscription.id).toBe(subscriptionId);
    expectPreparedSubscriptionTransaction(prepareResumeBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet2,
      TEST_MOCK_FEE_PAYER,
    ]);

    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'active' WHERE id = ?")
      .bind(TEST_CUSTODY_WALLET_ID)
      .run();

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
    expect(rpc.calls.filter((call) => call.method === "getTokenSupply")).toHaveLength(3);
    expect(getAccountInfoMock).toHaveBeenCalledTimes(3);
    expect(getRecentBlockhashMock).toHaveBeenCalledTimes(5);
    expect(fetchMaybeSubscriptionDelegationMock).toHaveBeenCalledTimes(1);
    const prepareCollectionBody = successResponseSchema(
      preparePaymentSubscriptionCollectionResponseSchema
    ).parse(await prepareCollectionRes.json());
    expect(prepareCollectionBody.data.subscription.id).toBe(subscriptionId);
    expectPreparedSubscriptionTransaction(prepareCollectionBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet1,
      TEST_MOCK_FEE_PAYER,
    ]);
    expect(getRecentBlockhashMock).toHaveBeenCalledTimes(5);
    expect(createKoraAdapterMock).toHaveBeenCalledTimes(5);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).not.toHaveBeenCalled();
    for (const { value: provider } of createKoraAdapterMock.mock.results) {
      expect(provider.signAsFeePayer).not.toHaveBeenCalled();
    }
  });
});
