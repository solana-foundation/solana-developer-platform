import { createHash } from "node:crypto";
import type {
  ListPaymentRecurringPaymentsResponse,
  PaymentRecurringPayment,
  PaymentRecurringPaymentCollectionResponse,
  PaymentRecurringPaymentResponse,
} from "@sdp/types";
import { z } from "zod";
import type { PaymentRecurringPaymentRow } from "@/db/repositories/payment-recurring-payments.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import { AppError, badRequestParams, badRequestQuery, internalError } from "@/lib/errors";
import { canonicalJson, type JsonValue } from "@/lib/idempotency";
import { assertMoneyStartAdmitted } from "@/lib/money-admission";
import { created, success } from "@/lib/response";
import { getAuthorized } from "@/middleware/authorize";
import { parseIdempotencyKey } from "@/middleware/idempotency-key";
import type { MovementStepInput } from "@/middleware/movement-steps";
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
import {
  findKeyedRecurringPayment,
  type RecurringPaymentIdempotency,
} from "@/services/payments/recurring-payments/create";
import { type AppContext, getPaymentRecurringPaymentsRepository } from "../context";
import { mapCollectionAttemptRow, mapTransferRow } from "../mappers";
import {
  assertFreshPaymentWalletAccess,
  assertPaymentWalletExactAccess,
  assertPaymentWalletReadAccess,
  type ResolvedScope,
  resolveScope,
  resolveWalletByCustodyWalletId,
} from "../wallets";
import type {
  AuthorizedRecurringPayment,
  AuthorizedRecurringPaymentCreate,
  AuthorizedRecurringPaymentUpdate,
} from "./access";
import {
  type activateRecurringPaymentSchema,
  type collectRecurringPaymentSchema,
  type createRecurringPaymentSchema,
  listRecurringPaymentsQuerySchema,
  recurringPaymentIdParamsSchema,
  type updateRecurringPaymentSchema,
} from "./schemas";

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

/**
 * The create request's Idempotency-Key and the fingerprint of the schedule it
 * creates, recorded on the row (migration 0129). The route requires the key.
 */
function recurringPaymentIdempotency(
  c: ValidatedBodyContext<typeof createRecurringPaymentSchema>,
  body: z.output<typeof createRecurringPaymentSchema>,
  sourceCustodyWalletId: string
): RecurringPaymentIdempotency {
  const key = parseIdempotencyKey(c);
  if (key === undefined) {
    throw internalError("Recurring payment create reached the handler without an Idempotency-Key");
  }
  return { key, fingerprint: recurringPaymentFingerprint(body, sourceCustodyWalletId) };
}

function recurringPaymentFingerprint(
  body: z.output<typeof createRecurringPaymentSchema>,
  sourceCustodyWalletId: string
): string {
  // SAFETY: a validated JSON body plus a string is a JSON value.
  const value = JSON.parse(JSON.stringify({ ...body, sourceCustodyWalletId })) as JsonValue;
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Answers a create request whose Idempotency-Key already made a schedule, from
 * its row (HOO-1918): past the shared record's 24 hours, or after a 5xx re-run.
 * The same key with a different request is refused (422).
 */
export async function findRecurringPaymentCreateReplay(
  c: AppContext,
  input: MovementStepInput<AuthorizedRecurringPaymentCreate>,
  idempotencyKey: string
): Promise<Response | null> {
  // SAFETY: mounted after validateBody(createRecurringPaymentSchema).
  const body = input.body as z.output<typeof createRecurringPaymentSchema>;
  const existing = await findKeyedRecurringPayment(
    c.env,
    { organizationId: getAuth(c).organizationId, projectId: requireProjectId(c) },
    {
      key: idempotencyKey,
      fingerprint: recurringPaymentFingerprint(body, input.authorized.sourceWallet.id),
    }
  );
  if (!existing) return null;
  const response: PaymentRecurringPaymentResponse = {
    recurringPayment: mapRecurringPayment(existing),
  };
  return created(c, response);
}

export const createRecurringPayment = async (
  c: ValidatedBodyContext<typeof createRecurringPaymentSchema>
) => {
  const body = c.req.valid("json");
  const projectId = requireProjectId(c);
  const { scope, sourceWallet } = getAuthorized<AuthorizedRecurringPaymentCreate>(c);

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
    firstCollectionAt: body.firstCollectionAt === undefined ? null : body.firstCollectionAt,
    metadataUri: body.metadataUri === undefined ? null : body.metadataUri,
    createdBy: await resolveCreatorUserId(c),
    idempotency: recurringPaymentIdempotency(c, body, sourceWallet.id),
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

  const body = c.req.valid("json");
  const { recurringPayment, sourceWallet, nextSourceWallet } =
    getAuthorized<AuthorizedRecurringPaymentUpdate>(c);

  const updated = await updateRecurringPaymentRecord({
    env: c.env,
    organizationId: auth.organizationId,
    projectId,
    sourceWallet,
    nextSourceWallet,
    recurringPayment,
    request: body,
    createdBy: await resolveCreatorUserId(c),
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

  const { recurringPayment, sourceWallet } = getAuthorized<AuthorizedRecurringPayment>(c);

  const activated = await activateRecurringPaymentRecord({
    env: c.env,
    organizationId: auth.organizationId,
    projectId,
    sourceWallet,
    recurringPayment,
    createdBy: await resolveCreatorUserId(c),
    admitStart: () =>
      assertMoneyStartAdmitted(
        c.env,
        { organizationId: auth.organizationId, projectId },
        { surface: "http", operation: "recurring_payment.activate", subjectId: recurringPayment.id }
      ),
  });
  const response: PaymentRecurringPaymentResponse = {
    recurringPayment: mapRecurringPayment(activated),
  };

  return success(c, response);
};

async function mutateRecurringPaymentLifecycle(c: AppContext, operation: "cancel" | "resume") {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const { recurringPayment, sourceWallet } = getAuthorized<AuthorizedRecurringPayment>(c);

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
          admitStart: () =>
            assertMoneyStartAdmitted(
              c.env,
              { organizationId: auth.organizationId, projectId },
              {
                surface: "http",
                operation: "recurring_payment.resume",
                subjectId: recurringPayment.id,
              }
            ),
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

  const { recurringPayment, sourceWallet } = getAuthorized<AuthorizedRecurringPayment>(c);

  const collected = await collectRecurringPaymentRecord({
    env: c.env,
    organizationId: auth.organizationId,
    projectId,
    sourceWallet,
    recurringPayment,
    initiatedByKeyId: auth.authType === "api_key" ? auth.id : null,
    collectionSource: "manual",
    admitStart: () =>
      assertMoneyStartAdmitted(
        c.env,
        { organizationId: auth.organizationId, projectId },
        { surface: "http", operation: "recurring_payment.collect", subjectId: recurringPayment.id }
      ),
  });
  const response: PaymentRecurringPaymentCollectionResponse = {
    recurringPayment: mapRecurringPayment(collected.recurringPayment),
    collectionAttempt: mapCollectionAttemptRow(collected.collectionAttempt),
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
    walletAuthorization,
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
    walletAuthorization,
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
