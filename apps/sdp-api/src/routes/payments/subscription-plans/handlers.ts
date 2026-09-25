import { generateProgramPlanId } from "@sdp/payments/recurring-payment-lifecycle";
import { assertValidAddress } from "@sdp/solana/address";
import type {
  ListPaymentSubscriptionPlansResponse,
  PaymentSubscriptionPlan,
  PaymentSubscriptionPlanResponse,
  PreparePaymentSubscriptionPlanResponse,
} from "@sdp/types";
import type { Address } from "@solana/kit";
import { createNoopSigner } from "@solana/kit";
import {
  getCreatePlanOverlayInstructionAsync,
  findPlanPda,
  PlanStatus,
} from "@solana/subscriptions";
import { z } from "zod";
import type { PaymentSubscriptionPlanRow } from "@/db/repositories/payment-subscriptions.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import { AppError, badRequest, badRequestParams, badRequestQuery } from "@/lib/errors";
import { created, success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { assertApiKeyWalletAccess } from "@/services/api-key-scope.service";
import { normalizePaymentToken, parseU64String } from "@/services/payment-operation.service";
import {
  buildPreparedSubscriptionTransaction,
  derivePlanAddresses,
  fetchLiveSubscriptionPlan,
  resolvePlanRuntime,
  subscriptionProgramMetadataUri,
} from "@/services/payments/recurring-payments/shared";
import {
  type AppContext,
  getPaymentSubscriptionsRepository,
  getSponsoredFeePayer,
} from "../context";
import { resolveScope, resolveWallet } from "../wallets";
import {
  type createSubscriptionPlanSchema,
  listSubscriptionPlansQuerySchema,
  type prepareSubscriptionPlanCreateSchema,
  subscriptionPlanIdParamsSchema,
  type updateSubscriptionPlanSchema,
} from "./schemas";

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

/**
 * Persists the identifiers of a prepared create-plan transaction. The
 * destination is synced in the same write: the create instruction is the
 * consent artifact for the plan's destinations, and once the plan PDA is
 * stored the destination becomes uncorrectable, so the record must already
 * describe what the chain will confirm (SOLA9-634).
 */
async function persistPreparedCreate(
  c: AppContext,
  plan: PaymentSubscriptionPlanRow,
  planPda: Address,
  destinationAddress: string
): Promise<PaymentSubscriptionPlanRow> {
  if (plan.plan_pda === planPda && plan.destination_address === destinationAddress) {
    return plan;
  }

  const updated = await getPaymentSubscriptionsRepository(c).updatePlan({
    planId: plan.id,
    organizationId: plan.organization_id,
    projectId: plan.project_id,
    planPda,
    destinationAddress,
    updatedAt: new Date().toISOString(),
  });

  return updated ?? plan;
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

/**
 * A create request that references an existing on-chain plan (planPda) claims
 * consent the subscriptions program already enforces. As with updates, the
 * stored record may only describe state the chain confirms (SOLA9-634).
 */
async function assertAttachedPlanMatchesChain(
  c: AppContext,
  planPda: Address,
  requested: {
    destinationAddress: string | null | undefined;
    status: string;
  }
): Promise<void> {
  const onChainPlan = await fetchLiveSubscriptionPlan(c.env, planPda);

  if (requested.destinationAddress) {
    if (!onChainPlan?.data.destinations.includes(requested.destinationAddress as Address)) {
      throw badRequest(
        "Subscription plan destination must first be confirmed on the on-chain plan"
      );
    }
  }

  if (requested.status === "active") {
    if (!onChainPlan || onChainPlan.status !== PlanStatus.Active) {
      throw badRequest(
        "Subscription plan cannot be created as active before its on-chain plan is confirmed active"
      );
    }
  }

  if (requested.status === "archived") {
    if (onChainPlan && onChainPlan.status !== PlanStatus.Sunset) {
      throw badRequest(
        "Subscription plan cannot be created as archived while its on-chain plan is still active"
      );
    }
  }
}

export const createSubscriptionPlan = async (
  c: ValidatedBodyContext<typeof createSubscriptionPlanSchema>
) => {
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  const scope = await resolveScope(c);
  const ownerWallet = resolveWallet(scope.wallets, body.ownerWalletId);
  assertApiKeyWalletAccess(scope.auth, ownerWallet.walletId, ["payments:write"]);

  const puller = await resolvePullerWalletAddress(c, body.pullerWalletId);
  const programPlanId = body.programPlanId ?? generateProgramPlanId();
  if (body.planPda) {
    // Every flow derives the plan PDA from the owner and program plan ID, so
    // an attached planPda must match that derivation (SOLA9-634).
    const [derivedPlanPda] = await findPlanPda({
      owner: assertValidAddress(ownerWallet.publicKey, "ownerAddress"),
      planId: parseU64String(programPlanId, "programPlanId"),
    });
    if (body.planPda !== derivedPlanPda) {
      throw badRequest("Subscription plan PDA does not match the owner and program plan ID");
    }
    await assertAttachedPlanMatchesChain(c, assertValidAddress(body.planPda, "planPda"), {
      destinationAddress: body.destinationAddress ?? null,
      status: body.status,
    });
  }
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
    token: normalizePaymentToken(body.token, c.env),
    amount: body.amount,
    periodHours: body.periodHours,
    programPlanId,
    planPda: body.planPda ?? null,
    destinationAddress: body.destinationAddress ?? null,
    pullerWalletId: puller.pullerWalletId ?? null,
    pullerAddress: puller.pullerAddress ?? null,
    metadataUri: body.metadataUri ?? null,
    status: body.status,
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

export const prepareCreateSubscriptionPlan = async (
  c: ValidatedBodyContext<typeof prepareSubscriptionPlanCreateSchema>
) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = subscriptionPlanIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = c.req.valid("json");

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
    throw badRequest("Cannot prepare an archived subscription plan");
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

  // The create instruction can only run once: once the on-chain plan exists,
  // re-preparing creation or rewriting the record it anchors would let SDP
  // report consent the chain never approved (SOLA9-634).
  if (await fetchLiveSubscriptionPlan(c.env, planPda)) {
    throw new AppError("CONFLICT", "Subscription plan already exists on-chain");
  }

  const destinations = (
    body.destinations ?? (plan.destination_address ? [plan.destination_address] : [])
  ).map((value) => assertValidAddress(value, "destinations entry"));
  if (destinations.length === 0) {
    throw new AppError(
      "BAD_REQUEST",
      "At least one destination address is required to create an on-chain subscription plan"
    );
  }

  const pullers = (
    body.pullers ?? (plan.puller_address ? [plan.puller_address] : [plan.owner_address])
  ).map((value) => assertValidAddress(value, "pullers entry"));
  const { amountBaseUnits, mint, tokenProgram } = await resolvePlanRuntime(c.env, plan);
  const endTs = body.endTs ? parseU64String(body.endTs, "endTs") : 0n;
  const metadataUri = body.metadataUri ?? plan.metadata_uri ?? "";

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
  const updatedPlan = await persistPreparedCreate(c, plan, planPda, destinations[0]);
  const preparedTransaction = await buildPreparedSubscriptionTransaction(
    c.env,
    await getSponsoredFeePayer(c),
    [instruction],
    [owner]
  );
  const response: PreparePaymentSubscriptionPlanResponse = {
    subscriptionPlan: mapPlan(updatedPlan),
    planPda,
    preparedTransaction,
  };

  return success(c, response);
};

/**
 * Resolves the plan PDA a patch is bound to, or null when the record is a
 * true draft: no on-chain plan exists at the PDA derived from its owner and
 * program plan ID. A record that maps to a live on-chain plan (e.g. one
 * created with an existing programPlanId) is already bound to that plan's
 * consent (SOLA9-634).
 */
async function resolveBoundPlanPda(
  c: AppContext,
  existingPlan: PaymentSubscriptionPlanRow
): Promise<Address | null> {
  if (existingPlan.plan_pda) {
    return assertValidAddress(existingPlan.plan_pda, "planPda");
  }

  const { planPda: derivedPlanPda } = await derivePlanAddresses(existingPlan);
  const derivedOnChainPlan = await fetchLiveSubscriptionPlan(c.env, derivedPlanPda);
  return derivedOnChainPlan ? derivedPlanPda : null;
}

/**
 * A live plan (one prepared for on-chain creation) is bound to the consent the
 * subscriptions program enforces on-chain. The program's UpdatePlan has no
 * destination field and rejects term mismatches, so SDP may only persist an
 * edit after the chain confirms it; destination changes require a replacement
 * plan (SOLA9-634).
 */
async function assertLivePlanPatchMatchesChain(
  c: AppContext,
  existingPlan: PaymentSubscriptionPlanRow,
  requested: {
    planPda: string | null | undefined;
    destinationAddress: string | null | undefined;
    pullerAddress: string | null | undefined;
    metadataUri: string | null | undefined;
    status: string | undefined;
  }
): Promise<void> {
  const boundPlanPda = await resolveBoundPlanPda(c, existingPlan);
  if (!boundPlanPda) {
    // Draft plan: no on-chain consent exists yet, so every field stays editable.
    return;
  }

  if (requested.planPda !== undefined && requested.planPda !== boundPlanPda) {
    throw badRequest("Subscription plan PDA is derived on-chain and cannot be reassigned");
  }

  if (
    requested.destinationAddress !== undefined &&
    requested.destinationAddress !== existingPlan.destination_address
  ) {
    throw badRequest(
      "Subscription plan destination is fixed by the on-chain plan; create a replacement plan to collect at a new destination"
    );
  }

  const statusChanged = requested.status !== undefined && requested.status !== existingPlan.status;
  const pullerChanged =
    requested.pullerAddress !== undefined &&
    requested.pullerAddress !== existingPlan.puller_address;
  const metadataChanged =
    requested.metadataUri !== undefined && requested.metadataUri !== existingPlan.metadata_uri;
  if (!statusChanged && !pullerChanged && !metadataChanged) {
    return;
  }

  const onChainPlan = await fetchLiveSubscriptionPlan(c.env, boundPlanPda);

  if (statusChanged && requested.status === "active") {
    if (!onChainPlan || onChainPlan.status !== PlanStatus.Active) {
      throw badRequest(
        "Subscription plan cannot be activated before its on-chain plan is confirmed active"
      );
    }
  }

  if (statusChanged && requested.status === "archived") {
    if (onChainPlan && onChainPlan.status !== PlanStatus.Sunset) {
      throw badRequest(
        "Subscription plan cannot be archived while its on-chain plan is still active"
      );
    }
  }

  if (pullerChanged) {
    // Collection executes as the configured puller, falling back to the owner.
    const callerAfterUpdate = requested.pullerAddress ?? existingPlan.owner_address;
    if (!onChainPlan?.data.pullers.includes(callerAfterUpdate as Address)) {
      throw badRequest("Subscription plan puller must first be confirmed on the on-chain plan");
    }
  }

  if (metadataChanged) {
    const requestedMetadataUri = subscriptionProgramMetadataUri(requested.metadataUri ?? null);
    if (!onChainPlan || onChainPlan.data.metadataUri !== requestedMetadataUri) {
      throw badRequest("Subscription plan metadata must first be confirmed on the on-chain plan");
    }
  }
}

export const updateSubscriptionPlan = async (
  c: ValidatedBodyContext<typeof updateSubscriptionPlanSchema>
) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = subscriptionPlanIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = c.req.valid("json");

  const repo = getPaymentSubscriptionsRepository(c);
  const existingPlan = await repo.getPlanById({
    planId: params.data.planId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!existingPlan) {
    throw new AppError("NOT_FOUND", "Subscription plan not found");
  }

  const scope = await resolveScope(c);
  const ownerWallet = resolveWallet(scope.wallets, existingPlan.owner_wallet_id);
  assertApiKeyWalletAccess(scope.auth, ownerWallet.walletId, ["payments:write"]);

  const puller = await resolvePullerWalletAddress(c, body.pullerWalletId);
  await assertLivePlanPatchMatchesChain(c, existingPlan, {
    planPda: body.planPda,
    destinationAddress: body.destinationAddress,
    pullerAddress: puller.pullerAddress,
    metadataUri: body.metadataUri,
    status: body.status,
  });
  const updated = await repo.updatePlan({
    planId: params.data.planId,
    organizationId: auth.organizationId,
    projectId,
    planPda: body.planPda,
    destinationAddress: body.destinationAddress,
    pullerWalletId: puller.pullerWalletId,
    pullerAddress: puller.pullerAddress,
    metadataUri: body.metadataUri,
    status: body.status,
    updatedAt: new Date().toISOString(),
  });

  if (!updated) {
    throw new AppError("NOT_FOUND", "Subscription plan not found");
  }

  const response: PaymentSubscriptionPlanResponse = { subscriptionPlan: mapPlan(updated) };
  return success(c, response);
};
