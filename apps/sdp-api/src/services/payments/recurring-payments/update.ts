import {
  decideRecurringPaymentUpdateTransition,
  generateProgramPlanId,
  getRecurringPaymentOperationStaleBefore,
  resolveRecurringPaymentCollectionSchedule,
} from "@sdp/payments/recurring-payment-lifecycle";
import { createClusterRpc } from "@sdp/rpc/factory";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import {
  assertNever,
  COLLECTION_ATTEMPT_STATUSES_BLOCKING_NEW_CYCLE,
  doesRecurringPaymentStatusRequireReactivation,
  IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  isActivatingRecurringPaymentStatus,
  isCanceledRecurringPaymentStatus,
  isPendingActivationRecurringPaymentStatus,
  isUpdatingRecurringPaymentStatus,
  type PaymentRecurringPaymentUpdateAttemptMode,
  recurringPaymentInFlightLifecycleOperation,
  type UpdatePaymentRecurringPaymentRequest,
} from "@sdp/types/payments";
import {
  type Address,
  createNoopSigner,
  removeNullCharacters,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token-2022";
import { z } from "zod";
import { type DatabaseExecutor, getDb } from "@/db/client";
import type {
  PaymentRecurringPaymentRow,
  PaymentRecurringPaymentsRepository,
  PaymentRecurringPaymentUpdateAttemptRow,
  RecurringPaymentActivator,
  StoredRecurringPaymentActivator,
} from "@/db/repositories/payment-recurring-payments.repository";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories/payment-recurring-payments.repository.postgres";
import type {
  PaymentSubscriptionPlanRow,
  PaymentSubscriptionRow,
  PaymentSubscriptionsRepository,
} from "@/db/repositories/payment-subscriptions.repository";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories/payment-subscriptions.repository.postgres";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
} from "@/db/repositories/repository-factory";
import {
  AppError,
  badRequest,
  conflict,
  internalError,
  notFound,
  transactionFailed,
} from "@/lib/errors";
import { normalizeDecimalString } from "@/lib/idempotency";
import { currentMandateActivator } from "@/lib/money-principal";
import { createTenantScope } from "@/lib/tenant-scope";
import {
  resolveMintTokenProgram,
  resolveSourceTokenAccountOrAta,
} from "@/routes/payments/token-accounts";
import { getLogger } from "@/runtime/logger";
import { createSigningService } from "@/services/domain/signing.service";
import { parseU64String } from "@/services/payment-operation.service";
import { resolveSolanaCounterpartyAccount } from "@/services/payments/counterparty-account-resolution";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import {
  createSponsorshipFeePayment,
  resolveProjectSponsorshipScope,
} from "@/services/sponsorship.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { recoverOrBlockLifecycleCollection } from "./collection";
import {
  assertRecurringPaymentSourceWallet,
  assertRecurringPaymentTokenMint,
  confirmSubscriptionSignature,
  createSubscriptionStepStore,
  isSubscriptionDelegationCanceled,
  lockLiveActivatingKey,
  parseNullableStoredSignature,
  ResumedStepUnsettledError,
  readRecurringPaymentStep,
  readRecurringPaymentStepIfResumed,
  recurringPaymentErrorMessage,
  requireUpdatedAttempt,
  requireUpdatedPlan,
  requireUpdatedSubscription,
  type SubscriptionStep,
  savedStepSend,
  sendSubscriptionInstructions,
  subscriptionProgramMetadataUri,
} from "./shared";

/** An update request's Idempotency-Key and the fingerprint of its validated body. */
export interface RecurringPaymentUpdateIdempotency {
  key: string;
  fingerprint: string;
}

const recurringPaymentUpdateSnapshotSchema = z.object({
  sourceCustodyWalletId: z.string().nullable(),
  counterpartyId: z.string(),
  counterpartyAccountId: z.string(),
  token: z.string(),
  amount: z.string(),
  periodHours: z.number(),
  firstCollectionAt: z.string().nullable(),
  nextCollectionDueAt: z.string().nullable(),
  metadataUri: z.string().nullable(),
});

type RecurringPaymentUpdateSnapshot = z.infer<typeof recurringPaymentUpdateSnapshotSchema>;

/**
 * The values an update attempt saved (`before_values`, `after_values`): any
 * subset of the snapshot's fields, and nothing else.
 */
const savedUpdateValuesSchema = recurringPaymentUpdateSnapshotSchema.partial().strict();
type SavedUpdateValues = z.infer<typeof savedUpdateValuesSchema>;

const RECURRING_PAYMENT_UPDATE_FIELDS = [
  "sourceCustodyWalletId",
  "counterpartyId",
  "counterpartyAccountId",
  "token",
  "amount",
  "periodHours",
  "firstCollectionAt",
  "nextCollectionDueAt",
  "metadataUri",
] as const satisfies readonly (keyof RecurringPaymentUpdateSnapshot)[];
type RecurringPaymentUpdateField = (typeof RECURRING_PAYMENT_UPDATE_FIELDS)[number];

type ResolvedRecurringPaymentUpdate = {
  sourceWallet: CustodyWallet;
  counterpartyId: string;
  counterpartyAccountId: string;
  destinationAddress: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt: string | null;
  nextCollectionDueAt: string | null;
  metadataUri: string | null;
  changedFields: Array<keyof RecurringPaymentUpdateSnapshot>;
  beforeValues: SavedUpdateValues;
  afterValues: SavedUpdateValues;
};

const REPLACEMENT_UPDATE_FIELDS = new Set<keyof RecurringPaymentUpdateSnapshot>([
  "sourceCustodyWalletId",
  "counterpartyId",
  "counterpartyAccountId",
  "token",
  "amount",
  "periodHours",
]);

function parsePlanStatus(status: subscriptionsProgram.PlanStatus): subscriptionsProgram.PlanStatus {
  switch (status) {
    case subscriptionsProgram.PlanStatus.Sunset:
    case subscriptionsProgram.PlanStatus.Active:
      return status;
    default: {
      const unsupported: never = status;
      throw internalError(`Unsupported subscription plan status: ${unsupported}`);
    }
  }
}

function recurringPaymentSnapshot(row: PaymentRecurringPaymentRow): RecurringPaymentUpdateSnapshot {
  return {
    sourceCustodyWalletId: row.source_custody_wallet_id,
    counterpartyId: row.counterparty_id,
    counterpartyAccountId: row.counterparty_account_id,
    token: row.token,
    amount: row.amount,
    periodHours: row.period_hours,
    firstCollectionAt: row.first_collection_at,
    nextCollectionDueAt: row.next_collection_due_at,
    metadataUri: row.metadata_uri,
  };
}

