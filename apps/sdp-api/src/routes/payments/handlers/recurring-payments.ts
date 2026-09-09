import type {
  ListPaymentRecurringPaymentsResponse,
  PaymentRecurringPayment,
  PaymentRecurringPaymentCollectionResponse,
  PaymentRecurringPaymentResponse,
  PaymentSubscriptionCollectionAttempt,
} from "@sdp/types";
import { z } from "zod";
import type { PaymentSubscriptionCollectionAttemptRow } from "@/db/repositories";
import type { PaymentRecurringPaymentRow } from "@/db/repositories/payment-recurring-payments.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import { AppError, badRequestParams, badRequestQuery } from "@/lib/errors";
import { created, success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getAllowedApiKeyWalletAuthorizationForPermissions } from "@/services/api-key-scope.service";
import {
  activateRecurringPayment as activateRecurringPaymentRecord,
  cancelRecurringPayment as cancelRecurringPaymentRecord,
  collectRecurringPayment as collectRecurringPaymentRecord,
  createRecurringPayment as createRecurringPaymentRecord,
  resumeRecurringPayment as resumeRecurringPaymentRecord,
  updateRecurringPayment as updateRecurringPaymentRecord,
} from "@/services/payments/recurring-payments";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";
import { type AppContext, getPaymentRecurringPaymentsRepository } from "../context";
import { mapTransferRow } from "../mappers";
import {
  type activateRecurringPaymentSchema,
  type collectRecurringPaymentSchema,
  type createRecurringPaymentSchema,
  listRecurringPaymentsQuerySchema,
  recurringPaymentIdParamsSchema,
  type updateRecurringPaymentSchema,
} from "../schemas";
import {
  assertFreshPaymentWalletAccess,
  assertPaymentWalletExactAccess,
  assertPaymentWalletReadAccess,
  type ResolvedScope,
  resolveScope,
  resolveWalletByCustodyWalletId,
} from "../wallets";

