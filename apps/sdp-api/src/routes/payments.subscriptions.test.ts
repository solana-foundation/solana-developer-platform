import assert from "node:assert/strict";
import type { PaymentSubscription, PaymentSubscriptionPlan } from "@sdp/types/payments";
import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import {
  getTransferSubscriptionInstructionDataDecoder,
  identifySubscriptionsInstruction,
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  SubscriptionsInstruction,
} from "@solana/subscriptions";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresCounterpartiesRepository } from "@/db/repositories/counterparty.repository.postgres";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories/payment-subscriptions.repository.postgres";
import { app } from "@/index";
import { IDEMPOTENT_REPLAYED_HEADER } from "@/middleware/idempotency";
import { errorResponseSchema, successResponseSchema } from "@/openapi/schemas/base";
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
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  DEVNET_USDC_MINT,
  installPaymentsRouteTestHooks,
  MAINNET_USDC_MINT,
  rehomeTestApiKeyToProduction,
  seedCachedKey,
  seedCounterparty,
  seedProductionPrivyWallet,
  TEST_API_KEY,
  TEST_ORG,
  TEST_PRODUCTION_PROJECT_ID,
  TEST_PROJECT,
  TEST_WALLET_ID,
  updateSeededWalletPublicKey,
} from "@/test/helpers/payments-routes";
import { required } from "@/test/helpers/required";
import { TEST_MOCK_FEE_PAYER } from "@/test/helpers/sponsor-signing";
import { mintAccountInfoResult } from "@/test/helpers/token-mints";

const PLANS = "/v1/payments/subscription-plans";
const SUBSCRIPTIONS = "/v1/payments/subscriptions";
/** The seeded custody wallet's address: the plan owner and puller. */
const OWNER = TEST_SOLANA_ADDRESSES.wallet1;
/** An address outside the organization's SDP wallets. */
const SUBSCRIBER = TEST_SOLANA_ADDRESSES.wallet2;
const RECEIVER = TEST_SOLANA_ADDRESSES.wallet3;
const AUTHORIZATION_BODY = {
  expectedSubscriptionAuthorityInitId: "0",
  subscriberTokenAccount: RECEIVER,
  expectedPlanCreatedAt: "1700000000",
} as const;
const CUSTODY_SUBSCRIBER_REFUSAL = {
  code: "CONFLICT",
  message:
    "The subscriber is one of this organization's SDP wallets. Use a recurring payment to pay from an SDP wallet.",
} as const;

function get(path: string) {
  return app.request(path, { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } }, env);
}

function send(
  method: "POST" | "PATCH",
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string | null
) {
  const headers = new Headers({
    Authorization: `Bearer ${TEST_API_KEY.raw}`,
    "Content-Type": "application/json",
  });
  if (idempotencyKey !== null) headers.set("Idempotency-Key", idempotencyKey);
  return app.request(path, { method, headers, body: JSON.stringify(body) }, env);
}

async function errorOf(res: Response) {
  return errorResponseSchema.parse(await res.json()).error;
}

async function createPlan(fields: Record<string, unknown> = {}): Promise<PaymentSubscriptionPlan> {
  const res = await send(
    "POST",
    PLANS,
    {
      ownerWalletId: TEST_WALLET_ID,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      periodHours: 720,
      ...fields,
    },
    null
  );
  expect(res.status).toBe(201);
  return successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(await res.json()).data
    .subscriptionPlan;
}

async function getPlan(planId: string): Promise<PaymentSubscriptionPlan> {
  const res = await get(`${PLANS}/${planId}`);
  expect(res.status).toBe(200);
  return successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(await res.json()).data
    .subscriptionPlan;
}

async function updatePlan(
  planId: string,
  body: Record<string, unknown>
): Promise<PaymentSubscriptionPlan> {
  const res = await send("PATCH", `${PLANS}/${planId}`, body, null);
  expect(res.status).toBe(200);
  return successResponseSchema(paymentSubscriptionPlanResponseSchema).parse(await res.json()).data
    .subscriptionPlan;
}

