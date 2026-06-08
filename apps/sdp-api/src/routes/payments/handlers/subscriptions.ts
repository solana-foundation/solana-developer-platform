import type {
  ListPaymentSubscriptionCollectionAttemptsResponse,
  ListPaymentSubscriptionPlansResponse,
  ListPaymentSubscriptionsResponse,
  PaymentSubscription,
  PaymentSubscriptionCollectionAttempt,
  PaymentSubscriptionCollectionAttemptResponse,
  PaymentSubscriptionPlan,
  PaymentSubscriptionPlanResponse,
  PaymentSubscriptionResponse,
  PreparedPaymentSubscriptionTransaction,
  PreparePaymentSubscriptionAuthorizationResponse,
  PreparePaymentSubscriptionCollectionResponse,
  PreparePaymentSubscriptionLifecycleResponse,
  PreparePaymentSubscriptionPlanResponse,
} from "@sdp/types";
import type { Address, Instruction } from "@solana/kit";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  findPlanPda,
  findSubscriptionAuthorityPda,
  findSubscriptionDelegationPda,
  getCancelSubscriptionOverlayInstructionAsync,
  getCreatePlanOverlayInstructionAsync,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getResumeSubscriptionOverlayInstructionAsync,
  getSubscribeOverlayInstructionAsync,
  getTransferSubscriptionOverlayInstructionAsync,
} from "@solana/subscriptions";
import { z } from "zod";
import { createCounterpartiesRepository } from "@/db/repositories";
import type {
  PaymentSubscriptionCollectionAttemptRow,
  PaymentSubscriptionPlanRow,
  PaymentSubscriptionRow,
} from "@/db/repositories/payment-subscriptions.repository";
import { parseDecimalAmount } from "@/lib/amount";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import { AppError, badRequest, badRequestParams, badRequestQuery } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { assertApiKeyWalletAccess } from "@/services/api-key-scope.service";
import * as solanaRpc from "@/services/solana/rpc";
import {
  type AppContext,
  getPaymentSubscriptionsRepository,
  getSponsoredFeePayer,
} from "../context";
import {
  createSubscriptionCollectionAttemptSchema,
  createSubscriptionPlanSchema,
  createSubscriptionSchema,
  listSubscriptionCollectionAttemptsQuerySchema,
  listSubscriptionPlansQuerySchema,
  listSubscriptionsQuerySchema,
  prepareSubscriptionAuthorizationSchema,
  prepareSubscriptionCollectionSchema,
  prepareSubscriptionLifecycleSchema,
  prepareSubscriptionPlanCreateSchema,
  subscriptionIdParamsSchema,
  subscriptionPlanIdParamsSchema,
  updateSubscriptionPlanSchema,
  updateSubscriptionSchema,
} from "../schemas";
import { resolveMintDecimals, resolveMintTokenProgram, SOL_MINT } from "../token-accounts";
import { resolveScope, resolveWallet } from "../wallets";

const U64_MAX = 18_446_744_073_709_551_615n;
const I64_MIN = -9_223_372_036_854_775_808n;
const I64_MAX = 9_223_372_036_854_775_807n;

function mapPlan(row: PaymentSubscriptionPlanRow): PaymentSubscriptionPlan {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    ownerWalletId: row.owner_wallet_id,
    ownerAddress: row.owner_address,
    token: row.token,
    amount: row.amount,
    periodHours: row.period_hours,
    programPlanId: row.program_plan_id,
    planPda: row.plan_pda,
    destinationAddress: row.destination_address,
    pullerWalletId: row.puller_wallet_id,
    pullerAddress: row.puller_address,
    metadataUri: row.metadata_uri,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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

function mapCollectionAttempt(
  row: PaymentSubscriptionCollectionAttemptRow
): PaymentSubscriptionCollectionAttempt {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    subscriptionId: row.subscription_id,
    transferId: row.transfer_id,
    token: row.token,
    amount: row.amount,
    dueAt: row.due_at,
    attemptedAt: row.attempted_at,
    status: row.status,
    signature: row.signature,
    error: row.error,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function defaultNextCollectionDueAt(periodHours: number): string {
  return new Date(Date.now() + periodHours * 60 * 60 * 1000).toISOString();
}

async function readOptionalJsonBody(c: AppContext): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("Invalid request body");
  }
}