function buildUpdateDiff(
  before: RecurringPaymentUpdateSnapshot,
  after: RecurringPaymentUpdateSnapshot
): {
  changedFields: RecurringPaymentUpdateField[];
  beforeValues: Partial<RecurringPaymentUpdateSnapshot>;
  afterValues: Partial<RecurringPaymentUpdateSnapshot>;
} {
  // An amount is compared by value, so a respelling ("1" and "1.0") is no change
  // and never broadcasts a replacement.
  const changedFields = RECURRING_PAYMENT_UPDATE_FIELDS.filter((field) =>
    field === "amount"
      ? normalizeDecimalString(before.amount) !== normalizeDecimalString(after.amount)
      : before[field] !== after[field]
  );
  const beforeValues: Partial<RecurringPaymentUpdateSnapshot> = { ...before };
  const afterValues: Partial<RecurringPaymentUpdateSnapshot> = { ...after };

  return { changedFields, beforeValues, afterValues };
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

/** One snapshot field: an amount by value ("30" and "30.0" are one amount), the rest as stored. */
function sameSnapshotValue(
  field: RecurringPaymentUpdateField,
  left: SavedUpdateValues,
  right: SavedUpdateValues
): boolean {
  if (field === "amount" && left.amount !== undefined && right.amount !== undefined) {
    return normalizeDecimalString(left.amount) === normalizeDecimalString(right.amount);
  }
  return left[field] === right[field];
}

/** The same fields, each the same value (`sameSnapshotValue`). */
function sameSavedValues(left: SavedUpdateValues, right: SavedUpdateValues): boolean {
  return RECURRING_PAYMENT_UPDATE_FIELDS.every(
    (field) => field in left === field in right && sameSnapshotValue(field, left, right)
  );
}

function updateAttemptMatchesRequest(
  attempt: PaymentRecurringPaymentUpdateAttemptRow,
  input: {
    changedFields: string[];
    beforeValues: SavedUpdateValues;
    afterValues: SavedUpdateValues;
  }
): boolean {
  // Parsed where they are read: a row whose saved values are not a snapshot
  // subset is not this request's attempt.
  const before = savedUpdateValuesSchema.safeParse(attempt.before_values);
  const after = savedUpdateValuesSchema.safeParse(attempt.after_values);
  return (
    before.success &&
    after.success &&
    sameStringSet(attempt.changed_fields, input.changedFields) &&
    sameSavedValues(before.data, input.beforeValues) &&
    sameSavedValues(after.data, input.afterValues)
  );
}

function requestedActiveUpdateMode(
  changedFields: Array<keyof RecurringPaymentUpdateSnapshot>
): PaymentRecurringPaymentUpdateAttemptMode {
  return changedFields.some((field) => REPLACEMENT_UPDATE_FIELDS.has(field))
    ? "replacement"
    : "metadata_schedule";
}

function assertRecurringPaymentUpdateStatus(row: PaymentRecurringPaymentRow, nowIso: string): void {
  const transition = decideRecurringPaymentUpdateTransition({
    status: row.status,
    updatedAt: row.updated_at,
    nowIso,
  });
  switch (transition) {
    case "claimable":
    case "recoverable":
      return;
    case "processing":
      throw conflict("Recurring payment update is already processing");
    case "already_final":
    case "invalid": {
      if (isActivatingRecurringPaymentStatus(row.status)) {
        throw conflict("Recurring payment activation is already processing");
      }
      const lifecycleOperation = recurringPaymentInFlightLifecycleOperation(row.status);
      if (lifecycleOperation) {
        throw conflict(`Recurring payment ${lifecycleOperation} is already processing`);
      }
      if (
        doesRecurringPaymentStatusRequireReactivation(row.status) ||
        isCanceledRecurringPaymentStatus(row.status)
      ) {
        throw conflict("Recurring payment cannot be updated from this status");
      }
      throw internalError(`Inconsistent update transition ${transition} for ${row.status}`);
    }
    default:
      assertNever(transition);
  }
}

async function resolveRecurringPaymentUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  sourceWallet: CustodyWallet;
  nextSourceWallet?: CustodyWallet;
  request: UpdatePaymentRecurringPaymentRequest;
}): Promise<ResolvedRecurringPaymentUpdate> {
  const finalSourceWallet =
    input.nextSourceWallet === undefined ? input.sourceWallet : input.nextSourceWallet;
  const requestedSourceCustodyWalletId =
    input.request.sourceCustodyWalletId === undefined
      ? input.recurringPayment.source_custody_wallet_id
      : input.request.sourceCustodyWalletId;
  if (finalSourceWallet.id !== requestedSourceCustodyWalletId) {
    throw badRequest("Recurring payment source wallet does not match request");
  }

  const counterpartyId =
    input.request.counterpartyId === undefined
      ? input.recurringPayment.counterparty_id
      : input.request.counterpartyId;
  const counterpartyAccountId =
    input.request.counterpartyAccountId === undefined
      ? input.recurringPayment.counterparty_account_id
      : input.request.counterpartyAccountId;
  const accountChanged =
    counterpartyId !== input.recurringPayment.counterparty_id ||
    counterpartyAccountId !== input.recurringPayment.counterparty_account_id;
  const [token, destination] = await Promise.all([
    input.request.token !== undefined
      ? assertRecurringPaymentTokenMint(
          input.request.token,
          input.organizationId,
          input.projectId,
          input.env
        )
      : input.recurringPayment.token,
    accountChanged
      ? resolveSolanaCounterpartyAccount({
          env: input.env,
          organizationId: input.organizationId,
          projectId: input.projectId,
          counterpartyId,
          counterpartyAccountId,
        })
      : { destinationAddress: input.recurringPayment.destination_address },
  ]);
  const amount =
    input.request.amount === undefined ? input.recurringPayment.amount : input.request.amount;
  const periodHours =
    input.request.periodHours === undefined
      ? input.recurringPayment.period_hours
      : input.request.periodHours;
  const firstCollectionAt =
    input.request.firstCollectionAt !== undefined
      ? input.request.firstCollectionAt
      : input.recurringPayment.first_collection_at;
  const nextCollectionDueAt =
    input.request.nextCollectionDueAt !== undefined
      ? input.request.nextCollectionDueAt
      : input.recurringPayment.next_collection_due_at;
  const metadataUri =
    input.request.metadataUri !== undefined
      ? input.request.metadataUri
      : input.recurringPayment.metadata_uri;

  const before = recurringPaymentSnapshot(input.recurringPayment);
  const after: RecurringPaymentUpdateSnapshot = {
    sourceCustodyWalletId: finalSourceWallet.id,
    counterpartyId,
    counterpartyAccountId,
    token,
    amount,
    periodHours,
    firstCollectionAt,
    nextCollectionDueAt,
    metadataUri,
  };
  const diff = buildUpdateDiff(before, after);

  return {
    sourceWallet: finalSourceWallet,
    counterpartyId,
    counterpartyAccountId,
    destinationAddress: destination.destinationAddress,
    token,
    amount,
    periodHours,
    firstCollectionAt,
    nextCollectionDueAt,
    metadataUri,
    ...diff,
  };
}

async function recordRecurringPaymentUpdateEvent(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  attemptId: string | null;
  changedFields: string[];
  beforeValues: Record<string, unknown>;
  afterValues: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
}): Promise<void> {
  const event = await input.recurringRepo.createUpdateEvent({
    id: `prue_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPaymentId,
    attemptId: input.attemptId,
    changedFields: input.changedFields,
    beforeValues: input.beforeValues,
    afterValues: input.afterValues,
    createdBy: input.createdBy,
    createdAt: input.createdAt,
  });

  if (!event) {
    throw internalError("Failed to journal recurring payment update");
  }
}

/**
 * Records that a keyed PATCH was answered without an attempt of its own: a
 * request that changes nothing, or one that finished a stale attempt another
 * key claimed. The confirmed attempt carries this request's key and
 * fingerprint and changes nothing, so a retry once the key's shared record has
 * expired is answered from it instead of applying its terms again over a newer
 * edit. The fingerprint check is the key step's, as for any update attempt.
 * An unkeyed request, or one whose own attempt carries its key, records nothing.
 */
async function recordAnsweredUpdate(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  createdBy: string | null;
  idempotency: RecurringPaymentUpdateIdempotency | null;
  /** The key on the attempt this request ran; null when it ran none. */
  ranAttemptKey: string | null;
}): Promise<void> {
  if (input.idempotency === null || input.idempotency.key === input.ranAttemptKey) {
    return;
  }
  const answeredAt = new Date().toISOString();
  const attempt = await input.recurringRepo.createUpdateAttempt({
    id: `prpu_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPayment.id,
    mode: "metadata_schedule",
    status: "confirmed",
    stage: "finalize",
    oldPlanId: null,
    oldSubscriptionId: null,
    newPlanId: null,
    newSubscriptionId: null,
    newSourceCustodyWalletId: null,
    planUpdateSignature: null,
    planCreationSignature: null,
    authorizationSetupSignature: null,
    authorizationSignature: null,
    oldCancelSignature: null,
    changedFields: [],
    beforeValues: {},
    afterValues: {},
    error: null,
    createdBy: input.createdBy,
    createdAt: answeredAt,
    updatedAt: answeredAt,
    idempotencyKey: input.idempotency.key,
    idempotencyFingerprint: input.idempotency.fingerprint,
  });
  if (!attempt) {
    throw internalError("Failed to journal recurring payment update");
  }
}

/**
 * Updates a schedule that never went on chain. The row, a confirmed update
 * attempt carrying the request's key and fingerprint, and the update event
 * commit together, so a retry of the same request is answered from the attempt
 * (HOO-1918), as a pending schedule's cancel is.
 */
