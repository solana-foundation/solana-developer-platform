import {
  decideRecurringPaymentUpdateTransition,
  RECURRING_PAYMENT_OPERATION_STALE_AFTER_MS,
} from "@sdp/payments/recurring-payment-lifecycle";
import type {
  ListPaymentRecurringPaymentsResponse,
  PaymentRecurringPayment,
  PaymentRecurringPaymentCollectionResponse,
  PaymentRecurringPaymentResponse,
} from "@sdp/types";
import { isInFlightRecurringPaymentAttemptStatus } from "@sdp/types";
import { z } from "zod";
import type { PaymentRecurringPaymentRow } from "@/db/repositories/payment-recurring-payments.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import {
  AppError,
  badRequestParams,
  badRequestQuery,
  internalError,
  walletNotFound,
} from "@/lib/errors";
import { assertMoneyStartAdmitted } from "@/lib/money-admission";
import { created, success } from "@/lib/response";
import { getAuthorized } from "@/middleware/authorize";
import {
  getIdempotencyClaim,
  getIdempotencyFingerprint,
  getIdempotencyRecordKey,
  markIdempotencyRecordMismatch,
} from "@/middleware/idempotency";
import type { MovementStepInput, RecordAnswer } from "@/middleware/movement-steps";
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
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import {
  type AppContext,
  getPaymentRecurringPaymentsRepository,
  getPaymentSubscriptionsRepository,
  getPaymentsRepository,
} from "../context";
import { mapCollectionAttemptRow, mapTransferRow } from "../mappers";
import { assertPaymentWalletReadAccess } from "../wallets";
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
 * The Idempotency-Key and fingerprint the key step claimed for this request,
 * recorded on the domain row (migrations 0134, 0135) so a retry past the key's
 * 24 hours is matched by the same request identity. Every recurring mutation
 * requires the key, so a handler reached without a claim is a wiring bug.
 */
function requiredIdempotency(c: AppContext): RecurringPaymentIdempotency {
  const claim = getIdempotencyClaim(c);
  const recordKey = getIdempotencyRecordKey(c);
  if (claim === undefined || recordKey === undefined) {
    throw internalError("Recurring payment request reached the handler without an Idempotency-Key");
  }
  // The credential-bound record key (ADR 0009), never the raw client key.
  return { key: recordKey, fingerprint: claim.fingerprint };
}

/**
 * Answers a create request whose Idempotency-Key already made a schedule, from
 * its row (HOO-1918): past the shared record's 24 hours, or after a 5xx re-run.
 * The same key with a different request is refused (422).
 */
export async function findRecurringPaymentCreateReplay(
  c: AppContext,
  _input: MovementStepInput<AuthorizedRecurringPaymentCreate>,
  recordKey: string
): Promise<RecordAnswer | null> {
  const existing = await findKeyedRecurringPayment(c.env, tenant(c), recordKey);
  if (!existing) return null;
  const response: PaymentRecurringPaymentResponse = {
    recurringPayment: mapRecurringPayment(existing.recurringPayment),
  };
  return { fingerprint: existing.fingerprint, respond: () => created(c, response) };
}

/** The schedule's pinned source wallet; an unresolved pin is refused for new work (state). */
function pinnedSourceWallet(authorized: AuthorizedRecurringPayment): CustodyWallet {
  if (authorized.sourceWallet === null) {
    throw new AppError("CONFLICT", "Recurring payment source wallet is unresolved");
  }
  return authorized.sourceWallet;
}

/**
 * Answers a lifecycle action from the attempt its Idempotency-Key claimed
 * (HOO-1918): a takeover after a crash, or a re-run after a 5xx, finds the
 * schedule mid-transition or already moved on, which the handler would refuse
 * with a 409 or 400 the idempotency step never stores. A `processing` or
 * `confirmed` attempt answers with the schedule as it stands now (clients poll
 * GET for the outcome; the cron finishes a half-done row); a `failed` attempt
 * or none runs the handler. The same key on another schedule is refused (422).
 * No RPC, no signing: it reads rows only.
 */
