import {
  address,
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage,
  getTransactionDecoder,
} from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { expect, it } from "vitest";
import { getDb } from "@/db";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories/payment-subscriptions.repository.postgres";
import app from "@/index";
import { errorResponseSchema, successResponseSchema } from "@/openapi/schemas/base";
import { counterpartyResponseSchema } from "@/openapi/schemas/counterparties";
import {
  paymentSubscriptionPlanResponseSchema,
  paymentSubscriptionResponseSchema,
  preparePaymentSubscriptionAuthorizationResponseSchema,
  preparePaymentSubscriptionCollectionResponseSchema,
  preparePaymentSubscriptionPlanResponseSchema,
} from "@/openapi/schemas/payments";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  DEVNET_USDC_MINT,
  fetchMaybePlanMock,
  installPaymentsRouteTestHooks,
  mockTokenSupplyDecimalsOnce,
  seedCachedKey,
  TEST_CONFIG_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

const HEADERS = {
  Authorization: "Bearer sk_test_payments_policy",
  "Content-Type": "application/json",
};

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const DESTINATION = TEST_SOLANA_ADDRESSES.wallet3;
const OTHER_DESTINATION = TEST_SOLANA_ADDRESSES.wallet2;
const OWNER = TEST_SOLANA_ADDRESSES.wallet1;

function destinationAta(owner: string) {
  return findAssociatedTokenPda({
    mint: address(DEVNET_USDC_MINT),
    owner: address(owner),
    tokenProgram: address(SPL_TOKEN_PROGRAM),
  }).then(([ata]) => ata);
}

type OnChainPlanOverride = {
  exists?: boolean;
  status?: subscriptionsProgram.PlanStatus;
  destinations?: string[];
  pullers?: string[];
  amount?: bigint;
  periodHours?: bigint;
  metadataUri?: string;
};

/** Installs the authoritative on-chain plan the routes must be anchored to. */
function mockOnChainPlan(overrides: OnChainPlanOverride = {}): void {
  const exists = overrides.exists ?? true;
  fetchMaybePlanMock.mockResolvedValue(
    exists
      ? ({
          exists: true,
          address: subscriptionsProgram.SUBSCRIPTIONS_PROGRAM_ADDRESS,
          data: {
            discriminator: 0,
            owner: OWNER,
            bump: 255,
            status: overrides.status ?? subscriptionsProgram.PlanStatus.Active,
            data: {
              planId: 1n,
              mint: DEVNET_USDC_MINT,
              terms: {
                amount: overrides.amount ?? 25_000_000n,
                periodHours: overrides.periodHours ?? 720n,
                createdAt: 1_770_000_000n,
              },
              endTs: 0n,
              destinations: (overrides.destinations ?? [DESTINATION]) as never[],
              pullers: (overrides.pullers ?? [OWNER]) as never[],
              metadataUri: overrides.metadataUri ?? "",
            },
          },
        } as unknown as Awaited<ReturnType<typeof subscriptionsProgram.fetchMaybePlan>>)
      : ({
          exists: false,
        } as unknown as Awaited<ReturnType<typeof subscriptionsProgram.fetchMaybePlan>>)
  );
}

function instructionsFromPrepared(serialized: string) {
  const transaction = getTransactionDecoder().decode(getBase64Codec().encode(serialized));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  return getInstructionsFromCompiledTransactionMessage(message);
}

type SubscriptionsProgramInstruction = Parameters<
  typeof subscriptionsProgram.parseCreatePlanInstruction
>[0];

function requireSubscriptionInstruction(
  instructions: ReturnType<typeof instructionsFromPrepared>
): SubscriptionsProgramInstruction {
  const instruction = instructions.find(
    (entry) => entry.programAddress === subscriptionsProgram.SUBSCRIPTIONS_PROGRAM_ADDRESS
  );
  if (!instruction) {
    throw new Error("Expected a subscriptions program instruction in the prepared transaction");
  }
  return instruction as unknown as SubscriptionsProgramInstruction;
}