async function updatePendingRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  resolved: ResolvedRecurringPaymentUpdate;
  createdBy: string | null;
  idempotency: RecurringPaymentUpdateIdempotency | null;
}): Promise<PaymentRecurringPaymentRow> {
  if (input.resolved.changedFields.length === 0) {
    await recordAnsweredUpdate({
      ...input,
      recurringRepo: createPaymentRecurringPaymentsRepository(input.env, createTenantScope(input)),
      ranAttemptKey: null,
    });
    return input.recurringPayment;
  }

  const changedDestinationOrToken =
    input.resolved.destinationAddress !== input.recurringPayment.destination_address ||
    input.resolved.token !== input.recurringPayment.token;
  const updatedAt = new Date().toISOString();
  return getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const updated = await updatePendingRecurringPaymentRow(recurringRepo, {
      ...input,
      changedDestinationOrToken,
      updatedAt,
    });
    const attempt = await recurringRepo.createUpdateAttempt({
      id: `prpu_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      mode: "metadata_schedule",
      status: "confirmed",
      stage: "finalize",
      oldPlanId: null,
      oldSubscriptionId: null,
      newPlanId: null,
      newSubscriptionId: null,
      newSourceCustodyWalletId:
        input.resolved.sourceWallet.id === input.recurringPayment.source_custody_wallet_id
          ? null
          : input.resolved.sourceWallet.id,
      planUpdateSignature: null,
      planCreationSignature: null,
      authorizationSetupSignature: null,
      authorizationSignature: null,
      oldCancelSignature: null,
      changedFields: input.resolved.changedFields.map(String),
      beforeValues: input.resolved.beforeValues,
      afterValues: input.resolved.afterValues,
      error: null,
      createdBy: input.createdBy,
      createdAt: updatedAt,
      updatedAt,
      idempotencyKey: input.idempotency?.key ?? null,
      idempotencyFingerprint: input.idempotency?.fingerprint ?? null,
    });
    if (!attempt) {
      throw internalError("Failed to journal recurring payment update");
    }
    await recordRecurringPaymentUpdateEvent({
      recurringRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      attemptId: attempt.id,
      changedFields: input.resolved.changedFields.map(String),
      beforeValues: input.resolved.beforeValues,
      afterValues: input.resolved.afterValues,
      createdBy: input.createdBy,
      createdAt: updatedAt,
    });
    return updated;
  });
}

async function updatePendingRecurringPaymentRow(
  recurringRepo: PaymentRecurringPaymentsRepository,
  input: {
    organizationId: string;
    projectId: string;
    recurringPayment: PaymentRecurringPaymentRow;
    resolved: ResolvedRecurringPaymentUpdate;
    changedDestinationOrToken: boolean;
    updatedAt: string;
  }
): Promise<PaymentRecurringPaymentRow> {
  const { changedDestinationOrToken, updatedAt } = input;
  const updated = await recurringRepo.updateRecurringPayment({
    recurringPaymentId: input.recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceCustodyWalletId: input.resolved.sourceWallet.id,
    sourceWalletId: input.resolved.sourceWallet.walletId,
    sourceAddress: input.resolved.sourceWallet.publicKey,
    counterpartyId: input.resolved.counterpartyId,
    counterpartyAccountId: input.resolved.counterpartyAccountId,
    destinationAddress: input.resolved.destinationAddress,
    ...(changedDestinationOrToken ? { destinationTokenAccount: null } : {}),
    token: input.resolved.token,
    amount: input.resolved.amount,
    periodHours: input.resolved.periodHours,
    firstCollectionAt: input.resolved.firstCollectionAt,
    metadataUri: input.resolved.metadataUri,
    expectedStatus: "pending_activation",
    expectedUpdatedAt: input.recurringPayment.updated_at,
    updatedAt,
  });

  if (!updated) {
    throw conflict("Recurring payment changed while updating; retry with the latest payment");
  }
  return updated;
}

async function getOrCreateRecurringPaymentUpdateAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  claimed: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  mode: PaymentRecurringPaymentUpdateAttemptMode;
  changedFields: string[];
  beforeValues: Record<string, unknown>;
  afterValues: Record<string, unknown>;
  newSourceCustodyWalletId: string | null;
  createdBy: string | null;
  nowIso: string;
  recoveringStaleUpdate: boolean;
  idempotency: RecurringPaymentUpdateIdempotency | null;
  previousActivator: StoredRecurringPaymentActivator | null;
}): Promise<PaymentRecurringPaymentUpdateAttemptRow> {
  // A stale claim resumes the in-flight attempt under its original key, or
  // records this request's key and fingerprint on it when it has none.
  if (input.recoveringStaleUpdate) {
    const existing = await input.recurringRepo.getLatestUpdateAttempt({
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.claimed.id,
      statuses: IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
    });
    if (existing) {
      if (
        existing.mode !== input.mode ||
        existing.new_source_custody_wallet_id !== input.newSourceCustodyWalletId ||
        !updateAttemptMatchesRequest(existing, {
          changedFields: input.changedFields,
          beforeValues: input.beforeValues,
          afterValues: input.afterValues,
        })
      ) {
        throw conflict("Recurring payment update recovery must retry the same update");
      }
      return requireUpdatedAttempt(
        await input.recurringRepo.updateUpdateAttempt({
          attemptId: existing.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          error: null,
          adoptIdempotencyKey: input.idempotency?.key ?? null,
          adoptIdempotencyFingerprint: input.idempotency?.fingerprint ?? null,
          updatedAt: input.nowIso,
        })
      );
    }
  }

  const attempt = await input.recurringRepo.createUpdateAttempt({
    id: `prpu_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.claimed.id,
    mode: input.mode,
    status: "processing",
    stage: "claim",
    oldPlanId: input.claimed.plan_id,
    oldSubscriptionId: input.claimed.subscription_id,
    newPlanId: null,
    newSubscriptionId: null,
    newSourceCustodyWalletId: input.newSourceCustodyWalletId,
    planUpdateSignature: null,
    planCreationSignature: null,
    authorizationSetupSignature: null,
    authorizationSignature: null,
    oldCancelSignature: null,
    changedFields: input.changedFields,
    beforeValues: input.beforeValues,
    afterValues: input.afterValues,
    error: null,
    createdBy: input.createdBy,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    idempotencyKey: input.idempotency?.key ?? null,
    idempotencyFingerprint: input.idempotency?.fingerprint ?? null,
    previousActivator: input.previousActivator,
  });

  if (!attempt) {
    await input.recurringRepo.updateRecurringPayment({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "active",
      expectedStatus: "updating",
      updatedAt: new Date().toISOString(),
    });
    throw internalError("Failed to journal recurring payment update");
  }

  return attempt;
}

function activeNextCollectionDueAt(input: {
  requested: string | null | undefined;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow | null;
  onChainSubscription?: Awaited<
    ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>
  > | null;
  clampToMinimum: boolean;
}): string | null | undefined {
  if (input.requested === undefined) {
    return undefined;
  }

  const periodHours = input.recurringPayment.period_hours;
  const onChainStartTs =
    input.onChainSubscription?.exists === true
      ? Number(input.onChainSubscription.data.currentPeriodStartTs)
      : NaN;
  const currentPeriodStartAt = Number.isFinite(onChainStartTs)
    ? new Date(onChainStartTs * 1000).toISOString()
    : (input.subscription?.current_period_start_at ??
      input.recurringPayment.next_collection_due_at);
  if (!currentPeriodStartAt) {
    throw conflict("Recurring payment is missing active subscription timing");
  }

  const resolution = resolveRecurringPaymentCollectionSchedule({
    request:
      input.requested === null
        ? { kind: "next_period" }
        : { kind: "requested", dueAt: input.requested, clampToMinimum: input.clampToMinimum },
    periodStartAt: currentPeriodStartAt,
    periodHours,
  });
  if (resolution.kind === "too_early") {
    throw badRequest("nextCollectionDueAt cannot be earlier than the next eligible collection");
  }

  return resolution.nextCollectionDueAt;
}

function replacementNextCollectionDueAt(input: {
  requested: string | null | undefined;
  periodStartAt: string;
  periodHours: number;
  clampToMinimum: boolean;
}): string {
  const resolution = resolveRecurringPaymentCollectionSchedule({
    request:
      input.requested === undefined || input.requested === null
        ? { kind: "next_period" }
        : { kind: "requested", dueAt: input.requested, clampToMinimum: input.clampToMinimum },
    periodStartAt: input.periodStartAt,
    periodHours: input.periodHours,
  });
  if (resolution.kind === "too_early") {
    throw badRequest(
      "nextCollectionDueAt cannot be earlier than the replacement subscription period"
    );
  }

  return resolution.nextCollectionDueAt;
}

async function finalizeMetadataScheduleUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  claimed: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow | null;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  resolved: ResolvedRecurringPaymentUpdate;
  nextCollectionDueAt: string | null | undefined;
  createdBy: string | null;
  idempotency: RecurringPaymentUpdateIdempotency | null;
}): Promise<PaymentRecurringPaymentRow> {
  const finalizedAt = new Date().toISOString();
  return getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);

    if (input.claimed.plan_id && input.resolved.metadataUri !== input.claimed.metadata_uri) {
      requireUpdatedPlan(
        await subscriptionsRepo.updatePlan({
          planId: input.claimed.plan_id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          metadataUri: input.resolved.metadataUri,
          updatedAt: finalizedAt,
        })
      );
    }
    if (input.subscription && input.nextCollectionDueAt !== undefined) {
      requireUpdatedSubscription(
        await subscriptionsRepo.updateSubscription({
          subscriptionId: input.subscription.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          nextCollectionDueAt: input.nextCollectionDueAt,
          expectedStatus: "active",
          updatedAt: finalizedAt,
        })
      );
    }

    const updated = await recurringRepo.updateRecurringPayment({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "active",
      metadataUri: input.resolved.metadataUri,
      ...(input.nextCollectionDueAt !== undefined
        ? { nextCollectionDueAt: input.nextCollectionDueAt }
        : {}),
      expectedStatus: "updating",
      updatedAt: finalizedAt,
    });
    if (!updated) {
      throw internalError("Failed to finalize recurring payment update");
    }

    requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: input.attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "confirmed",
        stage: "finalize",
        error: null,
        updatedAt: finalizedAt,
      })
    );
    const auditAfterValues =
      input.nextCollectionDueAt !== undefined &&
      input.resolved.changedFields.includes("nextCollectionDueAt")
        ? { ...input.resolved.afterValues, nextCollectionDueAt: input.nextCollectionDueAt }
        : input.resolved.afterValues;
    await recordRecurringPaymentUpdateEvent({
      recurringRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.claimed.id,
      attemptId: input.attempt.id,
      changedFields: input.resolved.changedFields.map(String),
      beforeValues: input.resolved.beforeValues,
      afterValues: auditAfterValues,
      createdBy: input.createdBy,
      createdAt: finalizedAt,
    });

    // A request that finished a stale attempt another key claimed (the attempt
    // keeps that key) is answered under its own key in the same commit, so the
    // update never lands without the record its retry is answered from.
    await recordAnsweredUpdate({
      recurringRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: updated,
      createdBy: input.createdBy,
      idempotency: input.idempotency,
      ranAttemptKey: input.attempt.idempotency_key,
    });
    return updated;
  });
}