function answerFromAttempt(
  c: AppContext,
  recurringPayment: PaymentRecurringPaymentRow,
  attempt: { recurring_payment_id: string; idempotency_fingerprint?: string | null } | null
): RecordAnswer | null {
  if (attempt === null) return null;
  // Activation, lifecycle and collection attempts record no fingerprint: the
  // schedule they name is the request (the path's id, an empty body).
  if (attempt.recurring_payment_id !== recurringPayment.id) {
    // Another request's row: refused unstored, so that request's own retry
    // is still answered from it.
    markIdempotencyRecordMismatch(c);
    throw new AppError("IDEMPOTENCY_KEY_REUSED");
  }
  const response: PaymentRecurringPaymentResponse = {
    recurringPayment: mapRecurringPayment(recurringPayment),
  };
  return {
    fingerprint: attempt.idempotency_fingerprint ?? null,
    respond: () => success(c, response),
  };
}

function tenant(c: AppContext): { organizationId: string; projectId: string } {
  return { organizationId: getAuth(c).organizationId, projectId: requireProjectId(c) };
}

/** Activate, answered from its activation attempt. */
export async function findRecurringPaymentActivateReplay(
  c: AppContext,
  input: MovementStepInput<AuthorizedRecurringPayment>,
  idempotencyKey: string
): Promise<RecordAnswer | null> {
  const attempt = await getPaymentRecurringPaymentsRepository(
    c
  ).findActivationAttemptByIdempotencyKey({ ...tenant(c), idempotencyKey });
  return answerFromAttempt(c, input.authorized.recurringPayment, attempt);
}

function findLifecycleReplay(operation: "cancel" | "resume") {
  return async (
    c: AppContext,
    input: MovementStepInput<AuthorizedRecurringPayment>,
    idempotencyKey: string
  ): Promise<RecordAnswer | null> => {
    const attempt = await getPaymentRecurringPaymentsRepository(
      c
    ).findLifecycleAttemptByIdempotencyKey({ ...tenant(c), operation, idempotencyKey });
    return answerFromAttempt(c, input.authorized.recurringPayment, attempt);
  };
}

/** Cancel, answered from its cancel attempt (a pending schedule's cancel writes one too). */
export const findRecurringPaymentCancelReplay = findLifecycleReplay("cancel");

/** Resume, answered from its resume attempt, before money admission runs. */
export const findRecurringPaymentResumeReplay = findLifecycleReplay("resume");

/**
 * PATCH, answered from its update attempt once that attempt has settled; the
 * same key with other terms is a 422. The cron never recovers an `updating`
 * schedule, so an in-flight attempt of this same request is never an answer:
 * stored, it would hold the key on `updating` for 24 hours. While the schedule
 * is not yet stale (the original may still be running, or another key may be
 * resuming it) the retry is a 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with Retry-After,
 * unstored; once it is stale (it crashed after its claim) the handler runs and
 * resumes the attempt under the same key, as another key with the same terms
 * would.
 */
export async function findRecurringPaymentUpdateReplay(
  c: AppContext,
  input: MovementStepInput<AuthorizedRecurringPaymentUpdate>,
  idempotencyKey: string
): Promise<RecordAnswer | null> {
  const attempt = await getPaymentRecurringPaymentsRepository(c).findUpdateAttemptByIdempotencyKey({
    ...tenant(c),
    idempotencyKey,
  });
  const { recurringPayment } = input.authorized;
  if (
    attempt !== null &&
    attempt.recurring_payment_id === recurringPayment.id &&
    attempt.idempotency_fingerprint === getIdempotencyFingerprint(c) &&
    isInFlightRecurringPaymentAttemptStatus(attempt.status)
  ) {
    const nowIso = new Date().toISOString();
    const transition = decideRecurringPaymentUpdateTransition({
      status: recurringPayment.status,
      updatedAt: recurringPayment.updated_at,
      nowIso,
    });
    if (transition === "recoverable") {
      return null;
    }
    if (transition === "processing") {
      const staleInMs =
        new Date(recurringPayment.updated_at).getTime() +
        RECURRING_PAYMENT_OPERATION_STALE_AFTER_MS -
        new Date(nowIso).getTime();
      c.header("Retry-After", String(Math.max(1, Math.ceil(staleInMs / 1000))));
      throw new AppError("IDEMPOTENCY_KEY_IN_FLIGHT");
    }
  }
  // The update attempt records the key layer's fingerprint; the step compares it.
  return answerFromAttempt(c, recurringPayment, attempt);
}