async function createLivePlan(): Promise<{
  planId: string;
  planPda: string;
  programPlanId: string;
}> {
  const planRes = await app.request(
    "/v1/payments/subscription-plans",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        ownerWalletId: TEST_WALLET_ID,
        token: DEVNET_USDC_MINT,
        amount: "25.00",
        periodHours: 720,
        destinationAddress: DESTINATION,
      }),
    },
    env
  );
  expect(planRes.status).toBe(201);
  const plan = successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(
    await planRes.json()
  ).data.subscriptionPlan;

  mockTokenSupplyDecimalsOnce();
  const preparedCreate = await app.request(
    `/v1/payments/subscription-plans/${plan.id}/prepare-create`,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        destinations: [DESTINATION],
        endTs: "1800000000",
        pullers: [OWNER],
      }),
    },
    env
  );
  expect(preparedCreate.status).toBe(200);
  const prepared = successResponseSchema(preparePaymentSubscriptionPlanResponseSchema).parse(
    await preparedCreate.json()
  ).data;

  const createInstruction = requireSubscriptionInstruction(
    instructionsFromPrepared(prepared.preparedTransaction.serialized)
  );
  const createData = subscriptionsProgram.parseCreatePlanInstruction(createInstruction);
  expect(createData.data.planData.destinations[0]).toBe(DESTINATION);
  expect(createData.data.planData.pullers[0]).toBe(OWNER);

  return {
    planId: plan.id,
    planPda: prepared.planPda,
    programPlanId: plan.programPlanId,
  };
}

async function getPlan(planId: string) {
  const planRes = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    { headers: HEADERS },
    env
  );
  expect(planRes.status).toBe(200);
  return successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(await planRes.json())
    .data.subscriptionPlan;
}

async function createActiveSubscription(planId: string): Promise<{
  subscriptionId: string;
  subscriptionPda: string;
}> {
  const counterpartyRes = await app.request(
    "/v1/counterparties",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        externalId: `subscription-consent-${crypto.randomUUID()}`,
        entityType: "individual",
        displayName: "Subscription Consent Counterparty",
        email: "subscription-consent@example.com",
        identity: {
          firstName: "Ada",
          lastName: "Lovelace",
          dateOfBirth: "1990-01-15",
          phone: "+14155551234",
          address: {
            line1: "1 Market St",
            city: "San Francisco",
            countryCode: "US",
          },
        },
      }),
    },
    env
  );
  expect(counterpartyRes.status).toBe(201);
  const counterparty = successResponseSchema(counterpartyResponseSchema).parse(
    await counterpartyRes.json()
  ).data.counterparty;

  const subscriptionRes = await app.request(
    "/v1/payments/subscriptions",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        planId,
        counterpartyId: counterparty.id,
        subscriberAddress: OTHER_DESTINATION,
      }),
    },
    env
  );
  expect(subscriptionRes.status).toBe(201);
  const subscription = successResponseSchema(paymentSubscriptionResponseSchema).parse(
    await subscriptionRes.json()
  ).data.subscription;

  const subscriberAta = await destinationAta(OTHER_DESTINATION);
  mockTokenSupplyDecimalsOnce();
  const prepareAuthorization = await app.request(
    `/v1/payments/subscriptions/${subscription.id}/prepare-authorization`,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        subscriberTokenAccount: subscriberAta,
        expectedPlanCreatedAt: "1700000000",
        expectedSubscriptionAuthorityInitId: "0",
      }),
    },
    env
  );
  expect(prepareAuthorization.status).toBe(200);
  const authorized = successResponseSchema(
    preparePaymentSubscriptionAuthorizationResponseSchema
  ).parse(await prepareAuthorization.json()).data;

  const now = new Date().toISOString();
  const activated = await createPostgresPaymentSubscriptionsRepository(
    getDb(env)
  ).updateSubscription({
    subscriptionId: subscription.id,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    subscriberTokenAccount: subscriberAta,
    subscriptionPda: authorized.subscriptionPda,
    subscriptionAuthorityAddress: authorized.subscriptionAuthorityAddress,
    authorizationSignature:
      "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe",
    status: "active",
    currentPeriodStartAt: now,
    nextCollectionDueAt: now,
    expectedStatus: "pending_authorization",
    updatedAt: now,
  });
  expect(activated).not.toBeNull();

  return { subscriptionId: subscription.id, subscriptionPda: authorized.subscriptionPda };
}