async function runMetadataScheduleUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  claimed: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow | null;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  resolved: ResolvedRecurringPaymentUpdate;
  request: UpdatePaymentRecurringPaymentRequest;
  createdBy: string | null;
  idempotency: RecurringPaymentUpdateIdempotency | null;
}): Promise<PaymentRecurringPaymentRow> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(
    input.env,
    createTenantScope(input)
  );
  const rpc = createClusterRpc();
  let attempt = input.attempt;
  let planUpdateSignature = parseNullableStoredSignature(attempt.plan_update_signature);

  let onChainSubscription: Awaited<
    ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>
  > | null = null;
  if (input.request.nextCollectionDueAt !== undefined && input.claimed.subscription_pda) {
    onChainSubscription = await subscriptionsProgram.fetchMaybeSubscriptionDelegation(
      rpc,
      assertValidAddress(input.claimed.subscription_pda, "subscriptionPda"),
      { commitment: "confirmed" }
    );
  }
  const nextDueAt = activeNextCollectionDueAt({
    requested: input.request.nextCollectionDueAt,
    recurringPayment: input.claimed,
    subscription: input.subscription,
    onChainSubscription,
    clampToMinimum: planUpdateSignature !== null,
  });

  if (input.resolved.metadataUri !== input.claimed.metadata_uri) {
    if (!input.claimed.plan_pda) {
      throw conflict("Recurring payment is missing on-chain plan records");
    }

    const planPda = assertValidAddress(input.claimed.plan_pda, "planPda");
    const sourceSigner = await createOrgSignerForCustodyWallet(
      input.env,
      input.organizationId,
      input.projectId,
      input.sourceWallet.id,
      "recurring.update"
    );
    if (sourceSigner.address !== input.sourceWallet.publicKey) {
      throw badRequest("Resolved signing wallet does not match source wallet");
    }

    // An attempt an earlier run left at `update_plan` reached the send (HOO-2044):
    // the plan's metadata settles whether it landed.
    const targetMetadataUri = subscriptionProgramMetadataUri(input.resolved.metadataUri);
    const readPlan = (commitment: "finalized" | "confirmed") =>
      subscriptionsProgram.fetchMaybePlan(rpc, planPda, { commitment });
    const planUpdateStep = {
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      rows: [{ slot: { row: "update_attempt", column: "plan_update_signature" }, id: attempt.id }],
    } as const satisfies SubscriptionStep;
    const step =
      input.attempt.stage === "update_plan"
        ? await readRecurringPaymentStep({
            rpc,
            read: readPlan,
            landed: (onChain) =>
              onChain.exists &&
              // The on-chain field is fixed at 128 bytes, padded with NULs.
              removeNullCharacters(onChain.data.data.metadataUri) === targetMetadataUri,
            savedSend: savedStepSend(planUpdateSignature, attempt.last_valid_block_height),
            step: planUpdateStep,
            failureMessage: "Recurring payment update failed on-chain",
            logContext: {
              recurring_payment_id: input.claimed.id,
              attempt_id: attempt.id,
              step: "update_plan",
            },
          })
        : null;

    if (step?.kind !== "landed") {
      const onChainPlan = step === null ? await readPlan("confirmed") : step.account;
      if (!onChainPlan.exists) {
        throw transactionFailed("Subscription plan was not found on-chain");
      }

      attempt = requireUpdatedAttempt(
        await recurringRepo.updateUpdateAttempt({
          attemptId: attempt.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          stage: "update_plan",
          updatedAt: new Date().toISOString(),
        })
      );
      const instruction = await subscriptionsProgram.getUpdatePlanOverlayInstruction({
        endTs: onChainPlan.data.data.endTs,
        expectedCreatedAt: onChainPlan.data.data.terms.createdAt,
        expectedEndTs: onChainPlan.data.data.endTs,
        expectedMetadataUri: onChainPlan.data.data.metadataUri,
        expectedPullers: onChainPlan.data.data.pullers,
        metadataUri: targetMetadataUri,
        owner: sourceSigner,
        planPda,
        pullers: onChainPlan.data.data.pullers,
        status: parsePlanStatus(onChainPlan.data.status),
      });
      planUpdateSignature = await sendSubscriptionInstructions({
        movement: "recurring.update",
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWallet: input.sourceWallet,
        sourceSigner,
        instructions: [instruction],
        submissionStore: createSubscriptionStepStore({
          ...planUpdateStep,
          save: async (send) => {
            attempt = requireUpdatedAttempt(
              await recurringRepo.updateUpdateAttempt({
                attemptId: attempt.id,
                organizationId: input.organizationId,
                projectId: input.projectId,
                planUpdateSignature: send.signature,
                lastValidBlockHeight: send.lastValidBlockHeight,
                updatedAt: new Date().toISOString(),
              })
            );
          },
        }),
      });
      await confirmSubscriptionSignature(
        planUpdateSignature,
        "Recurring payment update failed on-chain"
      );
    }
  }

  return finalizeMetadataScheduleUpdate({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    claimed: input.claimed,
    subscription: input.subscription,
    attempt,
    resolved: input.resolved,
    nextCollectionDueAt: nextDueAt,
    createdBy: input.createdBy,
    idempotency: input.idempotency,
  });
}

async function prepareSubscriptionAuthorityForUpdate(input: {
  env: Env;
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  organizationId: string;
  projectId: string;
  rpc: SolanaRpc;
  sourceWallet: CustodyWallet;
  sourceSigner: TransactionSigner;
  sourceTokenAccount: { tokenAccount: Address; exists: boolean };
  subscriptionAuthority: Awaited<
    ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionAuthority>
  >;
  subscriptionAuthorityAddress: Address;
  owner: Address;
  mint: Address;
  tokenProgram: Address;
  feePayer: Address;
}) {
  if (input.subscriptionAuthority.exists && input.sourceTokenAccount.exists) {
    return input.subscriptionAuthority;
  }

  const payer = createNoopSigner(input.feePayer);
  const initAuthorityInstruction = input.subscriptionAuthority.exists
    ? null
    : await subscriptionsProgram.getInitSubscriptionAuthorityOverlayInstructionAsync({
        owner: input.sourceSigner,
        payer,
        tokenMint: input.mint,
        tokenProgram: input.tokenProgram,
        userAta: input.sourceTokenAccount.tokenAccount,
      });
  const createSourceAtaInstruction = input.sourceTokenAccount.exists
    ? null
    : getCreateAssociatedTokenIdempotentInstruction({
        payer,
        ata: input.sourceTokenAccount.tokenAccount,
        owner: input.owner,
        mint: input.mint,
        tokenProgram: input.tokenProgram,
      });
  const initSignature = await sendSubscriptionInstructions({
    movement: "recurring.update",
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    sourceSigner: input.sourceSigner,
    instructions: [
      ...(createSourceAtaInstruction ? [createSourceAtaInstruction] : []),
      ...(initAuthorityInstruction ? [initAuthorityInstruction] : []),
    ],
    feePayer: input.feePayer,
    submissionStore: createSubscriptionStepStore({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      save: async (send) => {
        requireUpdatedAttempt(
          await input.recurringRepo.updateUpdateAttempt({
            attemptId: input.attempt.id,
            organizationId: input.organizationId,
            projectId: input.projectId,
            authorizationSetupSignature: send.signature,
            lastValidBlockHeight: send.lastValidBlockHeight,
            updatedAt: new Date().toISOString(),
          })
        );
      },
      rows: [
        {
          slot: { row: "update_attempt", column: "authorization_setup_signature" },
          id: input.attempt.id,
        },
      ],
    }),
  });
  await confirmSubscriptionSignature(initSignature, "Recurring payment update failed on-chain");

  if (!initAuthorityInstruction) {
    return input.subscriptionAuthority;
  }

  const subscriptionAuthority = await subscriptionsProgram.fetchMaybeSubscriptionAuthority(
    input.rpc,
    input.subscriptionAuthorityAddress,
    { commitment: "confirmed" }
  );
  if (!subscriptionAuthority.exists) {
    throw new ResumedStepUnsettledError(
      "Subscription authority is not visible on-chain yet; retry"
    );
  }
  return subscriptionAuthority;
}