function mapRecurringPayment(row: PaymentRecurringPaymentRow): PaymentRecurringPayment {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    sourceCustodyWalletId: row.source_custody_wallet_id,
    sourceProviderWalletId: row.source_wallet_id,
    sourceAddress: row.source_address,
    counterpartyId: row.counterparty_id,
    counterpartyAccountId: row.counterparty_account_id,
    destinationAddress: row.destination_address,
    destinationTokenAccount: row.destination_token_account,
    token: row.token,
    amount: row.amount,
    periodHours: row.period_hours,
    firstCollectionAt: row.first_collection_at,
    nextCollectionDueAt: row.next_collection_due_at,
    planId: row.plan_id,
    subscriptionId: row.subscription_id,
    planPda: row.plan_pda,
    planCreatedAt: row.plan_created_at,
    planCreationSignature: row.plan_creation_signature,
    subscriptionPda: row.subscription_pda,
    subscriptionAuthorityAddress: row.subscription_authority_address,
    authorizationSignature: row.authorization_signature,
    status: row.status,
    metadataUri: row.metadata_uri,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function resolvePinnedRecurringSourceWallet(
  scope: ResolvedScope,
  recurringPayment: PaymentRecurringPaymentRow
) {
  if (!recurringPayment.source_custody_wallet_id) {
    throw new AppError("CONFLICT", "Recurring payment source wallet is unresolved");
  }
  return resolveWalletByCustodyWalletId(scope.wallets, recurringPayment.source_custody_wallet_id);
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

export const createRecurringPayment = async (
  c: ValidatedBodyContext<typeof createRecurringPaymentSchema>
) => {
  const body = c.req.valid("json");

  const projectId = requireProjectId(c);
  assertPaymentWalletExactAccess(c, body.sourceCustodyWalletId, ["payments:write"]);
  const scope = await resolveScope(c);
  const sourceWallet = resolveWalletByCustodyWalletId(scope.wallets, body.sourceCustodyWalletId);
  await assertFreshPaymentWalletAccess(c, sourceWallet, ["payments:write"]);

  const recurringPayment = await createRecurringPaymentRecord({
    env: c.env,
    organizationId: scope.auth.organizationId,
    projectId,
    sourceWallet,
    counterpartyId: body.counterpartyId,
    counterpartyAccountId: body.counterpartyAccountId,
    token: body.token,
    amount: body.amount,
    periodHours: body.periodHours,
    firstCollectionAt: body.firstCollectionAt ?? null,
    metadataUri: body.metadataUri ?? null,
    createdBy: await resolveCreatorUserId(c),
    apiKeyId: scope.auth.apiKeyId,
    actor: walletOperationActorFromAuth(scope.auth),
  });

  const response: PaymentRecurringPaymentResponse = {
    recurringPayment: mapRecurringPayment(recurringPayment),
  };
  return created(c, response);
};

export const updateRecurringPayment = async (
  c: ValidatedBodyContext<typeof updateRecurringPaymentSchema>
) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = recurringPaymentIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = c.req.valid("json");

  const walletAuthorization = getAllowedApiKeyWalletAuthorizationForPermissions(auth, [
    "payments:write",
  ]);
  const recurringPayment = await getPaymentRecurringPaymentsRepository(c).getRecurringPaymentById({
    recurringPaymentId: params.data.id,
    organizationId: auth.organizationId,
    projectId,
    walletAuthorization: walletAuthorization ?? undefined,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }

  const scope = await resolveScope(c, recurringPayment.source_custody_wallet_id ?? undefined);
  const sourceWallet = resolvePinnedRecurringSourceWallet(scope, recurringPayment);
  assertPaymentWalletExactAccess(c, sourceWallet.id, ["payments:write"]);
  await assertFreshPaymentWalletAccess(c, sourceWallet, ["payments:write"]);
  const nextSourceWallet =
    body.sourceCustodyWalletId && body.sourceCustodyWalletId !== sourceWallet.id
      ? resolveWalletByCustodyWalletId(scope.wallets, body.sourceCustodyWalletId)
      : undefined;
  if (nextSourceWallet) {
    assertPaymentWalletExactAccess(c, nextSourceWallet.id, ["payments:write"]);
    await assertFreshPaymentWalletAccess(c, nextSourceWallet, ["payments:write"]);
  }

  const updated = await updateRecurringPaymentRecord({
    env: c.env,
    organizationId: auth.organizationId,
    projectId,
    sourceWallet,
    nextSourceWallet,
    recurringPayment,
    request: body,
    createdBy: await resolveCreatorUserId(c),
    apiKeyId: scope.auth.apiKeyId,
    actor: walletOperationActorFromAuth(scope.auth),
  });
  const response: PaymentRecurringPaymentResponse = {
    recurringPayment: mapRecurringPayment(updated),
  };

  return success(c, response);
};

export const activateRecurringPayment = async (
  c: ValidatedBodyContext<typeof activateRecurringPaymentSchema>
) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = recurringPaymentIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const walletAuthorization = getAllowedApiKeyWalletAuthorizationForPermissions(auth, [
    "payments:write",
  ]);
  const recurringPayment = await getPaymentRecurringPaymentsRepository(c).getRecurringPaymentById({
    recurringPaymentId: params.data.id,
    organizationId: auth.organizationId,
    projectId,
    walletAuthorization: walletAuthorization ?? undefined,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }

  const scope = await resolveScope(c, recurringPayment.source_custody_wallet_id ?? undefined);
  const sourceWallet = resolvePinnedRecurringSourceWallet(scope, recurringPayment);
  assertPaymentWalletExactAccess(c, sourceWallet.id, ["payments:write"]);
  await assertFreshPaymentWalletAccess(c, sourceWallet, ["payments:write"]);

  const activated = await activateRecurringPaymentRecord({
    env: c.env,
    organizationId: auth.organizationId,
    projectId,
    sourceWallet,
    recurringPayment,
    createdBy: await resolveCreatorUserId(c),
  });
  const response: PaymentRecurringPaymentResponse = {
    recurringPayment: mapRecurringPayment(activated),
  };

  return success(c, response);
};

async function mutateRecurringPaymentLifecycle(c: AppContext, operation: "cancel" | "resume") {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = recurringPaymentIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const walletAuthorization = getAllowedApiKeyWalletAuthorizationForPermissions(auth, [
    "payments:write",
  ]);
  const recurringPayment = await getPaymentRecurringPaymentsRepository(c).getRecurringPaymentById({
    recurringPaymentId: params.data.id,
    organizationId: auth.organizationId,
    projectId,
    walletAuthorization: walletAuthorization ?? undefined,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }

  const scope = await resolveScope(c, recurringPayment.source_custody_wallet_id ?? undefined);
  const sourceWallet = resolvePinnedRecurringSourceWallet(scope, recurringPayment);
  assertPaymentWalletExactAccess(c, sourceWallet.id, ["payments:write"]);
  await assertFreshPaymentWalletAccess(c, sourceWallet, ["payments:write"]);

  const updated =
    operation === "cancel"
      ? await cancelRecurringPaymentRecord({
          env: c.env,
          organizationId: auth.organizationId,
          projectId,
          sourceWallet,
          recurringPayment,
        })
      : await resumeRecurringPaymentRecord({
          env: c.env,
          organizationId: auth.organizationId,
          projectId,
          sourceWallet,
          recurringPayment,
        });
  const response: PaymentRecurringPaymentResponse = {
    recurringPayment: mapRecurringPayment(updated),
  };

  return success(c, response);
}

export const cancelRecurringPayment = async (c: AppContext) =>
  mutateRecurringPaymentLifecycle(c, "cancel");

export const resumeRecurringPayment = async (c: AppContext) =>
  mutateRecurringPaymentLifecycle(c, "resume");

export const collectRecurringPayment = async (
  c: ValidatedBodyContext<typeof collectRecurringPaymentSchema>
) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = recurringPaymentIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const walletAuthorization = getAllowedApiKeyWalletAuthorizationForPermissions(auth, [
    "payments:write",
  ]);
  const recurringPayment = await getPaymentRecurringPaymentsRepository(c).getRecurringPaymentById({
    recurringPaymentId: params.data.id,
    organizationId: auth.organizationId,
    projectId,
    walletAuthorization: walletAuthorization ?? undefined,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }

  const scope = await resolveScope(c, recurringPayment.source_custody_wallet_id ?? undefined);
  const sourceWallet = resolvePinnedRecurringSourceWallet(scope, recurringPayment);
  assertPaymentWalletExactAccess(c, sourceWallet.id, ["payments:write"]);
  await assertFreshPaymentWalletAccess(c, sourceWallet, ["payments:write"]);

  const collected = await collectRecurringPaymentRecord({
    env: c.env,
    organizationId: auth.organizationId,
    projectId,
    sourceWallet,
    recurringPayment,
    initiatedByKeyId: auth.authType === "api_key" ? auth.id : null,
    collectionSource: "manual",
  });
  const response: PaymentRecurringPaymentCollectionResponse = {
    recurringPayment: mapRecurringPayment(collected.recurringPayment),
    collectionAttempt: mapCollectionAttempt(collected.collectionAttempt),
    transfer: mapTransferRow(collected.transfer),
  };

  return success(c, response);
};

export const listRecurringPayments = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const parsed = listRecurringPaymentsQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  const { page, pageSize, counterpartyId, status } = parsed.data;
  const walletAuthorization = getAllowedApiKeyWalletAuthorizationForPermissions(auth, [
    "payments:read",
  ]);

  if (
    walletAuthorization &&
    walletAuthorization.custodyWalletIds.length === 0 &&
    walletAuthorization.providerWalletIds.length === 0
  ) {
    const response: ListPaymentRecurringPaymentsResponse = {
      recurringPayments: [],
      total: 0,
      page,
      pageSize,
    };
    return success(c, response);
  }

  const { rows, total } = await getPaymentRecurringPaymentsRepository(c).listRecurringPayments({
    organizationId: auth.organizationId,
    projectId,
    counterpartyId,
    walletAuthorization: walletAuthorization ?? undefined,
    status,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const response: ListPaymentRecurringPaymentsResponse = {
    recurringPayments: rows.map(mapRecurringPayment),
    total,
    page,
    pageSize,
  };

  return success(c, response);
};

export const getRecurringPayment = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = recurringPaymentIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const walletAuthorization = getAllowedApiKeyWalletAuthorizationForPermissions(auth, [
    "payments:read",
  ]);
  const recurringPayment = await getPaymentRecurringPaymentsRepository(c).getRecurringPaymentById({
    recurringPaymentId: params.data.id,
    organizationId: auth.organizationId,
    projectId,
    walletAuthorization: walletAuthorization ?? undefined,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }
  assertPaymentWalletReadAccess(c, {
    custodyWalletId: recurringPayment.source_custody_wallet_id,
    providerWalletId: recurringPayment.source_wallet_id,
  });

  const response: PaymentRecurringPaymentResponse = {
    recurringPayment: mapRecurringPayment(recurringPayment),
  };
  return success(c, response);
};
