import { generateProgramPlanId } from "@sdp/payments/recurring-payment-lifecycle";
import { assertValidAddress } from "@sdp/solana/address";
import type {
  ListPaymentSubscriptionPlansResponse,
  PaymentSubscriptionPlan,
  PaymentSubscriptionPlanResponse,
  PreparePaymentSubscriptionPlanResponse,
} from "@sdp/types/payments";
import { type Address, createNoopSigner } from "@solana/kit";
import { getCreatePlanOverlayInstructionAsync } from "@solana/subscriptions";
import { z } from "zod";
import type { PaymentSubscriptionPlanRow } from "@/db/repositories/payment-subscriptions.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import { AppError, badRequest, badRequestParams, badRequestQuery } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { getAuthorized } from "@/middleware/authorize";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { type AppContext, getPaymentSubscriptionsRepository } from "@/routes/payments/context";
import { normalizePaymentToken, parseU64String } from "@/services/payment-operation.service";
import {
  buildPreparedSubscriptionTransaction,
  derivePlanAddresses,
  resolvePlanRuntime,
} from "@/services/payments/recurring-payments/shared";
import {
  resolveRequestSponsorshipScope,
  resolveSponsoredFeePayer,
} from "@/services/sponsorship.service";
import {
  type createSubscriptionPlanSchema,
  listSubscriptionPlansQuerySchema,
  type prepareSubscriptionPlanCreateSchema,
  subscriptionPlanIdParamsSchema,
  type updateSubscriptionPlanSchema,
} from "./schemas";
import {
  hasSubscriptionPlanPuller,
  resolveSubscriptionPlanRole,
  resolveSubscriptionPlanWalletSelector,
} from "./wallets";

function mapPlan(row: PaymentSubscriptionPlanRow): PaymentSubscriptionPlan {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    ownerCustodyWalletId: row.owner_custody_wallet_id,
    ownerAddress: row.owner_address,
    token: row.token,
    amount: row.amount,
    periodHours: row.period_hours,
    programPlanId: row.program_plan_id,
    planPda: row.plan_pda,
    destinationAddress: row.destination_address,
    pullerCustodyWalletId: row.puller_custody_wallet_id,
    pullerAddress: row.puller_address,
    metadataUri: row.metadata_uri,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

async function resolvePullerWalletAddress(
  c: AppContext,
  pullerCustodyWalletId: string | null | undefined
): Promise<{
  pullerWalletId: string | null | undefined;
  pullerCustodyWalletId: string | null | undefined;
  pullerAddress: string | null | undefined;
}> {
  if (pullerCustodyWalletId === undefined) {
    return {
      pullerWalletId: undefined,
      pullerCustodyWalletId: undefined,
      pullerAddress: undefined,
    };
  }
  if (pullerCustodyWalletId === null) {
    return { pullerWalletId: null, pullerCustodyWalletId: null, pullerAddress: null };
  }

  const wallet = await resolveSubscriptionPlanWalletSelector(c, pullerCustodyWalletId);
  return {
    pullerWalletId: wallet.walletId,
    pullerCustodyWalletId: wallet.id,
    pullerAddress: wallet.publicKey,
  };
}

export const createSubscriptionPlan = async (
  c: ValidatedBodyContext<typeof createSubscriptionPlanSchema>
) => {
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  const auth = getAuth(c);
  const ownerWallet = await resolveSubscriptionPlanWalletSelector(c, body.ownerCustodyWalletId);

  const puller = await resolvePullerWalletAddress(c, body.pullerCustodyWalletId);
  const now = new Date().toISOString();
  const id = `psp_${crypto.randomUUID()}`;
  const createdBy = await resolveCreatorUserId(c);
  const repo = getPaymentSubscriptionsRepository(c);

  const plan = await repo.createPlan({
    id,
    organizationId: auth.organizationId,
    projectId,
    ownerWalletId: ownerWallet.walletId,
    ownerCustodyWalletId: ownerWallet.id,
    ownerAddress: ownerWallet.publicKey,
    token: normalizePaymentToken(body.token),
    amount: body.amount,
    periodHours: body.periodHours,
    programPlanId: body.programPlanId ?? generateProgramPlanId(),
    planPda: body.planPda ?? null,
    destinationAddress: body.destinationAddress ?? null,
    pullerWalletId: puller.pullerWalletId ?? null,
    pullerCustodyWalletId: puller.pullerCustodyWalletId ?? null,
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

  const ownerWallet = await resolveSubscriptionPlanRole(c, plan, "owner");

  const { owner, planId, planPda } = await derivePlanAddresses(plan);

  const destinations = (
    body.destinations ?? (plan.destination_address ? [plan.destination_address] : [])
  ).map((value) => assertValidAddress(value, "destinations entry"));
  if (destinations.length === 0) {
    throw new AppError(
      "BAD_REQUEST",
      "At least one destination address is required to create an on-chain subscription plan"
    );
  }

  let defaultPuller = ownerWallet;
  if (body.pullers === undefined && hasSubscriptionPlanPuller(plan)) {
    defaultPuller = await resolveSubscriptionPlanRole(c, plan, "puller");
  }
  const pullers = (body.pullers ?? [defaultPuller.publicKey]).map((value) =>
    assertValidAddress(value, "pullers entry")
  );
  const { amountBaseUnits, mint, tokenProgram } = await resolvePlanRuntime(plan);
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
  const updatedPlan = await persistPlanPda(c, plan, planPda);
  const preparedTransaction = await buildPreparedSubscriptionTransaction(
    await resolveSponsoredFeePayer(c.env, resolveRequestSponsorshipScope(c)),
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
  // Loaded in the project, its wallets' access checked, by the route's authorize step.
  const existingPlan = getAuthorized<PaymentSubscriptionPlanRow>(c);

  await resolveSubscriptionPlanRole(c, existingPlan, "owner");

  const puller = await resolvePullerWalletAddress(c, body.pullerCustodyWalletId);
  const updated = await repo.updatePlan({
    planId: params.data.planId,
    organizationId: auth.organizationId,
    projectId,
    planPda: body.planPda,
    destinationAddress: body.destinationAddress,
    pullerWalletId: puller.pullerWalletId,
    pullerCustodyWalletId: puller.pullerCustodyWalletId,
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