async function getOrCreateReplacementPlan(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  resolved: ResolvedRecurringPaymentUpdate;
  createdBy: string | null;
}): Promise<PaymentSubscriptionPlanRow> {
  if (input.attempt.new_plan_id) {
    const existing = await input.subscriptionsRepo.getPlanById({
      planId: input.attempt.new_plan_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (existing) {
      return existing;
    }
  }

  const now = new Date().toISOString();
  const plan = await input.subscriptionsRepo.createPlan({
    id: `psp_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    ownerWalletId: input.sourceWallet.walletId,
    ownerAddress: input.sourceWallet.publicKey,
    token: input.resolved.token,
    amount: input.resolved.amount,
    periodHours: input.resolved.periodHours,
    programPlanId: generateProgramPlanId(),
    planPda: null,
    destinationAddress: input.resolved.destinationAddress,
    pullerWalletId: input.sourceWallet.walletId,
    pullerAddress: input.sourceWallet.publicKey,
    metadataUri: input.resolved.metadataUri,
    status: "draft",
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });

  if (!plan) {
    throw internalError("Failed to create replacement subscription plan");
  }

  return plan;
}

async function getOrCreateReplacementSubscription(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  organizationId: string;
  projectId: string;
  planId: string;
  resolved: ResolvedRecurringPaymentUpdate;
  createdBy: string | null;
}): Promise<PaymentSubscriptionRow> {
  if (input.attempt.new_subscription_id) {
    const existing = await input.subscriptionsRepo.getSubscriptionById({
      subscriptionId: input.attempt.new_subscription_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (existing) {
      return existing;
    }
  }

  const now = new Date().toISOString();
  const subscription = await input.subscriptionsRepo.createSubscription({
    id: `psub_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    planId: input.planId,
    counterpartyId: input.resolved.counterpartyId,
    subscriberAddress: input.resolved.sourceWallet.publicKey,
    subscriberTokenAccount: null,
    subscriptionPda: null,
    subscriptionAuthorityAddress: null,
    authorizationSignature: null,
    status: "pending_authorization",
    currentPeriodStartAt: null,
    nextCollectionDueAt: null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });

  if (!subscription) {
    throw internalError("Failed to create replacement subscription");
  }

  return subscription;
}

async function finalizeReplacementUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  claimed: PaymentRecurringPaymentRow;
  oldSubscription: PaymentSubscriptionRow;
  plan: PaymentSubscriptionPlanRow;
  subscription: PaymentSubscriptionRow;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  resolved: ResolvedRecurringPaymentUpdate;
  planPda: Address;
  planCreatedAt: string;
  /** Each signature is null when an earlier run's send landed before it was saved. */
  planCreationSignature: Signature | null;
  subscriptionPda: Address;
  subscriptionAuthorityAddress: Address;
  authorizationSignature: Signature | null;
  oldCancelSignature: Signature | null;
  currentPeriodStartAt: string;
  nextCollectionDueAt: string;
  createdBy: string | null;
  idempotency: RecurringPaymentUpdateIdempotency | null;
}): Promise<PaymentRecurringPaymentRow> {
  const finalizedAt = new Date().toISOString();
  return getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);

    requireUpdatedSubscription(
      await subscriptionsRepo.updateSubscription({
        subscriptionId: input.oldSubscription.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "canceled",
        cancelAt: finalizedAt,
        canceledAt: finalizedAt,
        updatedAt: finalizedAt,
      })
    );
    if (input.claimed.plan_id) {
      requireUpdatedPlan(
        await subscriptionsRepo.updatePlan({
          planId: input.claimed.plan_id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          status: "archived",
          updatedAt: finalizedAt,
        })
      );
    }
    requireUpdatedPlan(
      await subscriptionsRepo.updatePlan({
        planId: input.plan.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planPda: input.planPda,
        status: "active",
        updatedAt: finalizedAt,
      })
    );
    requireUpdatedSubscription(
      await subscriptionsRepo.updateSubscription({
        subscriptionId: input.subscription.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        subscriptionPda: input.subscriptionPda,
        subscriptionAuthorityAddress: input.subscriptionAuthorityAddress,
        authorizationSignature: input.authorizationSignature,
        status: "active",
        currentPeriodStartAt: input.currentPeriodStartAt,
        nextCollectionDueAt: input.nextCollectionDueAt,
        updatedAt: finalizedAt,
      })
    );

    const updated = await recurringRepo.updateRecurringPayment({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceCustodyWalletId: input.resolved.sourceWallet.id,
      sourceWalletId: input.resolved.sourceWallet.walletId,
      sourceAddress: input.resolved.sourceWallet.publicKey,
      counterpartyId: input.resolved.counterpartyId,
      counterpartyAccountId: input.resolved.counterpartyAccountId,
      destinationAddress: input.resolved.destinationAddress,
      destinationTokenAccount: null,
      token: input.resolved.token,
      amount: input.resolved.amount,
      periodHours: input.resolved.periodHours,
      firstCollectionAt: null,
      nextCollectionDueAt: input.nextCollectionDueAt,
      planId: input.plan.id,
      subscriptionId: input.subscription.id,
      planPda: input.planPda,
      planCreatedAt: input.planCreatedAt,
      planCreationSignature: input.planCreationSignature,
      subscriptionPda: input.subscriptionPda,
      subscriptionAuthorityAddress: input.subscriptionAuthorityAddress,
      authorizationSignature: input.authorizationSignature,
      status: "active",
      metadataUri: input.resolved.metadataUri,
      expectedStatus: "updating",
      updatedAt: finalizedAt,
    });
    if (!updated) {
      throw internalError("Failed to finalize recurring payment update");
    }

    requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: input.attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "confirmed",
        stage: "finalize",
        oldCancelSignature: input.oldCancelSignature,
        error: null,
        updatedAt: finalizedAt,
      })
    );
    const auditChangedFields = input.resolved.changedFields.map(String);
    const auditBeforeValues = { ...input.resolved.beforeValues };
    const auditAfterValues = { ...input.resolved.afterValues };
    if (
      input.claimed.first_collection_at !== null &&
      !auditChangedFields.includes("firstCollectionAt")
    ) {
      auditChangedFields.push("firstCollectionAt");
      auditBeforeValues.firstCollectionAt = input.claimed.first_collection_at;
      auditAfterValues.firstCollectionAt = null;
    }
    if (
      input.claimed.next_collection_due_at !== input.nextCollectionDueAt &&
      !auditChangedFields.includes("nextCollectionDueAt")
    ) {
      auditChangedFields.push("nextCollectionDueAt");
      auditBeforeValues.nextCollectionDueAt = input.claimed.next_collection_due_at;
    }
    if (auditChangedFields.includes("nextCollectionDueAt")) {
      auditAfterValues.nextCollectionDueAt = input.nextCollectionDueAt;
    }
    await recordRecurringPaymentUpdateEvent({
      recurringRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.claimed.id,
      attemptId: input.attempt.id,
      changedFields: auditChangedFields,
      beforeValues: auditBeforeValues,
      afterValues: auditAfterValues,
      createdBy: input.createdBy,
      createdAt: finalizedAt,
    });

    // A request that finished a stale attempt another key claimed (the attempt
    // keeps that key) is answered under its own key in the same commit, so the
    // update never lands without the record its retry is answered from.
    await recordAnsweredUpdate({
      recurringRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: updated,
      createdBy: input.createdBy,
      idempotency: input.idempotency,
      ranAttemptKey: input.attempt.idempotency_key,
    });
    return updated;
  });
}

