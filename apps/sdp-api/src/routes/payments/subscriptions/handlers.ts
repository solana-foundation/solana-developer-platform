import * as solanaRpc from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import type {
  ListPaymentSubscriptionCollectionAttemptsResponse,
  ListPaymentSubscriptionsResponse,
  PaymentSubscription,
  PaymentSubscriptionResponse,
  PreparePaymentSubscriptionAuthorizationResponse,
  PreparePaymentSubscriptionCollectionResponse,
  PreparePaymentSubscriptionLifecycleResponse,
} from "@sdp/types";
import type { Address } from "@solana/kit";
import { createNoopSigner } from "@solana/kit";
import {
  fetchMaybeSubscriptionDelegation,
  findSubscriptionAuthorityPda,
  findSubscriptionDelegationPda,
  getCancelSubscriptionOverlayInstructionAsync,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getResumeSubscriptionOverlayInstructionAsync,
  getSubscribeOverlayInstructionAsync,
  getTransferSubscriptionOverlayInstructionAsync,
  type Plan,
  PlanStatus,
} from "@solana/subscriptions";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { z } from "zod";
import { createCounterpartiesRepository } from "@/db/repositories";
import type {
  PaymentSubscriptionPlanRow,
  PaymentSubscriptionRow,
} from "@/db/repositories/payment-subscriptions.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import { AppError, badRequest, badRequestParams, badRequestQuery } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { assertApiKeyWalletAccess } from "@/services/api-key-scope.service";
import { parseI64String, parseU64String } from "@/services/payment-operation.service";
import {
  assertSubscriptionTokenMint,
  buildPreparedSubscriptionTransaction,
  derivePlanAddresses,
  fetchLiveSubscriptionPlan,
  resolvePlanRuntime,
} from "@/services/payments/recurring-payments/shared";
import {
  type AppContext,
  getPaymentSubscriptionsRepository,
  getSponsoredFeePayer,
} from "../context";
import { mapCollectionAttemptRow } from "../mappers";
import { resolveScope, resolveWallet } from "../wallets";
import {
  type createSubscriptionSchema,
  listSubscriptionCollectionAttemptsQuerySchema,
  listSubscriptionsQuerySchema,
  type prepareSubscriptionAuthorizationSchema,
  type prepareSubscriptionCollectionSchema,
  type prepareSubscriptionLifecycleSchema,
  subscriptionIdParamsSchema,
} from "./schemas";

