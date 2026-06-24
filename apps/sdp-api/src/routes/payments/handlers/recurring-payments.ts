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
import { AppError, badRequest, badRequestParams, badRequestQuery } from "@/lib/errors";
import { created, success } from "@/lib/response";
import {
  assertApiKeyWalletAccess,
  getAllowedApiKeyWalletIdsForPermissions,
} from "@/services/api-key-scope.service";
import {
  activateRecurringPayment as activateRecurringPaymentRecord,
  cancelRecurringPayment as cancelRecurringPaymentRecord,
  collectRecurringPayment as collectRecurringPaymentRecord,
  createRecurringPayment as createRecurringPaymentRecord,
  resumeRecurringPayment as resumeRecurringPaymentRecord,
} from "@/services/payments/recurring-payments";
import { type AppContext, getPaymentRecurringPaymentsRepository } from "../context";
import { mapTransferRow } from "../mappers";
import {
  activateRecurringPaymentSchema,
  cancelRecurringPaymentSchema,
  collectRecurringPaymentSchema,
  createRecurringPaymentSchema,
  listRecurringPaymentsQuerySchema,
  recurringPaymentIdParamsSchema,
  resumeRecurringPaymentSchema,
} from "../schemas";
import { resolveScope, resolveWallet } from "../wallets";

function mapRecurringPayment(row: PaymentRecurringPaymentRow): PaymentRecurringPayment {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    sourceWalletId: row.source_wallet_id,
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

export const createRecurringPayment = async (c: AppContext) => {
  const body = await c.req.json();
  const parsed = createRecurringPaymentSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const projectId = requireProjectId(c);
  const scope = await resolveScope(c);
  const sourceWallet = resolveWallet(scope.wallets, parsed.data.sourceWalletId);
  assertApiKeyWalletAccess(scope.auth, sourceWallet.walletId, ["payments:write"]);

  const recurringPayment = await createRecurringPaymentRecord({
    env: c.env,
    organizationId: scope.auth.organizationId,
    projectId,
    sourceWallet,
    counterpartyId: parsed.data.counterpartyId,
    counterpartyAccountId: parsed.data.counterpartyAccountId,
    token: parsed.data.token,
    amount: parsed.data.amount,
    periodHours: parsed.data.periodHours,
    firstCollectionAt: parsed.data.firstCollectionAt ?? null,
    metadataUri: parsed.data.metadataUri ?? null,
    createdBy: await resolveCreatorUserId(c),
  });

  const response: PaymentRecurringPaymentResponse = {
    recurringPayment: mapRecurringPayment(recurringPayment),
  };
  return created(c, response);
};

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

export const activateRecurringPayment = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = recurringPaymentIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await readOptionalJsonBody(c);
  const parsed = activateRecurringPaymentSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const allowedWalletIds = getAllowedApiKeyWalletIdsForPermissions(auth, ["payments:write"]);
  const recurringPayment = await getPaymentRecurringPaymentsRepository(c).getRecurringPaymentById({
    recurringPaymentId: params.data.id,
    organizationId: auth.organizationId,
    projectId,
    sourceWalletIds: allowedWalletIds ?? undefined,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }

  const scope = await resolveScope(c);
  const sourceWallet = resolveWallet(scope.wallets, recurringPayment.source_wallet_id);
  assertApiKeyWalletAccess(scope.auth, sourceWallet.walletId, ["payments:write"]);

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

  const body = await readOptionalJsonBody(c);
  const parsed =
    operation === "cancel"
      ? cancelRecurringPaymentSchema.safeParse(body)
      : resumeRecurringPaymentSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const allowedWalletIds = getAllowedApiKeyWalletIdsForPermissions(auth, ["payments:write"]);
  const recurringPayment = await getPaymentRecurringPaymentsRepository(c).getRecurringPaymentById({
    recurringPaymentId: params.data.id,
    organizationId: auth.organizationId,
    projectId,
    sourceWalletIds: allowedWalletIds ?? undefined,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }

  const scope = await resolveScope(c);
  const sourceWallet = resolveWallet(scope.wallets, recurringPayment.source_wallet_id);
  assertApiKeyWalletAccess(scope.auth, sourceWallet.walletId, ["payments:write"]);

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

export const collectRecurringPayment = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = recurringPaymentIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await readOptionalJsonBody(c);
  const parsed = collectRecurringPaymentSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const allowedWalletIds = getAllowedApiKeyWalletIdsForPermissions(auth, ["payments:write"]);
  const recurringPayment = await getPaymentRecurringPaymentsRepository(c).getRecurringPaymentById({
    recurringPaymentId: params.data.id,
    organizationId: auth.organizationId,
    projectId,
    sourceWalletIds: allowedWalletIds ?? undefined,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }

  const scope = await resolveScope(c);
  const sourceWallet = resolveWallet(scope.wallets, recurringPayment.source_wallet_id);
  assertApiKeyWalletAccess(scope.auth, sourceWallet.walletId, ["payments:write"]);

  const collected = await collectRecurringPaymentRecord({
    env: c.env,
    organizationId: auth.organizationId,
    projectId,
    sourceWallet,
    recurringPayment,
    initiatedByKeyId: auth.authType === "api_key" ? auth.id : null,
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
  const allowedWalletIds = getAllowedApiKeyWalletIdsForPermissions(auth, ["payments:read"]);

  if (allowedWalletIds?.length === 0) {
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
    sourceWalletIds: allowedWalletIds ?? undefined,
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

  const allowedWalletIds = getAllowedApiKeyWalletIdsForPermissions(auth, ["payments:read"]);
  const recurringPayment = await getPaymentRecurringPaymentsRepository(c).getRecurringPaymentById({
    recurringPaymentId: params.data.id,
    organizationId: auth.organizationId,
    projectId,
    sourceWalletIds: allowedWalletIds ?? undefined,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }
  assertApiKeyWalletAccess(auth, recurringPayment.source_wallet_id, ["payments:read"]);

  const response: PaymentRecurringPaymentResponse = {
    recurringPayment: mapRecurringPayment(recurringPayment),
  };
  return success(c, response);
};