function postSubscription(
  body: { planId: string; counterpartyId: string; subscriberAddress: string },
  idempotencyKey: string | null
) {
  return send("POST", SUBSCRIPTIONS, body, idempotencyKey);
}

async function subscribe(planId: string): Promise<PaymentSubscription> {
  const res = await postSubscription(
    { planId, counterpartyId: await seedCounterparty(), subscriberAddress: SUBSCRIBER },
    null
  );
  expect(res.status).toBe(201);
  return successResponseSchema(paymentSubscriptionResponseSchema).parse(await res.json()).data
    .subscription;
}

async function getSubscription(subscriptionId: string): Promise<PaymentSubscription> {
  const res = await get(`${SUBSCRIPTIONS}/${subscriptionId}`);
  expect(res.status).toBe(200);
  return successResponseSchema(paymentSubscriptionResponseSchema).parse(await res.json()).data
    .subscription;
}

/** Stands in for the subscriber's authorization landing on chain: no route records it. */
async function markAuthorized(subscriptionId: string): Promise<void> {
  const now = new Date().toISOString();
  required(
    await createPostgresPaymentSubscriptionsRepository(getDb(env)).updateSubscription({
      subscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      currentPeriodStartAt: now,
      nextCollectionDueAt: now,
      expectedStatus: "pending_authorization",
      updatedAt: now,
    })
  );
}

async function storedSubscriptionCount(): Promise<number> {
  const row = required(
    await getDb(env)
      .prepare("SELECT COUNT(*)::integer AS count FROM payment_subscriptions WHERE project_id = ?")
      .bind(TEST_PROJECT.id)
      .first<{ count: number }>()
  );
  return row.count;
}

/** What the signer is asked to sign: who signs, and each instruction's program and kind. */
function decodePrepared(prepared: { serialized: string }) {
  const transaction = getTransactionDecoder().decode(
    getBase64Encoder().encode(prepared.serialized)
  );
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  assert("instructions" in message, "Expected a compiled message with instructions");
  const instructions = message.instructions.map((instruction) => ({
    program: required(message.staticAccounts[instruction.programAddressIndex]),
    data: required(instruction.data),
  }));
  return {
    signers: new Set(Object.keys(transaction.signatures)),
    instructions,
    kinds: instructions.map(({ program, data }) => [
      program,
      identifySubscriptionsInstruction(data),
    ]),
  };
}

function expectPrepared(
  prepared: {
    serialized: string;
    blockhash: string;
    lastValidBlockHeight: string;
    requiredSigners: string[];
  },
  expected: { signer: string; instructions: SubscriptionsInstruction[] }
) {
  expect(prepared).toMatchObject({
    blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
    lastValidBlockHeight: "1000",
    requiredSigners: [expected.signer, TEST_MOCK_FEE_PAYER],
  });
  const decoded = decodePrepared(prepared);
  expect(decoded.signers).toEqual(new Set([expected.signer, TEST_MOCK_FEE_PAYER]));
  expect(decoded.kinds).toEqual(
    expected.instructions.map((kind) => [SUBSCRIPTIONS_PROGRAM_ADDRESS, kind])
  );
  return decoded;
}