async function prepareCollection(subscriptionId: string, receiverTokenAccount: string) {
  mockTokenSupplyDecimalsOnce();
  return app.request(
    `/v1/payments/subscriptions/${subscriptionId}/prepare-collection`,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ receiverTokenAccount }),
    },
    env
  );
}

installPaymentsRouteTestHooks();

it("rejects destination and plan PDA changes on a live plan and never persists them", async () => {
  const { planId, planPda } = await createLivePlan();

  await seedCachedKey({
    walletBindings: [{ walletId: "wal_not_the_owner", permissions: ["payments:write"] }],
  });
  const deniedPatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ destinationAddress: OTHER_DESTINATION, status: "active" }),
    },
    env
  );
  expect(deniedPatch.status).toBe(403);

  await seedCachedKey({});
  const destinationPatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ destinationAddress: OTHER_DESTINATION }),
    },
    env
  );
  expect(destinationPatch.status).toBe(400);
  const destinationError = errorResponseSchema.parse(await destinationPatch.json());
  expect(destinationError.error.code).toBe("BAD_REQUEST");
  expect(destinationError.error.message).toContain("destination");

  const planPdaPatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ planPda: OTHER_DESTINATION }),
    },
    env
  );
  expect(planPdaPatch.status).toBe(400);

  const persisted = await getPlan(planId);
  expect(persisted).toMatchObject({
    destinationAddress: DESTINATION,
    planPda,
    status: "draft",
  });
});

it("activates a live plan only after the on-chain plan is active, and mirrors on-chain sunset", async () => {
  const { planId } = await createLivePlan();

  mockOnChainPlan({ exists: false });
  const missingOnChainPatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ status: "active" }),
    },
    env
  );
  expect(missingOnChainPatch.status).toBe(400);
  expect((await getPlan(planId)).status).toBe("draft");

  mockOnChainPlan({ status: subscriptionsProgram.PlanStatus.Sunset });
  const sunsetPatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ status: "active" }),
    },
    env
  );
  expect(sunsetPatch.status).toBe(400);

  mockOnChainPlan({ status: subscriptionsProgram.PlanStatus.Active });
  const activatePatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ status: "active" }),
    },
    env
  );
  expect(activatePatch.status).toBe(200);
  expect((await getPlan(planId)).status).toBe("active");

  const archiveActivePatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ status: "archived" }),
    },
    env
  );
  expect(archiveActivePatch.status).toBe(400);
  expect((await getPlan(planId)).status).toBe("active");

  mockOnChainPlan({ status: subscriptionsProgram.PlanStatus.Sunset });
  const archivePatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ status: "archived" }),
    },
    env
  );
  expect(archivePatch.status).toBe(200);
  expect((await getPlan(planId)).status).toBe("archived");
});