function generateProgramPlanId(): string {
  const bytes = new Uint8Array(8);
  let value = 0n;

  while (value === 0n) {
    crypto.getRandomValues(bytes);
    value = 0n;
    for (const byte of bytes) {
      value = (value << 8n) | BigInt(byte);
    }
  }

  return value.toString();
}

function parseU64String(value: string, fieldName: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > U64_MAX) {
      throw new Error("out of range");
    }
    return parsed;
  } catch {
    throw new AppError("BAD_REQUEST", `${fieldName} must fit in an unsigned 64-bit integer`);
  }
}

function parseI64String(value: string, fieldName: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < I64_MIN || parsed > I64_MAX) {
      throw new Error("out of range");
    }
    return parsed;
  } catch {
    throw new AppError("BAD_REQUEST", `${fieldName} must fit in a signed 64-bit integer`);
  }
}

function assertSubscriptionTokenMint(token: string): Address {
  if (token === "SOL" || token === SOL_MINT) {
    throw new AppError("BAD_REQUEST", "Subscription plans require an SPL token mint");
  }

  return assertValidAddress(token, "token");
}

async function buildPreparedSubscriptionTransaction(
  c: AppContext,
  instructions: Instruction[],
  requiredSigners: Address[],
  feePayerOverride?: Address
): Promise<PreparedPaymentSubscriptionTransaction> {
  const rpc = solanaRpc.createRpc(c.env);
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const feePayer = feePayerOverride ?? (await getSponsoredFeePayer(c));

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  const compiled = compileTransaction(message);
  const signers = new Set<string>([...requiredSigners.map(String), String(feePayer)]);

  return {
    serialized: getBase64EncodedWireTransaction(compiled),
    blockhash: blockhash as string,
    lastValidBlockHeight: lastValidBlockHeight.toString(),
    requiredSigners: Array.from(signers),
  };
}

async function resolvePlanRuntime(
  c: AppContext,
  plan: PaymentSubscriptionPlanRow,
  amount: string = plan.amount
): Promise<{ amountBaseUnits: bigint; mint: Address; tokenProgram: Address }> {
  const mint = assertSubscriptionTokenMint(plan.token);
  const rpc = solanaRpc.createRpc(c.env);
  const [tokenProgram, decimals] = await Promise.all([
    resolveMintTokenProgram(rpc, mint),
    resolveMintDecimals(rpc, mint),
  ]);
  const amountBaseUnits = parseDecimalAmount(amount, decimals);

  if (amountBaseUnits <= 0n) {
    throw new AppError("BAD_REQUEST", "Subscription amount must be greater than zero");
  }

  return { amountBaseUnits, mint, tokenProgram };
}

async function derivePlanAddresses(
  plan: PaymentSubscriptionPlanRow
): Promise<{ owner: Address; planId: bigint; planPda: Address }> {
  const owner = assertValidAddress(plan.owner_address, "ownerAddress");
  const planId = parseU64String(plan.program_plan_id, "programPlanId");
  const [planPda] = await findPlanPda({ owner, planId });

  return { owner, planId, planPda };
}

async function persistPlanPda(
  c: AppContext,
  plan: PaymentSubscriptionPlanRow,
  planPda: Address
): Promise<PaymentSubscriptionPlanRow> {
  if (plan.plan_pda === planPda) {
    return plan;
  }

  const updated = await getPaymentSubscriptionsRepository(c).updatePlan({
    planId: plan.id,
    organizationId: plan.organization_id,
    projectId: plan.project_id,
    planPda,
    updatedAt: new Date().toISOString(),
  });

  return updated ?? plan;
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
    updatedAt: new Date().toISOString(),
  });

  return updated ?? subscription;
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
  const repo = createCounterpartiesRepository(c.env);
  const counterparty = await repo.getCounterpartyById({
    counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!counterparty) {
    throw new AppError("NOT_FOUND", "Counterparty not found");
  }
  if (counterparty.status !== "active") {
    throw new AppError("BAD_REQUEST", "Counterparty must be active before creating a subscription");
  }
}