describe("Payments routes — subscriptions", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcStub();

  beforeEach(() => {
    rpc.answer("getAccountInfo", mintAccountInfoResult({ decimals: 6, extensions: null }));
  });

  it("stores a Production plan's USDC as the mainnet mint", async () => {
    await seedProductionPrivyWallet({
      custodyWalletId: "cwlt_subscription_plan_production",
      publicKey: TEST_SOLANA_ADDRESSES.wallet3,
    });
    const ownerWallet = required(
      await getDb(env)
        .prepare("SELECT wallet_id FROM custody_wallets WHERE id = ?")
        .bind("cwlt_subscription_plan_production")
        .first<{ wallet_id: string }>()
    );

    const planRes = await send(
      "POST",
      PLANS,
      { ownerWalletId: ownerWallet.wallet_id, token: "USDC", amount: "25.00", periodHours: 720 },
      "plan-production-usdc"
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

  it("refuses a plan amount finer than USDC's decimals with 400 and stores no plan", async () => {
    const planRes = await send(
      "POST",
      PLANS,
      {
        ownerWalletId: TEST_WALLET_ID,
        token: DEVNET_USDC_MINT,
        amount: "1.0000001",
        periodHours: 720,
      },
      null
    );

    expect(planRes.status).toBe(400);
    expect((await errorOf(planRes)).code).toBe("BAD_REQUEST");
    const stored = await getDb(env)
      .prepare(
        "SELECT COUNT(*)::integer AS count FROM payment_subscription_plans WHERE project_id = ?"
      )
      .bind(TEST_PROJECT.id)
      .first<{ count: number }>();
    expect(stored).toEqual({ count: 0 });
  });

  it("refuses a second plan with the same on-chain plan id", async () => {
    const plan = await createPlan();

    const res = await send(
      "POST",
      PLANS,
      {
        ownerWalletId: TEST_WALLET_ID,
        token: DEVNET_USDC_MINT,
        amount: "10.00",
        periodHours: 24,
        programPlanId: plan.programPlanId,
      },
      null
    );

    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({
      code: "CONFLICT",
      message: "Subscription plan already exists",
    });
  });

  // A plan is a record and an unsigned transaction the owner signs; SDP signs
  // nothing, so a key's wallet scope does not limit it (HOO-2099).
  it("lets a key that signs with no wallet archive a project plan", async () => {
    const plan = await createPlan();
    await seedCachedKey({ walletScope: "selected", walletIds: [] });

    const archived = await updatePlan(plan.id, { status: "archived" });

    expect(archived).toMatchObject({ id: plan.id, status: "archived" });
  });

  it("replays a plan update with the same key and refuses the key with a different payload", async () => {
    const plan = await createPlan();
    const path = `${PLANS}/${plan.id}`;

    const first = await send("PATCH", path, { status: "active" }, "plan-activate-once");
    const replay = await send("PATCH", path, { status: "active" }, "plan-activate-once");
    const changed = await send("PATCH", path, { status: "archived" }, "plan-activate-once");

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
    expect(changed.status).toBe(422);
    expect((await errorOf(changed)).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await getPlan(plan.id)).status).toBe("active");
  });

  it("stores a plan's created and updated fields and prepares its on-chain creation for the owner to sign", async () => {
    const plan = await createPlan({ metadataUri: "https://sdp.dev/plan.json" });
    expect(plan).toMatchObject({
      ownerWalletId: TEST_WALLET_ID,
      ownerAddress: OWNER,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      periodHours: 720,
      planPda: null,
      pullerWalletId: null,
      metadataUri: "https://sdp.dev/plan.json",
      status: "draft",
    });
    const activated = await updatePlan(plan.id, {
      status: "active",
      pullerWalletId: TEST_WALLET_ID,
      metadataUri: "https://sdp.dev/plan-active.json",
    });
    expect(activated).toMatchObject({
      status: "active",
      pullerWalletId: TEST_WALLET_ID,
      pullerAddress: OWNER,
      metadataUri: "https://sdp.dev/plan-active.json",
    });
    expect(await getPlan(plan.id)).toEqual(activated);

    const res = await send(
      "POST",
      `${PLANS}/${plan.id}/prepare-create`,
      { destinations: [RECEIVER], endTs: "1770000000" },
      null
    );

    expect(res.status).toBe(200);
    const prepared = successResponseSchema(preparePaymentSubscriptionPlanResponseSchema).parse(
      await res.json()
    ).data;
    expectPrepared(prepared.preparedTransaction, {
      signer: OWNER,
      instructions: [SubscriptionsInstruction.CreatePlan],
    });
    const listed = successResponseSchema(paymentSubscriptionPlanListResponseSchema).parse(
      await (await get(`${PLANS}?status=active`)).json()
    );
    expect(listed.data.subscriptionPlans.map(({ id, planPda }) => [id, planPda])).toEqual([
      [plan.id, prepared.planPda],
    ]);
  });

  it("reads a plan of this project by id and lists plans by status", async () => {
    const draft = await createPlan();
    const active = await updatePlan((await createPlan()).id, { status: "active" });
    const listedIds = async (query: string) =>
      successResponseSchema(paymentSubscriptionPlanListResponseSchema)
        .parse(await (await get(`${PLANS}?${query}`)).json())
        .data.subscriptionPlans.map(({ id }) => id);

    expect(await getPlan(draft.id)).toEqual(draft);
    expect(await listedIds("status=draft")).toEqual([draft.id]);
    expect(await listedIds("status=active")).toEqual([active.id]);
  });

  it("rejects archived counterparties when creating subscriptions", async () => {
    const plan = await createPlan();
    const counterpartyId = await seedCounterparty();
    required(
      await createPostgresCounterpartiesRepository(getDb(env)).archiveCounterparty({
        counterpartyId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      })
    );

    const res = await postSubscription(
      { planId: plan.id, counterpartyId, subscriberAddress: SUBSCRIBER },
      null
    );

    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ code: "NOT_FOUND", message: "Counterparty not found" });
    expect(await storedSubscriptionCount()).toBe(0);
  });

  it("refuses a subscription for an archived plan", async () => {
    const plan = await createPlan();
    await updatePlan(plan.id, { status: "archived" });

    const res = await postSubscription(
      { planId: plan.id, counterpartyId: await seedCounterparty(), subscriberAddress: SUBSCRIBER },
      null
    );

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({
      code: "BAD_REQUEST",
      message: "Cannot create a subscription for an archived plan",
    });
    expect(await storedSubscriptionCount()).toBe(0);
  });

  it("refuses a second subscription for the same counterparty and plan", async () => {
    const plan = await createPlan();
    const first = await subscribe(plan.id);

    const res = await postSubscription(
      { planId: plan.id, counterpartyId: first.counterpartyId, subscriberAddress: RECEIVER },
      null
    );

    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({
      code: "CONFLICT",
      message: "Counterparty already has a subscription for this plan",
    });
    expect(await storedSubscriptionCount()).toBe(1);
  });

  it("replays a subscription create with the same key and refuses the key with a different payload", async () => {
    const plan = await createPlan();
    const body = {
      planId: plan.id,
      counterpartyId: await seedCounterparty(),
      subscriberAddress: SUBSCRIBER,
    };

    const first = await postSubscription(body, "subscription-create-once");
    const replay = await postSubscription(body, "subscription-create-once");
    const changed = await postSubscription(
      { ...body, subscriberAddress: RECEIVER },
      "subscription-create-once"
    );

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
    expect(changed.status).toBe(422);
    expect((await errorOf(changed)).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await storedSubscriptionCount()).toBe(1);
  });

  it("refuses a subscription paid from one of the organization's SDP wallets", async () => {
    const plan = await createPlan();
    const counterpartyId = await seedCounterparty();

    const refused = await postSubscription(
      { planId: plan.id, counterpartyId, subscriberAddress: OWNER },
      null
    );

    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toEqual(CUSTODY_SUBSCRIBER_REFUSAL);
    expect(await storedSubscriptionCount()).toBe(0);

    // The subscriber's address becomes one of the organization's SDP wallets after it subscribed:
    // its authorization and collection are refused too, and nothing is recorded.
    const created = successResponseSchema(paymentSubscriptionResponseSchema).parse(
      await (
        await postSubscription(
          { planId: plan.id, counterpartyId, subscriberAddress: SUBSCRIBER },
          null
        )
      ).json()
    ).data.subscription;
    await updateSeededWalletPublicKey(SUBSCRIBER);

    const authorizeRes = await send(
      "POST",
      `${SUBSCRIPTIONS}/${created.id}/prepare-authorization`,
      AUTHORIZATION_BODY,
      null
    );
    const collectRes = await send(
      "POST",
      `${SUBSCRIPTIONS}/${created.id}/prepare-collection`,
      { receiverTokenAccount: RECEIVER },
      null
    );

    expect(authorizeRes.status).toBe(409);
    expect(await errorOf(authorizeRes)).toEqual(CUSTODY_SUBSCRIBER_REFUSAL);
    expect(collectRes.status).toBe(409);
    expect(await errorOf(collectRes)).toEqual(CUSTODY_SUBSCRIBER_REFUSAL);
    expect(await getSubscription(created.id)).toMatchObject({
      subscriberTokenAccount: null,
      subscriptionAuthorityAddress: null,
      status: "pending_authorization",
    });
  });

  it("creates a subscription awaiting authorization and prepares the subscriber's authorization", async () => {
    const plan = await createPlan();
    await updatePlan(plan.id, { status: "active" });
    const created = await subscribe(plan.id);
    expect(created).toMatchObject({
      planId: plan.id,
      subscriberAddress: SUBSCRIBER,
      subscriberTokenAccount: null,
      subscriptionPda: null,
      subscriptionAuthorityAddress: null,
      authorizationSignature: null,
      status: "pending_authorization",
      nextCollectionDueAt: null,
    });

    const res = await send(
      "POST",
      `${SUBSCRIPTIONS}/${created.id}/prepare-authorization`,
      AUTHORIZATION_BODY,
      null
    );

    expect(res.status).toBe(200);
    const prepared = successResponseSchema(
      preparePaymentSubscriptionAuthorizationResponseSchema
    ).parse(await res.json()).data;
    expectPrepared(prepared.preparedTransaction, {
      signer: SUBSCRIBER,
      instructions: [
        SubscriptionsInstruction.InitSubscriptionAuthority,
        SubscriptionsInstruction.Subscribe,
      ],
    });
    // The addresses the authorization creates are recorded; the status waits for it to land.
    expect(await getSubscription(created.id)).toMatchObject({
      subscriberTokenAccount: RECEIVER,
      subscriptionPda: prepared.subscriptionPda,
      subscriptionAuthorityAddress: prepared.subscriptionAuthorityAddress,
      status: "pending_authorization",
    });
    const listed = successResponseSchema(paymentSubscriptionListResponseSchema).parse(
      await (await get(`${SUBSCRIPTIONS}?planId=${plan.id}&status=pending_authorization`)).json()
    );
    expect(listed.data.subscriptions.map(({ id }) => id)).toEqual([created.id]);
  });

  it("prepares an authorization only for an active plan and a subscription awaiting authorization", async () => {
    const plan = await createPlan();
    const subscription = await subscribe(plan.id);
    const authorize = () =>
      send(
        "POST",
        `${SUBSCRIPTIONS}/${subscription.id}/prepare-authorization`,
        AUTHORIZATION_BODY,
        null
      );

    const draftRes = await authorize();
    await updatePlan(plan.id, { status: "active" });
    await markAuthorized(subscription.id);
    const activeRes = await authorize();

    expect(draftRes.status).toBe(400);
    expect(await errorOf(draftRes)).toEqual({
      code: "BAD_REQUEST",
      message: "Subscription plan must be active before authorization",
    });
    expect(activeRes.status).toBe(400);
    expect(await errorOf(activeRes)).toEqual({
      code: "BAD_REQUEST",
      message: "Subscription authorization can only be prepared while pending authorization",
    });
    expect(await getSubscription(subscription.id)).toMatchObject({
      subscriberTokenAccount: null,
      subscriptionAuthorityAddress: null,
      status: "active",
    });
  });

  it("prepares the subscriber's cancel and resume", async () => {
    const plan = await createPlan();
    await updatePlan(plan.id, { status: "active" });
    const subscription = await subscribe(plan.id);
    await markAuthorized(subscription.id);

    const cancelRes = await send(
      "POST",
      `${SUBSCRIPTIONS}/${subscription.id}/prepare-cancel`,
      {},
      null
    );
    const resumeRes = await send(
      "POST",
      `${SUBSCRIPTIONS}/${subscription.id}/prepare-resume`,
      {},
      null
    );

    expect(cancelRes.status).toBe(200);
    expectPrepared(
      successResponseSchema(preparePaymentSubscriptionLifecycleResponseSchema).parse(
        await cancelRes.json()
      ).data.preparedTransaction,
      { signer: SUBSCRIBER, instructions: [SubscriptionsInstruction.CancelSubscription] }
    );
    expect(resumeRes.status).toBe(200);
    expectPrepared(
      successResponseSchema(preparePaymentSubscriptionLifecycleResponseSchema).parse(
        await resumeRes.json()
      ).data.preparedTransaction,
      { signer: SUBSCRIBER, instructions: [SubscriptionsInstruction.ResumeSubscription] }
    );
  });

  it("prepares a collection of the plan's amount for the puller, only while subscription and plan are active", async () => {
    const plan = await createPlan();
    await updatePlan(plan.id, { status: "active", pullerWalletId: TEST_WALLET_ID });
    const subscription = await subscribe(plan.id);
    const collect = (body: Record<string, unknown>) =>
      send("POST", `${SUBSCRIPTIONS}/${subscription.id}/prepare-collection`, body, null);

    const pendingRes = await collect({ receiverTokenAccount: RECEIVER });
    expect(pendingRes.status).toBe(400);
    expect(await errorOf(pendingRes)).toEqual({
      code: "BAD_REQUEST",
      message: "Subscription must be active before collection",
    });

    await markAuthorized(subscription.id);
    const amountRes = await collect({ receiverTokenAccount: RECEIVER, amount: "10.50" });
    expect(amountRes.status).toBe(400);
    expect((await errorOf(amountRes)).code).toBe("BAD_REQUEST");

    const res = await collect({ receiverTokenAccount: RECEIVER });
    expect(res.status).toBe(200);
    const decoded = expectPrepared(
      successResponseSchema(preparePaymentSubscriptionCollectionResponseSchema).parse(
        await res.json()
      ).data.preparedTransaction,
      { signer: OWNER, instructions: [SubscriptionsInstruction.TransferSubscription] }
    );
    const [transfer] = decoded.instructions;
    expect(
      getTransferSubscriptionInstructionDataDecoder().decode(required(transfer).data).transferData
    ).toEqual({ amount: 25_000_000n, delegator: SUBSCRIBER, mint: DEVNET_USDC_MINT });

    await updatePlan(plan.id, { status: "archived" });
    const archivedRes = await collect({ receiverTokenAccount: RECEIVER });
    expect(archivedRes.status).toBe(400);
    expect(await errorOf(archivedRes)).toEqual({
      code: "BAD_REQUEST",
      message: "Subscription plan must be active before collection",
    });
  });

  it("answers 404 for another project's plans and subscriptions and lists none of them", async () => {
    const plan = await createPlan();
    const subscription = await subscribe(plan.id);
    await rehomeTestApiKeyToProduction();

    const reads = [
      await get(`${PLANS}/${plan.id}`),
      await get(`${SUBSCRIPTIONS}/${subscription.id}`),
      await get(`${SUBSCRIPTIONS}/${subscription.id}/collection-attempts`),
      await send("POST", `${SUBSCRIPTIONS}/${subscription.id}/prepare-cancel`, {}, null),
      await postSubscription(
        {
          planId: plan.id,
          counterpartyId: subscription.counterpartyId,
          subscriberAddress: SUBSCRIBER,
        },
        null
      ),
    ];
    const plans = successResponseSchema(paymentSubscriptionPlanListResponseSchema).parse(
      await (await get(PLANS)).json()
    );
    const subscriptions = successResponseSchema(paymentSubscriptionListResponseSchema).parse(
      await (await get(SUBSCRIPTIONS)).json()
    );

    expect(reads.map((res) => res.status)).toEqual([404, 404, 404, 404, 404]);
    expect(plans.data).toMatchObject({ subscriptionPlans: [], total: 0 });
    expect(subscriptions.data).toMatchObject({ subscriptions: [], total: 0 });
    expect(await storedSubscriptionCount()).toBe(1);
  });
});