it("requires puller and metadata edits on a live plan to be confirmed on-chain first", async () => {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_wallets
         (id, custody_config_id, wallet_id, public_key, label, purpose, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      "cwlt_second_puller",
      TEST_CONFIG_ID,
      "wal_second_puller",
      OTHER_DESTINATION,
      "Second",
      "transfer",
      "active"
    )
    .run();

  const { planId } = await createLivePlan();

  mockOnChainPlan({ pullers: [OWNER] });
  const unconfirmedPullerPatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ pullerWalletId: "wal_second_puller" }),
    },
    env
  );
  expect(unconfirmedPullerPatch.status).toBe(400);
  expect((await getPlan(planId)).pullerWalletId).toBeNull();

  mockOnChainPlan({ pullers: [OWNER, OTHER_DESTINATION] });
  const confirmedPullerPatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ pullerWalletId: "wal_second_puller" }),
    },
    env
  );
  expect(confirmedPullerPatch.status).toBe(200);
  expect((await getPlan(planId)).pullerWalletId).toBe("wal_second_puller");

  const metadataUri = "https://sdp.dev/plan-live.json";
  mockOnChainPlan({ metadataUri: "" });
  const unconfirmedMetadataPatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ metadataUri }),
    },
    env
  );
  expect(unconfirmedMetadataPatch.status).toBe(400);

  mockOnChainPlan({ metadataUri });
  const confirmedMetadataPatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ metadataUri }),
    },
    env
  );
  expect(confirmedMetadataPatch.status).toBe(200);
  expect((await getPlan(planId)).metadataUri).toBe(metadataUri);
});

it("anchors collection preparation to the authoritative on-chain plan", async () => {
  const { planId } = await createLivePlan();
  mockOnChainPlan({ status: subscriptionsProgram.PlanStatus.Active });
  const activatePatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ status: "active" }),
    },
    env
  );
  expect(activatePatch.status).toBe(200);
  const { subscriptionId, subscriptionPda } = await createActiveSubscription(planId);

  mockOnChainPlan({ exists: false });
  const missingPlan = await prepareCollection(subscriptionId, await destinationAta(DESTINATION));
  expect(missingPlan.status).toBe(400);

  mockOnChainPlan({ status: subscriptionsProgram.PlanStatus.Sunset });
  const sunsetPlan = await prepareCollection(subscriptionId, await destinationAta(DESTINATION));
  expect(sunsetPlan.status).toBe(400);

  mockOnChainPlan({ amount: 30_000_000n });
  const driftedAmount = await prepareCollection(subscriptionId, await destinationAta(DESTINATION));
  expect(driftedAmount.status).toBe(400);

  mockOnChainPlan({ periodHours: 480n });
  const driftedPeriod = await prepareCollection(subscriptionId, await destinationAta(DESTINATION));
  expect(driftedPeriod.status).toBe(400);

  mockOnChainPlan({ pullers: [OTHER_DESTINATION] });
  const unauthorizedPuller = await prepareCollection(
    subscriptionId,
    await destinationAta(DESTINATION)
  );
  expect(unauthorizedPuller.status).toBe(400);

  mockOnChainPlan({ destinations: [OTHER_DESTINATION] });
  const offWhitelistReceiver = await prepareCollection(
    subscriptionId,
    await destinationAta(DESTINATION)
  );
  expect(offWhitelistReceiver.status).toBe(400);

  await getDb(env)
    .prepare("UPDATE payment_subscriptions SET subscription_pda = ? WHERE id = ?")
    .bind(OTHER_DESTINATION, subscriptionId)
    .run();
  mockOnChainPlan({});
  const tamperedSubscriptionPda = await prepareCollection(
    subscriptionId,
    await destinationAta(DESTINATION)
  );
  expect(tamperedSubscriptionPda.status).toBe(400);
  await getDb(env)
    .prepare("UPDATE payment_subscriptions SET subscription_pda = ? WHERE id = ?")
    .bind(subscriptionPda, subscriptionId)
    .run();

  mockOnChainPlan({});
  const receiver = await destinationAta(DESTINATION);
  const preparedCollection = await prepareCollection(subscriptionId, receiver);
  expect(preparedCollection.status).toBe(200);
  const collectionBody = successResponseSchema(
    preparePaymentSubscriptionCollectionResponseSchema
  ).parse(await preparedCollection.json()).data;
  const transferInstruction = requireSubscriptionInstruction(
    instructionsFromPrepared(collectionBody.preparedTransaction.serialized)
  );
  const transferData =
    subscriptionsProgram.parseTransferSubscriptionInstruction(transferInstruction);
  expect(transferData.data.transferData.amount).toBe(25_000_000n);
  expect(transferInstruction.accounts?.[4]?.address).toBe(receiver);
});