async function resolvePlanWriteWallet(
  c: AppContext,
  plan: PaymentSubscriptionPlanRow,
  walletId = plan.owner_wallet_id
) {
  const scope = await resolveScope(c);
  const wallet = resolveWallet(scope.wallets, walletId);
  assertApiKeyWalletAccess(scope.auth, wallet.walletId, ["payments:write"]);
  return wallet;
}

async function resolvePullerWalletAddress(
  c: AppContext,
  pullerWalletId: string | null | undefined
): Promise<{
  pullerWalletId: string | null | undefined;
  pullerAddress: string | null | undefined;
}> {
  if (pullerWalletId === undefined) {
    return { pullerWalletId: undefined, pullerAddress: undefined };
  }
  if (pullerWalletId === null) {
    return { pullerWalletId: null, pullerAddress: null };
  }

  const scope = await resolveScope(c);
  const wallet = resolveWallet(scope.wallets, pullerWalletId);
  assertApiKeyWalletAccess(scope.auth, wallet.walletId, ["payments:write"]);
  return { pullerWalletId: wallet.walletId, pullerAddress: wallet.publicKey };
}

export const createSubscriptionPlan = async (c: AppContext) => {
  const projectId = requireProjectId(c);
  const body = await c.req.json();
  const parsed = createSubscriptionPlanSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const scope = await resolveScope(c);
  const ownerWallet = resolveWallet(scope.wallets, parsed.data.ownerWalletId);
  assertApiKeyWalletAccess(scope.auth, ownerWallet.walletId, ["payments:write"]);

  const puller = await resolvePullerWalletAddress(c, parsed.data.pullerWalletId);
  const now = new Date().toISOString();
  const id = `psp_${crypto.randomUUID()}`;
  const createdBy = await resolveCreatorUserId(c);
  const repo = getPaymentSubscriptionsRepository(c);

  const plan = await repo.createPlan({
    id,
    organizationId: scope.auth.organizationId,
    projectId,
    ownerWalletId: ownerWallet.walletId,
    ownerAddress: ownerWallet.publicKey,
    token: parsed.data.token,
    amount: parsed.data.amount,
    periodHours: parsed.data.periodHours,
    programPlanId: parsed.data.programPlanId ?? generateProgramPlanId(),
    planPda: parsed.data.planPda ?? null,
    destinationAddress: parsed.data.destinationAddress ?? null,
    pullerWalletId: puller.pullerWalletId ?? null,
    pullerAddress: puller.pullerAddress ?? null,
    metadataUri: parsed.data.metadataUri ?? null,
    status: parsed.data.status,
    createdBy,
    createdAt: now,
    updatedAt: now,
  });

  if (!plan) {
    throw new AppError("CONFLICT", "Subscription plan already exists");
  }

  const response: PaymentSubscriptionPlanResponse = { subscriptionPlan: mapPlan(plan) };
  return created(c, response);
};