function mapSubscription(row: PaymentSubscriptionRow): PaymentSubscription {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    planId: row.plan_id,
    counterpartyId: row.counterparty_id,
    subscriberAddress: row.subscriber_address,
    subscriberTokenAccount: row.subscriber_token_account,
    subscriptionPda: row.subscription_pda,
    subscriptionAuthorityAddress: row.subscription_authority_address,
    authorizationSignature: row.authorization_signature,
    status: row.status,
    currentPeriodStartAt: row.current_period_start_at,
    nextCollectionDueAt: row.next_collection_due_at,
    cancelAt: row.cancel_at,
    canceledAt: row.canceled_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getExpectedSubscriptionExpiresAtTs(
  c: AppContext,
  subscriptionPda: Address
): Promise<bigint> {
  const onChainSubscription = await fetchMaybeSubscriptionDelegation(
    solanaRpc.createRpc(c.env),
    subscriptionPda,
    { commitment: "confirmed" }
  );
  if (!onChainSubscription.exists) {
    throw new AppError("CONFLICT", "Subscription was not found on-chain");
  }
  return onChainSubscription.data.expiresAtTs;
}

async function persistSubscriptionAuthorizationAddresses(
  c: AppContext,
  subscription: PaymentSubscriptionRow,
  input: {
    subscriberTokenAccount: Address;
    subscriptionPda: Address;
    subscriptionAuthorityAddress: Address;
  }
): Promise<PaymentSubscriptionRow> {
  if (
    subscription.subscriber_token_account === input.subscriberTokenAccount &&
    subscription.subscription_pda === input.subscriptionPda &&
    subscription.subscription_authority_address === input.subscriptionAuthorityAddress
  ) {
    return subscription;
  }

  const updated = await getPaymentSubscriptionsRepository(c).updateSubscription({
    subscriptionId: subscription.id,
    organizationId: subscription.organization_id,
    projectId: subscription.project_id,
    subscriberTokenAccount: input.subscriberTokenAccount,
    subscriptionPda: input.subscriptionPda,
    subscriptionAuthorityAddress: input.subscriptionAuthorityAddress,
    expectedStatus: "pending_authorization",
    updatedAt: new Date().toISOString(),
  });

  if (!updated) {
    throw new AppError(
      "CONFLICT",
      "Subscription authorization state changed while preparing authorization"
    );
  }

  return updated;
}

async function getSubscriptionWithPlan(
  c: AppContext,
  subscriptionId: string
): Promise<{ plan: PaymentSubscriptionPlanRow; subscription: PaymentSubscriptionRow }> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const repo = getPaymentSubscriptionsRepository(c);
  const subscription = await repo.getSubscriptionById({
    subscriptionId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!subscription) {
    throw new AppError("NOT_FOUND", "Subscription not found");
  }

  const plan = await repo.getPlanById({
    planId: subscription.plan_id,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!plan) {
    throw new AppError("NOT_FOUND", "Subscription plan not found");
  }

  return { plan, subscription };
}

async function requireActiveCounterparty(c: AppContext, counterpartyId: string): Promise<void> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const repo = createCounterpartiesRepository(c.env, getRequestTenantScope(c));
  const counterparty = await repo.getCounterpartyById({
    counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!counterparty) {
    throw new AppError("NOT_FOUND", "Counterparty not found");
  }
  if (counterparty.status !== "active") {
    throw badRequest("Counterparty must be active before creating a subscription");
  }
}

export const createSubscription = async (
  c: ValidatedBodyContext<typeof createSubscriptionSchema>
) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  const repo = getPaymentSubscriptionsRepository(c);
  const plan = await repo.getPlanById({
    planId: body.planId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!plan) {
    throw new AppError("NOT_FOUND", "Subscription plan not found");
  }
  if (plan.status === "archived") {
    throw badRequest("Cannot create a subscription for an archived plan");
  }

  await requireActiveCounterparty(c, body.counterpartyId);

  const existing = await repo.listSubscriptions({
    organizationId: auth.organizationId,
    projectId,
    planId: body.planId,
    counterpartyId: body.counterpartyId,
    limit: 1,
    offset: 0,
  });
  if (existing.total > 0) {
    throw new AppError("CONFLICT", "Counterparty already has a subscription for this plan");
  }

  const now = new Date().toISOString();
  const createdBy = await resolveCreatorUserId(c);

  const subscription = await repo.createSubscription({
    id: `psub_${crypto.randomUUID()}`,
    organizationId: auth.organizationId,
    projectId,
    planId: body.planId,
    counterpartyId: body.counterpartyId,
    subscriberAddress: body.subscriberAddress,
    subscriberTokenAccount: null,
    subscriptionPda: null,
    subscriptionAuthorityAddress: null,
    authorizationSignature: null,
    status: "pending_authorization",
    currentPeriodStartAt: null,
    nextCollectionDueAt: null,
    createdBy,
    createdAt: now,
    updatedAt: now,
  });

  if (!subscription) {
    throw new AppError("CONFLICT", "Counterparty already has a subscription for this plan");
  }

  const response: PaymentSubscriptionResponse = { subscription: mapSubscription(subscription) };
  return created(c, response);
};

export const prepareSubscriptionAuthorization = async (
  c: ValidatedBodyContext<typeof prepareSubscriptionAuthorizationSchema>
) => {
  const params = subscriptionIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = c.req.valid("json");

  const { plan, subscription } = await getSubscriptionWithPlan(c, params.data.subscriptionId);
  if (plan.status !== "active") {
    throw badRequest("Subscription plan must be active before authorization");
  }
  if (subscription.status !== "pending_authorization") {
    throw new AppError(
      "BAD_REQUEST",
      "Subscription authorization can only be prepared while pending authorization"
    );
  }

  const { owner, planId, planPda } = await derivePlanAddresses(plan);
  const subscriber = assertValidAddress(subscription.subscriber_address, "subscriberAddress");
  const subscriberTokenAccount = assertValidAddress(
    body.subscriberTokenAccount,
    "subscriberTokenAccount"
  );
  const { amountBaseUnits, mint, tokenProgram } = await resolvePlanRuntime(c.env, plan);
  const expectedCreatedAt = parseU64String(body.expectedPlanCreatedAt, "expectedPlanCreatedAt");
  const expectedSubscriptionAuthorityInitId = parseI64String(
    body.expectedSubscriptionAuthorityInitId,
    // biome-ignore lint/security/noSecrets: Field name used for validation errors, not a secret.
    "expectedSubscriptionAuthorityInitId"
  );
  const [subscriptionAuthorityAddress] = await findSubscriptionAuthorityPda({
    tokenMint: mint,
    user: subscriber,
  });
  const [subscriptionPda] = await findSubscriptionDelegationPda({ planPda, subscriber });
  const feePayer = await getSponsoredFeePayer(c);
  const payer = createNoopSigner(feePayer);
  const subscriberSigner = createNoopSigner(subscriber);
  const initAuthorityInstruction = await getInitSubscriptionAuthorityOverlayInstructionAsync({
    owner: subscriberSigner,
    payer,
    tokenMint: mint,
    tokenProgram,
    userAta: subscriberTokenAccount,
  });
  const subscribeInstruction = await getSubscribeOverlayInstructionAsync({
    expectedAmount: amountBaseUnits,
    expectedCreatedAt,
    expectedPeriodHours: BigInt(plan.period_hours),
    expectedSubscriptionAuthorityInitId,
    merchant: owner,
    payer,
    planId,
    subscriber: subscriberSigner,
    tokenMint: mint,
  });
  const updatedSubscription = await persistSubscriptionAuthorizationAddresses(c, subscription, {
    subscriberTokenAccount,
    subscriptionAuthorityAddress,
    subscriptionPda,
  });
  const preparedTransaction = await buildPreparedSubscriptionTransaction(
    c.env,
    feePayer,
    [initAuthorityInstruction, subscribeInstruction],
    [subscriber]
  );
  const response: PreparePaymentSubscriptionAuthorizationResponse = {
    subscription: mapSubscription(updatedSubscription),
    subscriptionAuthorityAddress,
    subscriptionPda,
    preparedTransaction,
  };

  return success(c, response);
};

export const listSubscriptions = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const parsed = listSubscriptionsQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  const { page, pageSize, planId, counterpartyId, status, dueBefore } = parsed.data;
  const repo = getPaymentSubscriptionsRepository(c);
  const { rows, total } = await repo.listSubscriptions({
    organizationId: auth.organizationId,
    projectId,
    planId,
    counterpartyId,
    status,
    dueBefore,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const response: ListPaymentSubscriptionsResponse = {
    subscriptions: rows.map(mapSubscription),
    total,
    page,
    pageSize,
  };

  return success(c, response);
};

export const getSubscription = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = subscriptionIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const repo = getPaymentSubscriptionsRepository(c);
  const subscription = await repo.getSubscriptionById({
    subscriptionId: params.data.subscriptionId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!subscription) {
    throw new AppError("NOT_FOUND", "Subscription not found");
  }

  const response: PaymentSubscriptionResponse = { subscription: mapSubscription(subscription) };
  return success(c, response);
};

async function prepareSubscriptionLifecycle(
  c: ValidatedBodyContext<typeof prepareSubscriptionLifecycleSchema>,
  operation: "cancel" | "resume"
): Promise<Response> {
  const params = subscriptionIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const { plan, subscription } = await getSubscriptionWithPlan(c, params.data.subscriptionId);
  const { planPda } = await derivePlanAddresses(plan);
  const subscriber = assertValidAddress(subscription.subscriber_address, "subscriberAddress");
  const [derivedSubscriptionPda] = await findSubscriptionDelegationPda({ planPda, subscriber });
  const subscriptionPda = subscription.subscription_pda
    ? assertValidAddress(subscription.subscription_pda, "subscriptionPda")
    : derivedSubscriptionPda;
  const tokenMint = assertSubscriptionTokenMint(plan.token);
  const subscriberSigner = createNoopSigner(subscriber);
  const instruction =
    operation === "cancel"
      ? await getCancelSubscriptionOverlayInstructionAsync({
          planPda,
          subscriber: subscriberSigner,
          subscriptionPda,
        })
      : await getResumeSubscriptionOverlayInstructionAsync({
          expectedExpiresAtTs: await getExpectedSubscriptionExpiresAtTs(c, subscriptionPda),
          planPda,
          subscriber: subscriberSigner,
          subscriptionPda,
          tokenMint,
        });
  const preparedTransaction = await buildPreparedSubscriptionTransaction(
    c.env,
    await getSponsoredFeePayer(c),
    [instruction],
    [subscriber]
  );
  const response: PreparePaymentSubscriptionLifecycleResponse = {
    subscription: mapSubscription(subscription),
    preparedTransaction,
  };

  return success(c, response);
}

export const prepareCancelSubscription = async (
  c: ValidatedBodyContext<typeof prepareSubscriptionLifecycleSchema>
) => prepareSubscriptionLifecycle(c, "cancel");

export const prepareResumeSubscription = async (
  c: ValidatedBodyContext<typeof prepareSubscriptionLifecycleSchema>
) => prepareSubscriptionLifecycle(c, "resume");

/**
 * The subscriptions program is the source of truth for collection consent
 * (SOLA9-634): a prepared transfer may only move funds the way the on-chain
 * plan already allows, so the request must match authoritative chain state.
 */
async function assertCollectionMatchesOnChainPlan(input: {
  plan: PaymentSubscriptionPlanRow;
  onChainPlan: Plan;
  amountBaseUnits: bigint;
  caller: Address;
  receiverAta: Address;
  mint: Address;
  tokenProgram: Address;
  storedSubscriptionPda: Address | null;
  derivedSubscriptionPda: Address;
}): Promise<void> {
  const { onChainPlan } = input;
  if (onChainPlan.status !== PlanStatus.Active) {
    throw badRequest("Subscription plan is not active on-chain");
  }
  if (onChainPlan.data.terms.amount !== input.amountBaseUnits) {
    throw badRequest("Subscription plan amount does not match the on-chain plan");
  }
  if (onChainPlan.data.terms.periodHours !== BigInt(input.plan.period_hours)) {
    throw badRequest("Subscription plan period does not match the on-chain plan");
  }
  if (!onChainPlan.data.pullers.includes(input.caller)) {
    throw badRequest("Collection caller is not an authorized puller on the on-chain plan");
  }

  const destinationTokenAccounts = await Promise.all(
    onChainPlan.data.destinations.map(
      async (destination) =>
        (
          await findAssociatedTokenPda({
            mint: input.mint,
            owner: destination,
            tokenProgram: input.tokenProgram,
          })
        )[0]
    )
  );
  if (!destinationTokenAccounts.includes(input.receiverAta)) {
    throw badRequest(
      "Receiver token account is not an associated token account of an on-chain plan destination"
    );
  }

  if (
    input.storedSubscriptionPda !== null &&
    input.storedSubscriptionPda !== input.derivedSubscriptionPda
  ) {
    throw badRequest("Subscription does not match the derived on-chain subscription address");
  }
}

export const prepareSubscriptionCollection = async (
  c: ValidatedBodyContext<typeof prepareSubscriptionCollectionSchema>
) => {
  const params = subscriptionIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = c.req.valid("json");

  const { plan, subscription } = await getSubscriptionWithPlan(c, params.data.subscriptionId);
  if (subscription.status !== "active") {
    throw badRequest("Subscription must be active before collection");
  }
  if (plan.status !== "active") {
    throw badRequest("Subscription plan must be active before collection");
  }

  const scope = await resolveScope(c);
  const callerWallet = resolveWallet(scope.wallets, plan.puller_wallet_id ?? plan.owner_wallet_id);
  assertApiKeyWalletAccess(scope.auth, callerWallet.walletId, ["payments:write"]);

  const { amountBaseUnits, mint, tokenProgram } = await resolvePlanRuntime(c.env, plan);
  const { planPda } = await derivePlanAddresses(plan);
  const subscriber = assertValidAddress(subscription.subscriber_address, "subscriberAddress");
  const [derivedSubscriptionPda] = await findSubscriptionDelegationPda({ planPda, subscriber });
  const storedSubscriptionPda = subscription.subscription_pda
    ? assertValidAddress(subscription.subscription_pda, "subscriptionPda")
    : null;
  const subscriptionPda = storedSubscriptionPda ?? derivedSubscriptionPda;
  const receiverAta = assertValidAddress(body.receiverTokenAccount, "receiverTokenAccount");
  const caller = assertValidAddress(callerWallet.publicKey, "caller");

  const onChainPlan = await fetchLiveSubscriptionPlan(c.env, planPda);
  if (!onChainPlan) {
    throw badRequest("Subscription plan was not found on-chain");
  }
  await assertCollectionMatchesOnChainPlan({
    plan,
    onChainPlan,
    amountBaseUnits,
    caller,
    receiverAta,
    mint,
    tokenProgram,
    storedSubscriptionPda,
    derivedSubscriptionPda,
  });

  const instruction = await getTransferSubscriptionOverlayInstructionAsync({
    amount: amountBaseUnits,
    caller: createNoopSigner(caller),
    delegator: subscriber,
    planPda,
    receiverAta,
    subscriptionPda,
    tokenMint: mint,
    tokenProgram,
  });
  const preparedTransaction = await buildPreparedSubscriptionTransaction(
    c.env,
    await getSponsoredFeePayer(c),
    [instruction],
    [caller]
  );
  const response: PreparePaymentSubscriptionCollectionResponse = {
    subscription: mapSubscription(subscription),
    preparedTransaction,
  };

  return success(c, response);
};

export const listSubscriptionCollectionAttempts = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = subscriptionIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const parsed = listSubscriptionCollectionAttemptsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  const repo = getPaymentSubscriptionsRepository(c);
  const subscription = await repo.getSubscriptionById({
    subscriptionId: params.data.subscriptionId,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!subscription) {
    throw new AppError("NOT_FOUND", "Subscription not found");
  }

  const { page, pageSize, status } = parsed.data;
  const { rows, total } = await repo.listCollectionAttempts({
    organizationId: auth.organizationId,
    projectId,
    subscriptionId: params.data.subscriptionId,
    status,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const response: ListPaymentSubscriptionCollectionAttemptsResponse = {
    collectionAttempts: rows.map(mapCollectionAttemptRow),
    total,
    page,
    pageSize,
  };

  return success(c, response);
};