async function runReplacementUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  oldSourceWallet: CustodyWallet;
  claimed: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow | null;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  resolved: ResolvedRecurringPaymentUpdate;
  request: UpdatePaymentRecurringPaymentRequest;
  createdBy: string | null;
  idempotency: RecurringPaymentUpdateIdempotency | null;
}): Promise<PaymentRecurringPaymentRow> {
  if (
    !input.claimed.plan_pda ||
    !input.claimed.subscription_id ||
    !input.claimed.subscription_pda
  ) {
    throw conflict("Recurring payment is missing on-chain subscription records");
  }
  const oldSubscription =
    input.subscription ??
    (await createPaymentSubscriptionsRepository(
      input.env,
      createTenantScope(input)
    ).getSubscriptionById({
      subscriptionId: input.claimed.subscription_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    }));
  if (!oldSubscription) {
    throw notFound("Subscription");
  }

  const recurringRepo = createPaymentRecurringPaymentsRepository(
    input.env,
    createTenantScope(input)
  );
  const subscriptionsRepo = createPaymentSubscriptionsRepository(
    input.env,
    createTenantScope(input)
  );
  const rpc = createClusterRpc();
  let attempt = input.attempt;
  let planCreationSignature = parseNullableStoredSignature(attempt.plan_creation_signature);
  let authorizationSignature = parseNullableStoredSignature(attempt.authorization_signature);
  let oldCancelSignature = parseNullableStoredSignature(attempt.old_cancel_signature);
  // On an attempt an earlier run started, each step reads the chain before it
  // sends again (HOO-2044): its saved signature or its effect may already be
  // there. A fresh attempt (`claim`) has sent nothing and reads nothing extra.
  const resumedAttempt = attempt.stage !== "claim";
  const replacementPeriodStartAt = attempt.created_at;
  const requestedNextDue = replacementNextCollectionDueAt({
    requested: input.request.nextCollectionDueAt,
    periodStartAt: replacementPeriodStartAt,
    periodHours: input.resolved.periodHours,
    clampToMinimum: Boolean(planCreationSignature || authorizationSignature || oldCancelSignature),
  });

  const sourceSigner = await createOrgSignerForCustodyWallet(
    input.env,
    input.organizationId,
    input.projectId,
    input.resolved.sourceWallet.id,
    "recurring.update"
  );
  if (sourceSigner.address !== input.resolved.sourceWallet.publicKey) {
    throw badRequest("Resolved signing wallet does not match source wallet");
  }
  const owner = assertValidAddress(input.resolved.sourceWallet.publicKey, "sourceAddress");
  const destination = assertValidAddress(input.resolved.destinationAddress, "destinationAddress");
  const mint = assertValidAddress(input.resolved.token, "token");
  const tokenProgram = await resolveMintTokenProgram(rpc, mint);
  const sourceTokenAccount = await resolveSourceTokenAccountOrAta(rpc, owner, mint, tokenProgram);
  const amountBaseUnits = parseDecimalAmount(input.resolved.amount, sourceTokenAccount.decimals);
  if (amountBaseUnits <= 0n) {
    throw badRequest("Subscription amount must be greater than zero");
  }

  let plan = await getOrCreateReplacementPlan({
    subscriptionsRepo,
    attempt,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.resolved.sourceWallet,
    resolved: input.resolved,
    createdBy: input.createdBy,
  });
  if (attempt.new_plan_id !== plan.id) {
    attempt = requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        newPlanId: plan.id,
        updatedAt: new Date().toISOString(),
      })
    );
  }

  const programPlanId = parseU64String(plan.program_plan_id, "programPlanId");
  const [planPda] = await subscriptionsProgram.findPlanPda({ owner, planId: programPlanId });
  plan = requireUpdatedPlan(
    await subscriptionsRepo.updatePlan({
      planId: plan.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planPda,
      updatedAt: new Date().toISOString(),
    })
  );

  const planCreationStep = {
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    rows: [{ slot: { row: "update_attempt", column: "plan_creation_signature" }, id: attempt.id }],
  } as const satisfies SubscriptionStep;
  let onChainPlan = await readRecurringPaymentStepIfResumed(resumedAttempt, {
    logContext: {
      recurring_payment_id: attempt.recurring_payment_id,
      attempt_id: attempt.id,
      step: "create_plan",
    },
    rpc,
    read: (commitment) => subscriptionsProgram.fetchMaybePlan(rpc, planPda, { commitment }),
    landed: (onChain) => onChain.exists,
    savedSend: savedStepSend(planCreationSignature, attempt.last_valid_block_height),
    step: planCreationStep,
    failureMessage: "Recurring payment replacement plan creation failed on-chain",
  });
  if (!onChainPlan) {
    attempt = requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: "create_plan",
        updatedAt: new Date().toISOString(),
      })
    );
    const createPlanInstruction = await subscriptionsProgram.getCreatePlanOverlayInstructionAsync({
      amount: amountBaseUnits,
      destinations: [destination],
      endTs: 0n,
      metadataUri: subscriptionProgramMetadataUri(input.resolved.metadataUri),
      mint,
      owner: sourceSigner,
      periodHours: BigInt(input.resolved.periodHours),
      planId: programPlanId,
      pullers: [owner],
      tokenProgram,
    });
    planCreationSignature = await sendSubscriptionInstructions({
      movement: "recurring.update",
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.resolved.sourceWallet,
      sourceSigner,
      instructions: [createPlanInstruction],
      submissionStore: createSubscriptionStepStore({
        ...planCreationStep,
        save: async (send) => {
          attempt = requireUpdatedAttempt(
            await recurringRepo.updateUpdateAttempt({
              attemptId: attempt.id,
              organizationId: input.organizationId,
              projectId: input.projectId,
              planCreationSignature: send.signature,
              lastValidBlockHeight: send.lastValidBlockHeight,
              updatedAt: new Date().toISOString(),
            })
          );
        },
      }),
    });
    await confirmSubscriptionSignature(
      planCreationSignature,
      "Recurring payment replacement plan creation failed on-chain"
    );
    onChainPlan = await subscriptionsProgram.fetchMaybePlan(rpc, planPda, {
      commitment: "confirmed",
    });
  }
  if (!onChainPlan.exists) {
    throw new ResumedStepUnsettledError("Subscription plan is not visible on-chain yet; retry");
  }
  const planCreatedAt = onChainPlan.data.data.terms.createdAt.toString();

  let subscription = await getOrCreateReplacementSubscription({
    subscriptionsRepo,
    attempt,
    organizationId: input.organizationId,
    projectId: input.projectId,
    planId: plan.id,
    resolved: input.resolved,
    createdBy: input.createdBy,
  });
  if (attempt.new_subscription_id !== subscription.id) {
    attempt = requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        newSubscriptionId: subscription.id,
        updatedAt: new Date().toISOString(),
      })
    );
  }

  const [subscriptionAuthorityAddress] = await subscriptionsProgram.findSubscriptionAuthorityPda({
    tokenMint: mint,
    user: owner,
  });
  const [subscriptionPda] = await subscriptionsProgram.findSubscriptionDelegationPda({
    planPda,
    subscriber: owner,
  });
  subscription = requireUpdatedSubscription(
    await subscriptionsRepo.updateSubscription({
      subscriptionId: subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriberTokenAccount: sourceTokenAccount.tokenAccount,
      subscriptionPda,
      subscriptionAuthorityAddress,
      updatedAt: new Date().toISOString(),
    })
  );

  const authorizationStep = {
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    rows: [{ slot: { row: "update_attempt", column: "authorization_signature" }, id: attempt.id }],
  } as const satisfies SubscriptionStep;
  const subscribedOnChain =
    (await readRecurringPaymentStepIfResumed(resumedAttempt, {
      logContext: {
        recurring_payment_id: attempt.recurring_payment_id,
        attempt_id: attempt.id,
        step: "authorize_subscription",
      },
      rpc,
      read: (commitment) =>
        subscriptionsProgram.fetchMaybeSubscriptionDelegation(rpc, subscriptionPda, { commitment }),
      landed: (onChain) => onChain.exists,
      savedSend: savedStepSend(authorizationSignature, attempt.last_valid_block_height),
      step: authorizationStep,
      failureMessage: "Recurring payment replacement authorization failed on-chain",
    })) !== null;
  if (!subscribedOnChain) {
    attempt = requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: "authorize_subscription",
        updatedAt: new Date().toISOString(),
      })
    );
    let subscriptionAuthority = await subscriptionsProgram.fetchMaybeSubscriptionAuthority(
      rpc,
      subscriptionAuthorityAddress,
      { commitment: "confirmed" }
    );
    const feePayment = createSponsorshipFeePayment(
      input.env,
      await resolveProjectSponsorshipScope(input.env, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        actor: { type: "wallet", id: input.resolved.sourceWallet.walletId },
      }),
      "recurring.update"
    );
    const feePayer = await feePayment.getFeePayer();
    const payer = createNoopSigner(feePayer);
    subscriptionAuthority = await prepareSubscriptionAuthorityForUpdate({
      env: input.env,
      recurringRepo,
      attempt,
      organizationId: input.organizationId,
      projectId: input.projectId,
      rpc,
      sourceWallet: input.resolved.sourceWallet,
      sourceSigner,
      sourceTokenAccount,
      subscriptionAuthority,
      subscriptionAuthorityAddress,
      owner,
      mint,
      tokenProgram,
      feePayer,
    });
    if (!subscriptionAuthority.exists) {
      throw new ResumedStepUnsettledError(
        "Subscription authority is not visible on-chain yet; retry"
      );
    }

    const subscribeInstruction = await subscriptionsProgram.getSubscribeOverlayInstructionAsync({
      expectedAmount: amountBaseUnits,
      expectedCreatedAt: BigInt(planCreatedAt),
      expectedPeriodHours: BigInt(input.resolved.periodHours),
      expectedSubscriptionAuthorityInitId: subscriptionAuthority.data.initId,
      merchant: owner,
      payer,
      planId: programPlanId,
      subscriber: sourceSigner,
      tokenMint: mint,
    });
    authorizationSignature = await sendSubscriptionInstructions({
      movement: "recurring.update",
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.resolved.sourceWallet,
      sourceSigner,
      instructions: [subscribeInstruction],
      feePayer,
      submissionStore: createSubscriptionStepStore({
        ...authorizationStep,
        save: async (send) => {
          attempt = requireUpdatedAttempt(
            await recurringRepo.updateUpdateAttempt({
              attemptId: attempt.id,
              organizationId: input.organizationId,
              projectId: input.projectId,
              authorizationSignature: send.signature,
              lastValidBlockHeight: send.lastValidBlockHeight,
              updatedAt: new Date().toISOString(),
            })
          );
        },
      }),
    });
    await confirmSubscriptionSignature(
      authorizationSignature,
      "Recurring payment replacement authorization failed on-chain"
    );
  }

  const oldPlanPda = assertValidAddress(input.claimed.plan_pda, "planPda");
  const oldSubscriptionPda = assertValidAddress(input.claimed.subscription_pda, "subscriptionPda");
  const oldCancelStep = {
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    rows: [{ slot: { row: "update_attempt", column: "old_cancel_signature" }, id: attempt.id }],
  } as const satisfies SubscriptionStep;
  const oldCanceledOnChain =
    (await readRecurringPaymentStepIfResumed(resumedAttempt, {
      logContext: {
        recurring_payment_id: attempt.recurring_payment_id,
        attempt_id: attempt.id,
        step: "cancel_old_subscription",
      },
      rpc,
      read: (commitment) =>
        subscriptionsProgram.fetchMaybeSubscriptionDelegation(rpc, oldSubscriptionPda, {
          commitment,
        }),
      landed: isSubscriptionDelegationCanceled,
      savedSend: savedStepSend(oldCancelSignature, attempt.last_valid_block_height),
      step: oldCancelStep,
      failureMessage: "Recurring payment old subscription cancellation failed on-chain",
    })) !== null;
  if (!oldCanceledOnChain) {
    attempt = requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: "cancel_old_subscription",
        updatedAt: new Date().toISOString(),
      })
    );
    const oldSourceSigner = await createOrgSignerForCustodyWallet(
      input.env,
      input.organizationId,
      input.projectId,
      input.oldSourceWallet.id,
      "recurring.update_cancel_old"
    );
    if (oldSourceSigner.address !== input.oldSourceWallet.publicKey) {
      throw badRequest("Resolved signing wallet does not match source wallet");
    }
    const cancelInstruction =
      await subscriptionsProgram.getCancelSubscriptionOverlayInstructionAsync({
        planPda: oldPlanPda,
        subscriber: oldSourceSigner,
        subscriptionPda: oldSubscriptionPda,
      });
    oldCancelSignature = await sendSubscriptionInstructions({
      movement: "recurring.update_cancel_old",
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.oldSourceWallet,
      sourceSigner: oldSourceSigner,
      instructions: [cancelInstruction],
      submissionStore: createSubscriptionStepStore({
        ...oldCancelStep,
        save: async (send) => {
          attempt = requireUpdatedAttempt(
            await recurringRepo.updateUpdateAttempt({
              attemptId: attempt.id,
              organizationId: input.organizationId,
              projectId: input.projectId,
              oldCancelSignature: send.signature,
              lastValidBlockHeight: send.lastValidBlockHeight,
              updatedAt: new Date().toISOString(),
            })
          );
        },
      }),
    });
    await confirmSubscriptionSignature(
      oldCancelSignature,
      "Recurring payment old subscription cancellation failed on-chain"
    );
  }

  const finalizedAt = new Date().toISOString();
  const safeNextDue = replacementNextCollectionDueAt({
    requested: requestedNextDue,
    periodStartAt: finalizedAt,
    periodHours: input.resolved.periodHours,
    clampToMinimum: true,
  });

  return finalizeReplacementUpdate({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    claimed: input.claimed,
    oldSubscription,
    plan,
    subscription,
    attempt,
    resolved: input.resolved,
    planPda,
    planCreatedAt,
    planCreationSignature,
    subscriptionPda,
    subscriptionAuthorityAddress,
    authorizationSignature,
    oldCancelSignature,
    currentPeriodStartAt: finalizedAt,
    nextCollectionDueAt: safeNextDue,
    createdBy: input.createdBy,
    idempotency: input.idempotency,
  });
}