export const listSubscriptionPlans = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const parsed = listSubscriptionPlansQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  const { page, pageSize, status } = parsed.data;
  const repo = getPaymentSubscriptionsRepository(c);
  const { rows, total } = await repo.listPlans({
    organizationId: auth.organizationId,
    projectId,
    status,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const response: ListPaymentSubscriptionPlansResponse = {
    subscriptionPlans: rows.map(mapPlan),
    total,
    page,
    pageSize,
  };

  return success(c, response);
};

export const getSubscriptionPlan = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = subscriptionPlanIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const repo = getPaymentSubscriptionsRepository(c);
  const plan = await repo.getPlanById({
    planId: params.data.planId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!plan) {
    throw new AppError("NOT_FOUND", "Subscription plan not found");
  }

  const response: PaymentSubscriptionPlanResponse = { subscriptionPlan: mapPlan(plan) };
  return success(c, response);
};

export const prepareCreateSubscriptionPlan = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = subscriptionPlanIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await readOptionalJsonBody(c);
  const parsed = prepareSubscriptionPlanCreateSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const repo = getPaymentSubscriptionsRepository(c);
  const plan = await repo.getPlanById({
    planId: params.data.planId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!plan) {
    throw new AppError("NOT_FOUND", "Subscription plan not found");
  }
  if (plan.status === "archived") {
    throw new AppError("BAD_REQUEST", "Cannot prepare an archived subscription plan");
  }

  const scope = await resolveScope(c);
  const ownerWallet = resolveWallet(scope.wallets, plan.owner_wallet_id);
  assertApiKeyWalletAccess(scope.auth, ownerWallet.walletId, ["payments:write"]);

  const { owner, planId, planPda } = await derivePlanAddresses(plan);
  if (ownerWallet.publicKey !== owner) {
    throw new AppError(
      "BAD_REQUEST",
      "Subscription plan owner wallet does not match owner address"
    );
  }

  const destinations = (
    parsed.data.destinations ?? (plan.destination_address ? [plan.destination_address] : [])
  ).map((value) => assertValidAddress(value, "destinations entry"));
  if (destinations.length === 0) {
    throw new AppError(
      "BAD_REQUEST",
      "At least one destination address is required to create an on-chain subscription plan"
    );
  }

  const pullers = (
    parsed.data.pullers ?? (plan.puller_address ? [plan.puller_address] : [plan.owner_address])
  ).map((value) => assertValidAddress(value, "pullers entry"));
  const { amountBaseUnits, mint, tokenProgram } = await resolvePlanRuntime(c, plan);
  const endTs = parsed.data.endTs ? parseU64String(parsed.data.endTs, "endTs") : 0n;
  const metadataUri = parsed.data.metadataUri ?? plan.metadata_uri ?? "";

  const instruction = await getCreatePlanOverlayInstructionAsync({
    amount: amountBaseUnits,
    destinations,
    endTs,
    metadataUri,
    mint,
    owner: createNoopSigner(owner),
    periodHours: BigInt(plan.period_hours),
    planId,
    pullers,
    tokenProgram,
  });
  const updatedPlan = await persistPlanPda(c, plan, planPda);
  const preparedTransaction = await buildPreparedSubscriptionTransaction(c, [instruction], [owner]);
  const response: PreparePaymentSubscriptionPlanResponse = {
    subscriptionPlan: mapPlan(updatedPlan),
    planPda,
    preparedTransaction,
  };

  return success(c, response);
};

export const updateSubscriptionPlan = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = subscriptionPlanIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await c.req.json();
  const parsed = updateSubscriptionPlanSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const repo = getPaymentSubscriptionsRepository(c);
  const existingPlan = await repo.getPlanById({
    planId: params.data.planId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!existingPlan) {
    throw new AppError("NOT_FOUND", "Subscription plan not found");
  }

  await resolvePlanWriteWallet(c, existingPlan);

  const puller = await resolvePullerWalletAddress(c, parsed.data.pullerWalletId);
  const updated = await repo.updatePlan({
    planId: params.data.planId,
    organizationId: auth.organizationId,
    projectId,
    planPda: parsed.data.planPda,
    destinationAddress: parsed.data.destinationAddress,
    pullerWalletId: puller.pullerWalletId,
    pullerAddress: puller.pullerAddress,
    metadataUri: parsed.data.metadataUri,
    status: parsed.data.status,
    updatedAt: new Date().toISOString(),
  });

  if (!updated) {
    throw new AppError("NOT_FOUND", "Subscription plan not found");
  }

  const response: PaymentSubscriptionPlanResponse = { subscriptionPlan: mapPlan(updated) };
  return success(c, response);
};

export const createSubscription = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const body = await c.req.json();
  const parsed = createSubscriptionSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const repo = getPaymentSubscriptionsRepository(c);
  const plan = await repo.getPlanById({
    planId: parsed.data.planId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!plan) {
    throw new AppError("NOT_FOUND", "Subscription plan not found");
  }
  if (plan.status === "archived") {
    throw new AppError("BAD_REQUEST", "Cannot create a subscription for an archived plan");
  }

  await requireActiveCounterparty(c, parsed.data.counterpartyId);

  const existing = await repo.listSubscriptions({
    organizationId: auth.organizationId,
    projectId,
    planId: parsed.data.planId,
    counterpartyId: parsed.data.counterpartyId,
    limit: 1,
    offset: 0,
  });
  if (existing.total > 0) {
    throw new AppError("CONFLICT", "Counterparty already has a subscription for this plan");
  }

  const now = new Date().toISOString();
  const createdBy = await resolveCreatorUserId(c);
  const status = parsed.data.status;
  const currentPeriodStartAt =
    parsed.data.currentPeriodStartAt ?? (status === "active" ? now : null);
  const nextCollectionDueAt =
    parsed.data.nextCollectionDueAt ??
    (status === "active" ? defaultNextCollectionDueAt(plan.period_hours) : null);

  const subscription = await repo.createSubscription({
    id: `psub_${crypto.randomUUID()}`,
    organizationId: auth.organizationId,
    projectId,
    planId: parsed.data.planId,
    counterpartyId: parsed.data.counterpartyId,
    subscriberAddress: parsed.data.subscriberAddress,
    subscriberTokenAccount: parsed.data.subscriberTokenAccount ?? null,
    subscriptionPda: parsed.data.subscriptionPda ?? null,
    subscriptionAuthorityAddress: parsed.data.subscriptionAuthorityAddress ?? null,
    authorizationSignature: parsed.data.authorizationSignature ?? null,
    status,
    currentPeriodStartAt,
    nextCollectionDueAt,
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

export const prepareSubscriptionAuthorization = async (c: AppContext) => {
  const params = subscriptionIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await c.req.json();
  const parsed = prepareSubscriptionAuthorizationSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const { plan, subscription } = await getSubscriptionWithPlan(c, params.data.subscriptionId);
  if (plan.status !== "active") {
    throw new AppError("BAD_REQUEST", "Subscription plan must be active before authorization");
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
    parsed.data.subscriberTokenAccount,
    "subscriberTokenAccount"
  );
  const { amountBaseUnits, mint, tokenProgram } = await resolvePlanRuntime(c, plan);
  const expectedCreatedAt = parseU64String(
    parsed.data.expectedPlanCreatedAt,
    "expectedPlanCreatedAt"
  );
  const expectedSubscriptionAuthorityInitId = parseI64String(
    parsed.data.expectedSubscriptionAuthorityInitId,
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
    c,
    [initAuthorityInstruction, subscribeInstruction],
    [subscriber],
    feePayer
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

export const updateSubscription = async (c: AppContext) => {
  const params = subscriptionIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await c.req.json();
  const parsed = updateSubscriptionSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const { plan, subscription } = await getSubscriptionWithPlan(c, params.data.subscriptionId);
  await resolvePlanWriteWallet(c, plan);

  const repo = getPaymentSubscriptionsRepository(c);
  const updated = await repo.updateSubscription({
    subscriptionId: subscription.id,
    organizationId: subscription.organization_id,
    projectId: subscription.project_id,
    subscriberTokenAccount: parsed.data.subscriberTokenAccount,
    subscriptionPda: parsed.data.subscriptionPda,
    subscriptionAuthorityAddress: parsed.data.subscriptionAuthorityAddress,
    authorizationSignature: parsed.data.authorizationSignature,
    status: parsed.data.status,
    currentPeriodStartAt: parsed.data.currentPeriodStartAt,
    nextCollectionDueAt: parsed.data.nextCollectionDueAt,
    cancelAt: parsed.data.cancelAt,
    canceledAt: parsed.data.canceledAt,
    updatedAt: new Date().toISOString(),
  });

  if (!updated) {
    throw new AppError("NOT_FOUND", "Subscription not found");
  }

  const response: PaymentSubscriptionResponse = { subscription: mapSubscription(updated) };
  return success(c, response);
};

async function prepareSubscriptionLifecycle(
  c: AppContext,
  operation: "cancel" | "resume"
): Promise<Response> {
  const params = subscriptionIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await readOptionalJsonBody(c);
  const parsed = prepareSubscriptionLifecycleSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const { plan, subscription } = await getSubscriptionWithPlan(c, params.data.subscriptionId);
  const { planPda } = await derivePlanAddresses(plan);
  const subscriber = assertValidAddress(subscription.subscriber_address, "subscriberAddress");
  const [derivedSubscriptionPda] = await findSubscriptionDelegationPda({ planPda, subscriber });
  const subscriptionPda = subscription.subscription_pda
    ? assertValidAddress(subscription.subscription_pda, "subscriptionPda")
    : derivedSubscriptionPda;
  const subscriberSigner = createNoopSigner(subscriber);
  const instruction =
    operation === "cancel"
      ? await getCancelSubscriptionOverlayInstructionAsync({
          planPda,
          subscriber: subscriberSigner,
          subscriptionPda,
        })
      : await getResumeSubscriptionOverlayInstructionAsync({
          planPda,
          subscriber: subscriberSigner,
          subscriptionPda,
        });
  const preparedTransaction = await buildPreparedSubscriptionTransaction(
    c,
    [instruction],
    [subscriber]
  );
  const response: PreparePaymentSubscriptionLifecycleResponse = {
    subscription: mapSubscription(subscription),
    preparedTransaction,
  };

  return success(c, response);
}

export const prepareCancelSubscription = async (c: AppContext) =>
  prepareSubscriptionLifecycle(c, "cancel");

export const prepareResumeSubscription = async (c: AppContext) =>
  prepareSubscriptionLifecycle(c, "resume");

export const prepareSubscriptionCollection = async (c: AppContext) => {
  const params = subscriptionIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await c.req.json();
  const parsed = prepareSubscriptionCollectionSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const { plan, subscription } = await getSubscriptionWithPlan(c, params.data.subscriptionId);
  if (subscription.status !== "active") {
    throw new AppError("BAD_REQUEST", "Subscription must be active before collection");
  }
  if (plan.status !== "active") {
    throw new AppError("BAD_REQUEST", "Subscription plan must be active before collection");
  }

  const callerWallet = await resolvePlanWriteWallet(
    c,
    plan,
    plan.puller_wallet_id ?? plan.owner_wallet_id
  );

  const { amountBaseUnits, mint, tokenProgram } = await resolvePlanRuntime(
    c,
    plan,
    parsed.data.amount ?? plan.amount
  );
  const { planPda } = await derivePlanAddresses(plan);
  const subscriber = assertValidAddress(subscription.subscriber_address, "subscriberAddress");
  const [derivedSubscriptionPda] = await findSubscriptionDelegationPda({ planPda, subscriber });
  const subscriptionPda = subscription.subscription_pda
    ? assertValidAddress(subscription.subscription_pda, "subscriptionPda")
    : derivedSubscriptionPda;
  const receiverAta = assertValidAddress(parsed.data.receiverTokenAccount, "receiverTokenAccount");
  const caller = assertValidAddress(callerWallet.publicKey, "caller");
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
    c,
    [instruction],
    [caller]
  );
  const response: PreparePaymentSubscriptionCollectionResponse = {
    subscription: mapSubscription(subscription),
    preparedTransaction,
  };

  return success(c, response);
};

export const createSubscriptionCollectionAttempt = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = subscriptionIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await c.req.json();
  const parsed = createSubscriptionCollectionAttemptSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
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
  if (subscription.status !== "active") {
    throw new AppError("BAD_REQUEST", "Subscription must be active before collection");
  }

  const plan = await repo.getPlanById({
    planId: subscription.plan_id,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!plan) {
    throw new AppError("NOT_FOUND", "Subscription plan not found");
  }
  if (plan.status !== "active") {
    throw new AppError("BAD_REQUEST", "Subscription plan must be active before collection");
  }

  await resolvePlanWriteWallet(c, plan, plan.puller_wallet_id ?? plan.owner_wallet_id);

  const now = new Date().toISOString();
  const attempt = await repo.createCollectionAttempt({
    id: `psca_${crypto.randomUUID()}`,
    organizationId: auth.organizationId,
    projectId,
    subscriptionId: subscription.id,
    transferId: parsed.data.transferId ?? null,
    token: parsed.data.token ?? plan.token,
    amount: parsed.data.amount ?? plan.amount,
    dueAt: parsed.data.dueAt ?? subscription.next_collection_due_at ?? now,
    attemptedAt: parsed.data.attemptedAt ?? null,
    status: parsed.data.status,
    signature: parsed.data.signature ?? null,
    error: parsed.data.error ?? null,
    metadata: parsed.data.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  });

  if (!attempt) {
    throw new AppError("CONFLICT", "Collection attempt already exists");
  }

  const response: PaymentSubscriptionCollectionAttemptResponse = {
    collectionAttempt: mapCollectionAttempt(attempt),
  };
  return created(c, response);
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
    collectionAttempts: rows.map(mapCollectionAttempt),
    total,
    page,
    pageSize,
  };

  return success(c, response);
};