it("blocks the reported stale-consent exploit end to end", async () => {
  const { planId, planPda } = await createLivePlan();

  await seedCachedKey({
    walletBindings: [{ walletId: "wal_not_the_owner", permissions: ["payments:write"] }],
  });
  const deniedPatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ destinationAddress: OTHER_DESTINATION, status: "active" }),
    },
    env
  );
  expect(deniedPatch.status).toBe(403);

  await seedCachedKey({});
  const exploitPatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ destinationAddress: OTHER_DESTINATION, status: "active" }),
    },
    env
  );
  expect(exploitPatch.status).toBe(400);
  const persisted = await getPlan(planId);
  expect(persisted).toMatchObject({
    destinationAddress: DESTINATION,
    planPda,
    status: "draft",
  });

  mockOnChainPlan({ status: subscriptionsProgram.PlanStatus.Active });
  const activatePatch = await app.request(
    `/v1/payments/subscription-plans/${planId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ status: "active" }),
    },
    env
  );
  expect(activatePatch.status).toBe(200);

  const { subscriptionId } = await createActiveSubscription(planId);

  const attackerReceiver = await prepareCollection(
    subscriptionId,
    await destinationAta(OTHER_DESTINATION)
  );
  expect(attackerReceiver.status).toBe(400);

  const consentedReceiver = await destinationAta(DESTINATION);
  const preparedCollection = await prepareCollection(subscriptionId, consentedReceiver);
  expect(preparedCollection.status).toBe(200);
  const collectionBody = successResponseSchema(
    preparePaymentSubscriptionCollectionResponseSchema
  ).parse(await preparedCollection.json()).data;
  const transferInstruction = requireSubscriptionInstruction(
    instructionsFromPrepared(collectionBody.preparedTransaction.serialized)
  );
  const transferData =
    subscriptionsProgram.parseTransferSubscriptionInstruction(transferInstruction);
  expect(transferData.data.transferData.amount).toBe(25_000_000n);
  expect(transferInstruction.accounts?.[4]?.address).toBe(consentedReceiver);
});

it("validates destination and status claims when a plan references an on-chain planPda", async () => {
  const requestBody = {
    ownerWalletId: TEST_WALLET_ID,
    token: DEVNET_USDC_MINT,
    amount: "25.00",
    periodHours: 720,
    planPda: OTHER_DESTINATION,
  };
  const createPlan = async (body: Record<string, unknown>) =>
    app.request(
      "/v1/payments/subscription-plans",
      { method: "POST", headers: HEADERS, body: JSON.stringify(body) },
      env
    );

  mockOnChainPlan({ exists: false });
  const missingChainDestination = await createPlan({
    ...requestBody,
    destinationAddress: DESTINATION,
  });
  expect(missingChainDestination.status).toBe(400);

  const missingChainActive = await createPlan({ ...requestBody, status: "active" });
  expect(missingChainActive.status).toBe(400);

  const pendingAttach = await createPlan(requestBody);
  expect(pendingAttach.status).toBe(201);

  mockOnChainPlan({ destinations: [OTHER_DESTINATION] });
  const offChainDestination = await createPlan({
    ...requestBody,
    destinationAddress: DESTINATION,
  });
  expect(offChainDestination.status).toBe(400);

  mockOnChainPlan({});
  const archivedWhileActive = await createPlan({ ...requestBody, status: "archived" });
  expect(archivedWhileActive.status).toBe(400);

  mockOnChainPlan({ destinations: [DESTINATION] });
  const attached = await createPlan({
    ...requestBody,
    planPda: TEST_SOLANA_ADDRESSES.mint,
    destinationAddress: DESTINATION,
  });
  expect(attached.status).toBe(201);
  const attachedPlan = successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(
    await attached.json()
  ).data.subscriptionPlan;
  expect(attachedPlan).toMatchObject({
    planPda: TEST_SOLANA_ADDRESSES.mint,
    destinationAddress: DESTINATION,
    status: "draft",
  });

  mockOnChainPlan({ destinations: [DESTINATION] });
  const attachedActive = await createPlan({
    ...requestBody,
    planPda: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    status: "active",
  });
  expect(attachedActive.status).toBe(201);
  const activePlan = successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(
    await attachedActive.json()
  ).data.subscriptionPlan;
  expect(activePlan.status).toBe("active");
});

it("binds a draft record to a live on-chain plan derived from its program plan id", async () => {
  const planRes = await app.request(
    "/v1/payments/subscription-plans",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        ownerWalletId: TEST_WALLET_ID,
        token: DEVNET_USDC_MINT,
        amount: "25.00",
        periodHours: 720,
        destinationAddress: DESTINATION,
      }),
    },
    env
  );
  expect(planRes.status).toBe(201);
  const plan = successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(
    await planRes.json()
  ).data.subscriptionPlan;
  expect(plan.planPda).toBeNull();

  mockOnChainPlan({});
  const liveDestinationPatch = await app.request(
    `/v1/payments/subscription-plans/${plan.id}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ destinationAddress: OTHER_DESTINATION }),
    },
    env
  );
  expect(liveDestinationPatch.status).toBe(400);
  const liveDestinationError = errorResponseSchema.parse(await liveDestinationPatch.json());
  expect(liveDestinationError.error.message).toContain("destination");

  mockOnChainPlan({ exists: false });
  const draftDestinationPatch = await app.request(
    `/v1/payments/subscription-plans/${plan.id}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ destinationAddress: OTHER_DESTINATION }),
    },
    env
  );
  expect(draftDestinationPatch.status).toBe(200);
  expect((await getPlan(plan.id)).destinationAddress).toBe(OTHER_DESTINATION);
});

it("keeps the stored destination in sync with the destinations of the prepared create", async () => {
  const planRes = await app.request(
    "/v1/payments/subscription-plans",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        ownerWalletId: TEST_WALLET_ID,
        token: DEVNET_USDC_MINT,
        amount: "25.00",
        periodHours: 720,
        destinationAddress: DESTINATION,
      }),
    },
    env
  );
  expect(planRes.status).toBe(201);
  const plan = successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(
    await planRes.json()
  ).data.subscriptionPlan;

  mockTokenSupplyDecimalsOnce();
  const preparedCreate = await app.request(
    `/v1/payments/subscription-plans/${plan.id}/prepare-create`,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ destinations: [OTHER_DESTINATION, DESTINATION] }),
    },
    env
  );
  expect(preparedCreate.status).toBe(200);
  const prepared = successResponseSchema(preparePaymentSubscriptionPlanResponseSchema).parse(
    await preparedCreate.json()
  ).data;

  const createInstruction = requireSubscriptionInstruction(
    instructionsFromPrepared(prepared.preparedTransaction.serialized)
  );
  const createData = subscriptionsProgram.parseCreatePlanInstruction(createInstruction);
  expect(createData.data.planData.destinations[0]).toBe(OTHER_DESTINATION);

  expect(prepared.subscriptionPlan.destinationAddress).toBe(OTHER_DESTINATION);
  const persisted = await getPlan(plan.id);
  expect(persisted.destinationAddress).toBe(OTHER_DESTINATION);
  expect(persisted.planPda).toBe(prepared.planPda);

  const destinationPatch = await app.request(
    `/v1/payments/subscription-plans/${plan.id}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ destinationAddress: DESTINATION }),
    },
    env
  );
  expect(destinationPatch.status).toBe(400);
});