/**
 * Collect, answered from the collection attempt its key claimed and the
 * transfer written with it: after the due date moved on, a retry returns the
 * period it collected instead of a 400, and never pulls a second period.
 */
export async function findRecurringPaymentCollectReplay(
  c: AppContext,
  input: MovementStepInput<AuthorizedRecurringPayment>,
  idempotencyKey: string
): Promise<RecordAnswer | null> {
  const attempt = await getPaymentSubscriptionsRepository(c).findCollectionAttemptByIdempotencyKey({
    ...tenant(c),
    idempotencyKey,
  });
  if (attempt === null) return null;
  const { recurringPayment } = input.authorized;
  if (attempt.metadata.recurringPaymentId !== recurringPayment.id) {
    // Another request's row: refused unstored, so that request's own retry
    // is still answered from it.
    markIdempotencyRecordMismatch(c);
    throw new AppError("IDEMPOTENCY_KEY_REUSED");
  }
  const transfer =
    attempt.transfer_id === null
      ? null
      : await getPaymentsRepository(c).getTransferById({
          ...tenant(c),
          transferId: attempt.transfer_id,
        });
  if (transfer === null) {
    throw internalError("Recurring payment collection attempt has no transfer");
  }
  const response: PaymentRecurringPaymentCollectionResponse = {
    recurringPayment: mapRecurringPayment(recurringPayment),
    collectionAttempt: mapCollectionAttemptRow(attempt),
    transfer: mapTransferRow(transfer),
  };
  // A collection attempt records no fingerprint: the schedule it names, checked above, is the request.
  return { fingerprint: null, respond: () => success(c, response) };
}

export const createRecurringPayment = async (
  c: ValidatedBodyContext<typeof createRecurringPaymentSchema>
) => {
  const body = c.req.valid("json");
  const projectId = requireProjectId(c);
  const { scope, sourceWallet } = getAuthorized<AuthorizedRecurringPaymentCreate>(c);
  // Authorize resolves the named wallet whatever its status, so a replay is
  // answered after it is deactivated; a new schedule needs an active one.
  if (sourceWallet.status !== "active") {
    throw walletNotFound();
  }

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
    idempotency: requiredIdempotency(c),
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
  const authorized = getAuthorized<AuthorizedRecurringPaymentUpdate>(c);
  const { recurringPayment, nextSourceWallet } = authorized;
  const sourceWallet = pinnedSourceWallet(authorized);
  // Authorize resolves the named wallet whatever its status; moving a
  // schedule onto it needs an active one.
  if (nextSourceWallet && nextSourceWallet.status !== "active") {
    throw walletNotFound();
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
    idempotency: requiredIdempotency(c),
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

  const authorized = getAuthorized<AuthorizedRecurringPayment>(c);
  const { recurringPayment } = authorized;
  const sourceWallet = pinnedSourceWallet(authorized);

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
        { surface: "http", movement: "recurring.activate", subjectId: recurringPayment.id }
      ),
    idempotencyKey: requiredIdempotency(c).key,
  });
  const response: PaymentRecurringPaymentResponse = {
    recurringPayment: mapRecurringPayment(activated),
  };

  return success(c, response);
};

async function mutateRecurringPaymentLifecycle(c: AppContext, operation: "cancel" | "resume") {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const authorized = getAuthorized<AuthorizedRecurringPayment>(c);
  const { recurringPayment } = authorized;
  const sourceWallet = pinnedSourceWallet(authorized);

  const updated =
    operation === "cancel"
      ? await cancelRecurringPaymentRecord({
          env: c.env,
          organizationId: auth.organizationId,
          projectId,
          sourceWallet,
          recurringPayment,
          idempotencyKey: requiredIdempotency(c).key,
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
                movement: "recurring.resume",
                subjectId: recurringPayment.id,
              }
            ),
          idempotencyKey: requiredIdempotency(c).key,
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

  const authorized = getAuthorized<AuthorizedRecurringPayment>(c);
  const { recurringPayment } = authorized;
  const sourceWallet = pinnedSourceWallet(authorized);

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
        { surface: "http", movement: "recurring.collect", subjectId: recurringPayment.id }
      ),
    idempotencyKey: requiredIdempotency(c).key,
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