async function recordRecurringPaymentUpdateFailure(input: {
  env: Env;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  claimed: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  error: Error;
  resetToActive: boolean;
}): Promise<void> {
  const failedAt = new Date().toISOString();
  await getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: input.attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: input.resetToActive ? "failed" : "processing",
        error: recurringPaymentErrorMessage(input.error),
        updatedAt: failedAt,
      })
    );

    if (input.resetToActive) {
      const updatedRecurringPayment = await recurringRepo.updateRecurringPayment({
        recurringPaymentId: input.claimed.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "active",
        expectedStatus: "updating",
        updatedAt: failedAt,
      });
      if (updatedRecurringPayment === null)
        throw conflict("Recurring payment update changed concurrently");
      // The new terms never took effect, so neither does the hand-over.
      if (input.attempt.previous_activator) {
        await recurringRepo.restoreRecurringPaymentActivator({
          recurringPaymentId: input.claimed.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          activator: input.attempt.previous_activator,
        });
      }
    }
  });
}

async function claimSourceChangingRecurringPaymentUpdate(input: {
  db: DatabaseExecutor;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  sourceWallet: CustodyWallet;
  updatedAt: string;
  staleBefore: string;
  activatedBy: RecurringPaymentActivator | null;
}): Promise<PaymentRecurringPaymentRow | null> {
  const locked = await input.db
    .prepare(
      `SELECT id
           FROM payment_recurring_payments
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
            AND status = ?
            AND updated_at = ?
            AND source_custody_wallet_id = ?
            AND source_wallet_id = ?
            AND source_address = ?
            AND subscription_id IS NOT DISTINCT FROM ?
            AND next_collection_due_at IS NOT DISTINCT FROM ?
          FOR UPDATE`
    )
    .bind(
      input.recurringPayment.id,
      input.organizationId,
      input.projectId,
      input.recurringPayment.status,
      input.recurringPayment.updated_at,
      input.sourceWallet.id,
      input.sourceWallet.walletId,
      input.sourceWallet.publicKey,
      input.recurringPayment.subscription_id,
      input.recurringPayment.next_collection_due_at
    )
    .first<{ id: string }>();
  if (!locked) return null;

  if (input.recurringPayment.subscription_id && input.recurringPayment.next_collection_due_at) {
    const activeAttempt = await createPostgresPaymentSubscriptionsRepository(
      input.db
    ).getCollectionAttemptByDue({
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId: input.recurringPayment.subscription_id,
      dueAt: input.recurringPayment.next_collection_due_at,
      statuses: COLLECTION_ATTEMPT_STATUSES_BLOCKING_NEW_CYCLE,
    });
    if (activeAttempt) return null;
  }

  return createPostgresPaymentRecurringPaymentsRepository(input.db).claimRecurringPaymentUpdate({
    recurringPaymentId: input.recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    updatedAt: input.updatedAt,
    staleBefore: input.staleBefore,
    activatedBy: input.activatedBy,
  });
}

/**
 * Admits an update that will sign, for every wallet it signs with: the source
 * and, when the source changes, the new one, since the caller must be able to
 * sign with the wallet it moves the mandate away from as well. A fresh update
 * is admitted before its claim (`admitStart`). A recovered one passes none: it
 * may only confirm saved work or finish the old plan's cancel (an exit), and
 * any new signature it needs is decided by the signing waist (HOO-2099).
 */
async function admitUpdateExecution(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  walletIds: readonly string[];
  admitStart: ((custodyWalletId: string) => Promise<void>) | null;
}): Promise<void> {
  for (const walletId of input.walletIds) {
    await input.admitStart?.(walletId);
  }
  const signingService = createSigningService(input.env);
  for (const walletId of input.walletIds) {
    await signingService.admitRuntimeExecution(input.organizationId, input.projectId, walletId);
  }
}

/**
 * Claims an active recurring payment for an update and opens (or resumes) its
 * attempt, in one transaction.
 *
 * An update that changes where or how much money moves re-authorizes the
 * mandate, so its caller becomes the one it answers to: revoking that key
 * cancels the mandate, as revoking its activator does (HOO-2099). The claim
 * re-reads that key under a share lock, ordered against revocation as
 * activation's is. A metadata or schedule change leaves the activator alone,
 * and so does a recovered stale update, whose own claim recorded its caller.
 */
async function claimActiveRecurringPaymentUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  sourceWallet: CustodyWallet;
  newSourceCustodyWalletId: string | null;
  mode: PaymentRecurringPaymentUpdateAttemptMode;
  resolved: Pick<
    Awaited<ReturnType<typeof resolveRecurringPaymentUpdate>>,
    "changedFields" | "beforeValues" | "afterValues"
  >;
  createdBy: string | null;
  nowIso: string;
  recoveringStaleUpdate: boolean;
  idempotency: RecurringPaymentUpdateIdempotency | null;
}): Promise<{
  claimed: PaymentRecurringPaymentRow;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
} | null> {
  const updatedAt = new Date().toISOString();
  const staleBefore = getRecurringPaymentOperationStaleBefore(input.nowIso);
  const activatedBy =
    input.mode === "replacement" && !input.recoveringStaleUpdate ? currentMandateActivator() : null;
  return getDb(input.env).transaction(async (tx) => {
    await lockLiveActivatingKey(tx, {
      activator: activatedBy,
      organizationId: input.organizationId,
      projectId: input.projectId,
      movement: "recurring.update",
      recurringPaymentId: input.recurringPayment.id,
      // Moving the mandate signs with the wallet it leaves and the one it joins.
      custodyWalletIds: input.newSourceCustodyWalletId
        ? [input.sourceWallet.id, input.newSourceCustodyWalletId]
        : [input.sourceWallet.id],
    });
    const transactionRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    // Kept on the attempt, so an attempt abandoned before its terms take
    // effect hands the payment back to the activator it had.
    const previousActivator = activatedBy
      ? await transactionRepo.lockRecurringPaymentActivator({
          recurringPaymentId: input.recurringPayment.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
        })
      : null;
    const claimed = input.newSourceCustodyWalletId
      ? await claimSourceChangingRecurringPaymentUpdate({
          db: tx,
          organizationId: input.organizationId,
          projectId: input.projectId,
          recurringPayment: input.recurringPayment,
          sourceWallet: input.sourceWallet,
          updatedAt,
          staleBefore,
          activatedBy,
        })
      : await transactionRepo.claimRecurringPaymentUpdate({
          recurringPaymentId: input.recurringPayment.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          updatedAt,
          staleBefore,
          activatedBy,
        });
    if (!claimed) return null;
    const attempt = await getOrCreateRecurringPaymentUpdateAttempt({
      recurringRepo: transactionRepo,
      claimed,
      organizationId: input.organizationId,
      projectId: input.projectId,
      mode: input.mode,
      changedFields: input.resolved.changedFields.map(String),
      beforeValues: input.resolved.beforeValues,
      afterValues: input.resolved.afterValues,
      newSourceCustodyWalletId: input.newSourceCustodyWalletId,
      createdBy: input.createdBy,
      nowIso: input.nowIso,
      recoveringStaleUpdate: input.recoveringStaleUpdate,
      idempotency: input.idempotency,
      previousActivator,
    });
    return { claimed, attempt };
  });
}

export async function updateRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  nextSourceWallet?: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  request: UpdatePaymentRecurringPaymentRequest;
  createdBy: string | null;
  /** The request's Idempotency-Key and body fingerprint, written on the attempt it claims. */
  idempotency: RecurringPaymentUpdateIdempotency | null;
  /**
   * Money admission (HOO-1955, HOO-2099) for one custody wallet a fresh
   * update will sign with, run before the attempt is claimed and only when it
   * signs: a refusal leaves the recurring payment untouched. A recovered
   * stale update skips it; the signing waist decides any signature it needs.
   */
  admitStart: (custodyWalletId: string) => Promise<void>;
}): Promise<PaymentRecurringPaymentRow> {
  assertRecurringPaymentSourceWallet(input.recurringPayment, input.sourceWallet);

  const nowIso = new Date().toISOString();
  assertRecurringPaymentUpdateStatus(input.recurringPayment, nowIso);

  if (isPendingActivationRecurringPaymentStatus(input.recurringPayment.status)) {
    if (input.request.nextCollectionDueAt !== undefined) {
      throw badRequest("nextCollectionDueAt can only be updated after activation");
    }
    const resolved = await resolveRecurringPaymentUpdate(input);
    return updatePendingRecurringPayment({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: input.recurringPayment,
      resolved,
      createdBy: input.createdBy,
      idempotency: input.idempotency,
    });
  }

  if (input.request.firstCollectionAt !== undefined) {
    throw badRequest("firstCollectionAt can only be updated before activation");
  }

  const recurringRepo = createPaymentRecurringPaymentsRepository(
    input.env,
    createTenantScope(input)
  );
  const subscriptionsRepo = createPaymentSubscriptionsRepository(
    input.env,
    createTenantScope(input)
  );
  const paymentsRepo = createPaymentsRepository(input.env, createTenantScope(input));
  const settled = await recoverOrBlockLifecycleCollection({
    env: input.env,
    recurringRepo,
    subscriptionsRepo,
    paymentsRepo,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: input.recurringPayment,
  });
  assertRecurringPaymentUpdateStatus(settled.recurringPayment, new Date().toISOString());
  assertRecurringPaymentSourceWallet(settled.recurringPayment, input.sourceWallet);

  const resolved = await resolveRecurringPaymentUpdate({
    ...input,
    recurringPayment: settled.recurringPayment,
  });
  const sourceChanged = resolved.changedFields.includes("sourceCustodyWalletId");
  const mode = requestedActiveUpdateMode(resolved.changedFields);
  const requiresRuntimeExecution =
    mode === "replacement" || resolved.metadataUri !== settled.recurringPayment.metadata_uri;
  const recoveringStaleUpdate = isUpdatingRecurringPaymentStatus(settled.recurringPayment.status);
  if (requiresRuntimeExecution) {
    await admitUpdateExecution({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      walletIds: sourceChanged
        ? [input.sourceWallet.id, resolved.sourceWallet.id]
        : [input.sourceWallet.id],
      admitStart: recoveringStaleUpdate ? null : input.admitStart,
    });
  }

  if (resolved.changedFields.length === 0) {
    await recordAnsweredUpdate({
      ...input,
      recurringRepo,
      recurringPayment: settled.recurringPayment,
      ranAttemptKey: null,
    });
    return settled.recurringPayment;
  }

  const claimResult = await claimActiveRecurringPaymentUpdate({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: settled.recurringPayment,
    sourceWallet: input.sourceWallet,
    newSourceCustodyWalletId: sourceChanged ? resolved.sourceWallet.id : null,
    mode,
    resolved,
    createdBy: input.createdBy,
    nowIso,
    recoveringStaleUpdate,
    idempotency: input.idempotency,
  });
  if (!claimResult) {
    throw conflict("Recurring payment update is already processing");
  }
  const { attempt, claimed } = claimResult;

  let updated: PaymentRecurringPaymentRow;
  try {
    if (mode === "metadata_schedule") {
      updated = await runMetadataScheduleUpdate({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWallet: input.sourceWallet,
        claimed,
        subscription: settled.subscription,
        attempt,
        resolved,
        request: input.request,
        createdBy: input.createdBy,
        idempotency: input.idempotency,
      });
    } else {
      updated = await runReplacementUpdate({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        oldSourceWallet: input.sourceWallet,
        claimed,
        subscription: settled.subscription,
        attempt,
        resolved,
        request: input.request,
        createdBy: input.createdBy,
        idempotency: input.idempotency,
      });
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    getLogger().error(
      {
        err: error,
        organization_id: input.organizationId,
        project_id: input.projectId,
        recurring_payment_id: claimed.id,
        attempt_id: attempt.id,
      },
      "Recurring payment update failed"
    );
    try {
      let currentAttempt = attempt;
      let resetToActive = false;
      const latest = await recurringRepo.getLatestUpdateAttempt({
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: claimed.id,
        statuses: IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
      });
      if (latest === null) {
        throw internalError("Recurring payment update attempt was not found");
      }
      currentAttempt = latest;
      const hasReplacementAuthorization =
        currentAttempt.mode === "replacement" && Boolean(currentAttempt.authorization_signature);
      const hasSubmittedMetadataUpdate =
        currentAttempt.mode === "metadata_schedule" &&
        Boolean(currentAttempt.plan_update_signature);
      const transactionFailed = error instanceof AppError && error.code === "TRANSACTION_FAILED";
      // A resumed step the chain cannot settle yet may have landed: keep the attempt.
      resetToActive =
        !(error instanceof ResumedStepUnsettledError) &&
        !hasReplacementAuthorization &&
        (!hasSubmittedMetadataUpdate || transactionFailed);

      await recordRecurringPaymentUpdateFailure({
        env: input.env,
        attempt: currentAttempt,
        claimed,
        organizationId: input.organizationId,
        projectId: input.projectId,
        error,
        resetToActive,
      });
    } catch (journalError) {
      if (!(journalError instanceof Error)) throw journalError;
      getLogger().error(
        {
          error: recurringPaymentErrorMessage(journalError),
          recurring_payment_id: claimed.id,
        },
        "Failed to journal/reset recurring payment update after failure"
      );
    }

    throw error;
  }

  return updated;
}
