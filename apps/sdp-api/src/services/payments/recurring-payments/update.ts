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
  RecurringPaymentStepSignatureSlot,
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
  type AppError,
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
import { describeError, logEvent } from "@/runtime/money-path-events";
import { createSigningService } from "@/services/domain/signing.service";
import { parseU64String } from "@/services/payment-operation.service";
import { resolveSolanaCounterpartyAccount } from "@/services/payments/counterparty-account-resolution";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import {
  createSponsorshipFeePayment,
  resolveProjectSponsorshipScope,
} from "@/services/sponsorship.service";
import { SponsoredSendRefusedError } from "@/services/sponsorship-submission";
import type { Env } from "@/types/env";
import { recoverOrBlockLifecycleCollection } from "./collection";
import {
  assertRecurringPaymentSourceWallet,
  assertRecurringPaymentTokenMint,
  authorizationSetupEffect,
  delegationCanceledEffect,
  delegationCreatedEffect,
  derivePlanAddresses,
  fenceRecurringPaymentStepFailure,
  insideRecurringPaymentStepPhase,
  journalInFlightRecurringPaymentAttempt,
  lazyRecurringPaymentStepSigner,
  lockLiveActivatingKey,
  parseNullableStoredSignature,
  planCreatedEffect,
  planMetadataUpdatedEffect,
  type RecurringPaymentPlanMetadataPreImage,
  type RecurringPaymentSourceWallet,
  RecurringPaymentStepFailedError,
  type RecurringPaymentStepLogContext,
  type RecurringPaymentStepPhase,
  type RecurringPaymentUnwindCheck,
  ResumedStepUnsettledError,
  readRecurringPaymentStep,
  readSavedRecurringPaymentStep,
  recurringPaymentErrorMessage,
  requireUpdatedAttempt,
  requireUpdatedPlan,
  requireUpdatedSubscription,
  sendRecurringPaymentStep,
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
  sourceWallet: RecurringPaymentSourceWallet;
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
  sourceWallet: RecurringPaymentSourceWallet;
  nextSourceWallet?: RecurringPaymentSourceWallet;
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

/**
 * Writes a pending schedule's new values in one CAS write on its status and `updated_at`. A change
 * to anything the plan carries (every field but `firstCollectionAt`) drops the plan and
 * subscription references, so activation creates a fresh plan with a new program plan id and a
 * fresh subscription instead of reusing rows with the old terms or subscriber; the orphan rows stay.
 *
 * @param recurringRepo - The transaction's recurring payments repository.
 * @param input - The schedule, its resolved update and the write's timestamp.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.recurringPayment - The pending schedule as read.
 * @param input.resolved - The resolved update.
 * @param input.changedDestinationOrToken - Whether the destination or token changed, which drops the destination token account.
 * @param input.updatedAt - The write's timestamp.
 * @returns The updated schedule.
 * @throws AppError CONFLICT when the schedule changed since it was read.
 */
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
  const dropsPlanReference = input.resolved.changedFields.some(
    (field) => REPLACEMENT_UPDATE_FIELDS.has(field) || field === "metadataUri"
  );
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
    destinationTokenAccount: changedDestinationOrToken
      ? null
      : input.recurringPayment.destination_token_account,
    token: input.resolved.token,
    amount: input.resolved.amount,
    periodHours: input.resolved.periodHours,
    firstCollectionAt: input.resolved.firstCollectionAt,
    metadataUri: input.resolved.metadataUri,
    planId: dropsPlanReference ? null : input.recurringPayment.plan_id,
    planPda: dropsPlanReference ? null : input.recurringPayment.plan_pda,
    planCreatedAt: dropsPlanReference ? null : input.recurringPayment.plan_created_at,
    planCreationSignature: dropsPlanReference
      ? null
      : input.recurringPayment.plan_creation_signature,
    subscriptionId: dropsPlanReference ? null : input.recurringPayment.subscription_id,
    subscriptionPda: dropsPlanReference ? null : input.recurringPayment.subscription_pda,
    subscriptionAuthorityAddress: dropsPlanReference
      ? null
      : input.recurringPayment.subscription_authority_address,
    authorizationSignature: dropsPlanReference
      ? null
      : input.recurringPayment.authorization_signature,
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

/**
 * The plan's update-guarded fields as the claimed schedule recorded them: what every plan update
 * send expects and every read of it compares against.
 *
 * @param claimed - The claimed active schedule.
 * @returns Its plan's `createdAt` and metadata URI as the program stores them.
 * @throws AppError INTERNAL_ERROR when the schedule has no recorded plan creation time.
 */
function planMetadataPreImage(
  claimed: PaymentRecurringPaymentRow
): RecurringPaymentPlanMetadataPreImage {
  if (claimed.plan_created_at === null) {
    throw internalError("Recurring payment is missing its on-chain plan creation time");
  }
  return {
    createdAt: claimed.plan_created_at,
    metadataUri: subscriptionProgramMetadataUri(claimed.metadata_uri),
  };
}

/** An update attempt's step signature slot. */
type UpdateAttemptStepSlot = Extract<RecurringPaymentStepSignatureSlot, { row: "update_attempt" }>;
type UpdateAttemptStepColumn = UpdateAttemptStepSlot["column"];

/**
 * Checks the chain before a replacement unwinds. A replacement never returns to `active` on the
 * old mandate while the new delegation exists: both would be live. A new delegation on chain is
 * the authorization landed (its slot is empty only because a resend was refused as already
 * subscribed, or nothing was saved), so the update continues from it to the old cancel instead.
 * The new delegation is derived from the attempt's replacement plan, so the check holds however
 * far this run got; with no replacement plan recorded, no new delegation can exist. Costs one plan
 * row read and two RPC calls, only on the unwind path.
 *
 * @param input - The run's attempt and the failure being unwound.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.attempt - The run's attempt as it stands.
 * @param input.cause - The step failure, or the earlier step still pending, the flow would
 *   unwind or wait for.
 * @returns `unwind` when no new delegation exists, `last_step_landed` when it does.
 * @throws ResumedStepUnsettledError when the new delegation cannot be read; the attempt stays in
 *   flight.
 * @throws AppError INTERNAL_ERROR when the recorded replacement plan row is missing.
 */
async function checkReplacementUnwind(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  cause: Error;
}): Promise<RecurringPaymentUnwindCheck> {
  if (input.attempt.new_plan_id === null) {
    return "unwind";
  }
  const plan = await createPaymentSubscriptionsRepository(
    input.env,
    createTenantScope(input)
  ).getPlanById({
    planId: input.attempt.new_plan_id,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (plan === null) {
    throw internalError("Recurring payment replacement plan was not found");
  }
  const { owner, planPda } = await derivePlanAddresses(plan);
  const [subscriptionPda] = await subscriptionsProgram.findSubscriptionDelegationPda({
    planPda,
    subscriber: owner,
  });
  const logContext: RecurringPaymentStepLogContext = {
    recurring_payment_id: input.attempt.recurring_payment_id,
    attempt_id: input.attempt.id,
    step: "authorize_subscription",
  };
  const delegation = await readRecurringPaymentStep({
    effect: delegationCreatedEffect(subscriptionPda),
    savedSignature: null,
    lastValidBlockHeight: null,
    logContext,
  });
  switch (delegation.state) {
    case "unsent":
    case "dropped":
      return "unwind";
    case "landed":
      logEvent("warn", {
        event: "sdp_api_recurring_payment_unwind_found_step_landed",
        ...logContext,
        subscription_pda: subscriptionPda,
        ...describeError(input.cause),
      });
      return "last_step_landed";
    case "pending":
      logEvent("error", {
        event: "sdp_api_recurring_payment_unwind_refused_delegation_live",
        ...logContext,
        delegation_state: delegation.state,
        subscription_pda: subscriptionPda,
        ...describeError(input.cause),
      });
      throw new ResumedStepUnsettledError();
    default:
      return assertNever(delegation);
  }
}

/**
 * Clears a dropped old-subscription cancel's saved signature, only while its slot still holds
 * it, and logs it, so the next send of the cancel starts from an empty slot.
 *
 * @param input - The dropped cancel.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.recurringPaymentId - The schedule.
 * @param input.attemptId - The update attempt.
 * @param input.signature - The dropped cancel's saved signature.
 * @param input.oldSubscriptionPda - The old delegation's address.
 * @param input.logContext - What the step's logs name.
 * @throws AppError CONFLICT when the slot no longer holds the signature.
 */
async function clearDroppedOldCancel(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  attemptId: string;
  signature: Signature;
  oldSubscriptionPda: Address;
  logContext: RecurringPaymentStepLogContext;
}): Promise<void> {
  const cleared = await createPaymentRecurringPaymentsRepository(
    input.env,
    createTenantScope(input)
  ).clearStepSignature({
    slot: { row: "update_attempt", column: "old_cancel_signature" },
    id: input.attemptId,
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    signature: input.signature,
    updatedAt: new Date().toISOString(),
  });
  if (!cleared) {
    throw conflict("Recurring payment step signature changed concurrently");
  }
  logEvent("error", {
    event: "sdp_api_recurring_payment_old_cancel_dropped",
    ...input.logContext,
    signature: input.signature,
    old_subscription_pda: input.oldSubscriptionPda,
  });
}

/**
 * Logs and returns the refusal of an update step the cron would send. The cron's mandate admits no
 * `recurring.update` (`MANDATE_MOVEMENT_STATUSES`), so the cron never starts an update send: the
 * unsent step fails the update back to `active` on its old terms, and a same-key PATCH can still
 * send it.
 *
 * @param logContext - The schedule and attempt the error log names.
 * @returns The CONFLICT error the step fails with.
 */
function refuseCronUpdateStepSend(
  logContext: Pick<RecurringPaymentStepLogContext, "recurring_payment_id" | "attempt_id">
): AppError {
  logEvent("error", {
    event: "sdp_api_recurring_payment_step_unsendable",
    ...logContext,
    movement: "recurring.update",
    reason: "cron_starts_no_update_send",
  });
  return conflict("The cron sends no new recurring payment update step; retry the update");
}

/**
 * The signer an update's unwinding steps send with, resolved only when a step needs a new send,
 * after every saved step was read. A request resolves the wallet's signer then, and the signing
 * waist decides each signature (a fresh update was admitted before its claim). The cron gets one
 * that refuses (`refuseCronUpdateStepSend`), which fails the update back to `active`.
 *
 * @param input - The wallet the steps sign with and who runs them.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.sourceWallet - The wallet the steps sign with.
 * @param input.startsAllowed - False when the cron runs the update: no new update send.
 * @param input.logContext - The schedule and attempt the error logs name.
 * @returns A function that resolves the signer, or throws the refusal.
 */
function updateStepSigner(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
  startsAllowed: boolean;
  logContext: Pick<RecurringPaymentStepLogContext, "recurring_payment_id" | "attempt_id">;
}): () => Promise<TransactionSigner> {
  if (input.startsAllowed) {
    return lazyRecurringPaymentStepSigner({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.sourceWallet,
      movement: "recurring.update",
      admitRecovered: null,
      logContext: input.logContext,
    });
  }
  return async () => {
    throw refuseCronUpdateStepSend(input.logContext);
  };
}

async function runMetadataScheduleUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
  claimed: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow | null;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  resolved: ResolvedRecurringPaymentUpdate;
  requestedNextCollectionDueAt: string | null | undefined;
  createdBy: string | null;
  idempotency: RecurringPaymentUpdateIdempotency | null;
  startsAllowed: boolean;
}): Promise<PaymentRecurringPaymentRow> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(
    input.env,
    createTenantScope(input)
  );
  const rpc = createClusterRpc();
  let attempt = input.attempt;
  const planUpdateSignature = parseNullableStoredSignature(attempt.plan_update_signature);
  const phase: RecurringPaymentStepPhase = {
    unreadSavedStep: planUpdateSignature === null ? null : "plan_update_signature",
    step: { row: "update_attempt", column: "plan_update_signature" },
  };
  const stepSigner = updateStepSigner({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    startsAllowed: input.startsAllowed,
    logContext: { recurring_payment_id: input.claimed.id, attempt_id: attempt.id },
  });

  const metadataSteps = async () => {
    let onChainSubscription: Awaited<
      ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>
    > | null = null;
    if (input.requestedNextCollectionDueAt !== undefined && input.claimed.subscription_pda) {
      onChainSubscription = await subscriptionsProgram.fetchMaybeSubscriptionDelegation(
        rpc,
        assertValidAddress(input.claimed.subscription_pda, "subscriptionPda"),
        { commitment: "confirmed" }
      );
    }
    const resolvedNextDueAt = activeNextCollectionDueAt({
      requested: input.requestedNextCollectionDueAt,
      recurringPayment: input.claimed,
      subscription: input.subscription,
      onChainSubscription,
      clampToMinimum: planUpdateSignature !== null,
    });

    if (input.resolved.metadataUri === input.claimed.metadata_uri) {
      return resolvedNextDueAt;
    }
    if (!input.claimed.plan_pda) {
      throw conflict("Recurring payment is missing on-chain plan records");
    }

    const planPda = assertValidAddress(input.claimed.plan_pda, "planPda");
    const failureMessage = "Recurring payment update failed on-chain";
    const slot = { row: "update_attempt", column: "plan_update_signature" } as const;
    const targetMetadataUri = subscriptionProgramMetadataUri(input.resolved.metadataUri);
    const logContext: RecurringPaymentStepLogContext = {
      recurring_payment_id: input.claimed.id,
      attempt_id: attempt.id,
      step: "update_plan",
    };
    // Every send and read of this step works from the pre-image the schedule recorded, fresh or
    // resumed: the send expects it, so the program refuses (522) a plan changed outside this
    // attempt instead of overwriting it, and the effect compares the plan against it.
    const preImage = planMetadataPreImage(input.claimed);
    const effect = planMetadataUpdatedEffect({
      planPda,
      preImage,
      targetMetadataUri,
      logContext,
    });
    // A signature saved in the step's slot means an earlier run reached the send (HOO-2044): the
    // plan's metadata settles whether it landed.
    if (planUpdateSignature !== null) {
      await readSavedRecurringPaymentStep({
        phase,
        slot,
        signature: planUpdateSignature,
        lastValidBlockHeight: attempt.last_valid_block_height,
        effect,
        failureMessage,
        logContext,
      });
      return resolvedNextDueAt;
    }

    const sourceSigner = await stepSigner();
    const onChainPlan = await subscriptionsProgram.fetchMaybePlan(rpc, planPda, {
      commitment: "confirmed",
    });
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
      expectedCreatedAt: BigInt(preImage.createdAt),
      expectedEndTs: onChainPlan.data.data.endTs,
      expectedMetadataUri: preImage.metadataUri,
      expectedPullers: onChainPlan.data.data.pullers,
      metadataUri: targetMetadataUri,
      owner: sourceSigner,
      planPda,
      pullers: onChainPlan.data.data.pullers,
      status: parsePlanStatus(onChainPlan.data.status),
    });
    await sendRecurringPaymentStep({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.claimed.id,
      attemptId: attempt.id,
      movement: "recurring.update",
      sourceWallet: input.sourceWallet,
      sourceSigner,
      instructions: [instruction],
      slot,
      effect,
      alreadyDone: {
        code: subscriptionsProgram.SUBSCRIPTIONS_ERROR__STALE_PLAN_APPROVAL,
        notLanded: "failed",
      },
      onFailure: { outcome: "unwind" },
      failureMessage,
      logContext,
    });
    return resolvedNextDueAt;
  };
  const nextDueAt = await insideRecurringPaymentStepPhase(phase, metadataSteps, null);

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

/**
 * Makes sure the source wallet's subscription authority and token account exist and delegate to
 * each other before subscribe. A setup an earlier run saved a signature for is read first, as
 * every other step is; otherwise a wallet that already has both skips the step, and one missing
 * either sends the setup (the token account create when it is missing, then the authority init,
 * always) through the step runner.
 *
 * @param input - The setup's accounts, signers and attempt.
 * @returns The subscription authority as read after setup.
 * @throws ResumedStepUnsettledError when the setup is pending.
 * @throws RecurringPaymentStepFailedError when the setup is dropped or cannot land.
 */
async function prepareSubscriptionAuthorityForUpdate(input: {
  env: Env;
  recurringPaymentId: string;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  phase: RecurringPaymentStepPhase;
  organizationId: string;
  projectId: string;
  rpc: SolanaRpc;
  sourceWallet: RecurringPaymentSourceWallet;
  stepSigner: () => Promise<TransactionSigner>;
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
  const failureMessage = "Recurring payment update failed on-chain";
  const slot = { row: "update_attempt", column: "authorization_setup_signature" } as const;
  input.phase.step = slot;
  const logContext: RecurringPaymentStepLogContext = {
    recurring_payment_id: input.recurringPaymentId,
    attempt_id: input.attempt.id,
    step: "authorization_setup",
  };
  const effect = authorizationSetupEffect({
    subscriptionAuthorityAddress: input.subscriptionAuthorityAddress,
    sourceTokenAccount: input.sourceTokenAccount.tokenAccount,
    owner: input.owner,
    mint: input.mint,
    tokenProgram: input.tokenProgram,
  });
  const savedSetupSignature = parseNullableStoredSignature(
    input.attempt.authorization_setup_signature
  );
  if (savedSetupSignature !== null) {
    const accounts = await readSavedRecurringPaymentStep({
      phase: input.phase,
      slot,
      signature: savedSetupSignature,
      lastValidBlockHeight: input.attempt.last_valid_block_height,
      effect,
      failureMessage,
      logContext,
    });
    return subscriptionsProgram.decodeSubscriptionAuthority(accounts[0]);
  }
  if (input.subscriptionAuthority.exists && input.sourceTokenAccount.exists) {
    return input.subscriptionAuthority;
  }

  const sourceSigner = await input.stepSigner();
  const payer = createNoopSigner(input.feePayer);
  // The init always goes out: it is idempotent on an existing authority (its `initId` stays) and
  // re-runs the token account's Approve, which the setup effect requires.
  const initAuthorityInstruction =
    await subscriptionsProgram.getInitSubscriptionAuthorityOverlayInstructionAsync({
      owner: sourceSigner,
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
  const settled = await sendRecurringPaymentStep({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPaymentId,
    attemptId: input.attempt.id,
    movement: "recurring.update",
    sourceWallet: input.sourceWallet,
    sourceSigner,
    feePayer: input.feePayer,
    instructions: [
      ...(createSourceAtaInstruction ? [createSourceAtaInstruction] : []),
      initAuthorityInstruction,
    ],
    slot,
    effect,
    alreadyDone: null,
    onFailure: { outcome: "unwind" },
    failureMessage,
    logContext,
  });
  if (settled.state === "landed") {
    return subscriptionsProgram.decodeSubscriptionAuthority(settled.accounts[0]);
  }
  if (input.subscriptionAuthority.exists) {
    return input.subscriptionAuthority;
  }

  const subscriptionAuthority = await subscriptionsProgram.fetchMaybeSubscriptionAuthority(
    input.rpc,
    input.subscriptionAuthorityAddress,
    { commitment: "confirmed", minContextSlot: settled.confirmedSlot }
  );
  if (!subscriptionAuthority.exists) {
    throw transactionFailed("Subscription authority was not found on-chain");
  }
  return subscriptionAuthority;
}

async function getOrCreateReplacementPlan(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
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

/**
 * The latest unwinding step of a replacement an earlier run saved a signature for: the only one
 * whose send may still be in flight.
 *
 * @param attempt - The claimed attempt.
 * @returns The step's slot column, or null when none is saved.
 */
function latestSavedReplacementStep(
  attempt: PaymentRecurringPaymentUpdateAttemptRow
): UpdateAttemptStepColumn | null {
  if (attempt.authorization_signature !== null) return "authorization_signature";
  if (attempt.authorization_setup_signature !== null) return "authorization_setup_signature";
  if (attempt.plan_creation_signature !== null) return "plan_creation_signature";
  return null;
}

/**
 * Reads the old subscription's cancel an earlier run saved a signature for. A dropped cancel is
 * cleared, only while its slot still holds the signature, and logged, for the caller to send it
 * again: the new mandate is live, so the cancel never unwinds. A saved cancel never reads as
 * unsent; the reader's unsent arm is kept in flight with pending.
 *
 * @param input - The saved cancel.
 * @param input.env - The environment.
 * @param input.attempt - The run's attempt.
 * @param input.signature - The saved cancel signature.
 * @param input.oldSubscriptionPda - The old delegation's address.
 * @param input.logContext - What the step's logs name.
 * @returns Whether the cancel landed.
 * @throws ResumedStepUnsettledError when the cancel is pending.
 * @throws AppError CONFLICT when the slot no longer holds the dropped signature.
 */
async function readSavedOldCancel(input: {
  env: Env;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  signature: Signature;
  oldSubscriptionPda: Address;
  logContext: RecurringPaymentStepLogContext;
}): Promise<boolean> {
  const step = await readRecurringPaymentStep({
    effect: delegationCanceledEffect(input.oldSubscriptionPda),
    savedSignature: input.signature,
    lastValidBlockHeight: input.attempt.last_valid_block_height,
    logContext: input.logContext,
  });
  switch (step.state) {
    case "landed":
      return true;
    case "unsent":
    case "pending":
      throw new ResumedStepUnsettledError();
    case "dropped":
      await clearDroppedOldCancel({
        env: input.env,
        organizationId: input.attempt.organization_id,
        projectId: input.attempt.project_id,
        recurringPaymentId: input.attempt.recurring_payment_id,
        attemptId: input.attempt.id,
        signature: input.signature,
        oldSubscriptionPda: input.oldSubscriptionPda,
        logContext: input.logContext,
      });
      return false;
    default:
      return assertNever(step);
  }
}

/**
 * Sends a replacement's plan creation: its stage, then create plan through the step runner, and
 * reads the plan it created.
 *
 * @param input - The plan's terms, accounts, signer and attempt.
 * @returns The attempt after its stage write, the plan creation signature (null when the send was
 *   refused as already done) and the plan as read.
 * @throws ResumedStepUnsettledError when the plan creation is pending.
 * @throws RecurringPaymentStepFailedError when it cannot land.
 */
async function sendReplacementPlanCreation(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  sourceWallet: RecurringPaymentSourceWallet;
  sourceSigner: TransactionSigner;
  resolved: ResolvedRecurringPaymentUpdate;
  owner: Address;
  destination: Address;
  mint: Address;
  tokenProgram: Address;
  amountBaseUnits: bigint;
  programPlanId: bigint;
  planPda: Address;
  slot: UpdateAttemptStepSlot;
  failureMessage: string;
  logContext: RecurringPaymentStepLogContext;
}) {
  const attempt = requireUpdatedAttempt(
    await input.recurringRepo.updateUpdateAttempt({
      attemptId: input.attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      stage: "create_plan",
      updatedAt: new Date().toISOString(),
    })
  );
  const createPlanInstruction = await subscriptionsProgram.getCreatePlanOverlayInstructionAsync({
    amount: input.amountBaseUnits,
    destinations: [input.destination],
    endTs: 0n,
    metadataUri: subscriptionProgramMetadataUri(input.resolved.metadataUri),
    mint: input.mint,
    owner: input.sourceSigner,
    periodHours: BigInt(input.resolved.periodHours),
    planId: input.programPlanId,
    pullers: [input.owner],
    tokenProgram: input.tokenProgram,
  });
  const settled = await sendRecurringPaymentStep({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: attempt.recurring_payment_id,
    attemptId: attempt.id,
    movement: "recurring.update",
    sourceWallet: input.sourceWallet,
    sourceSigner: input.sourceSigner,
    instructions: [createPlanInstruction],
    slot: input.slot,
    effect: planCreatedEffect(input.planPda),
    alreadyDone: {
      code: subscriptionsProgram.SUBSCRIPTIONS_ERROR__PLAN_ALREADY_EXISTS,
      notLanded: "pending",
    },
    onFailure: { outcome: "unwind" },
    failureMessage: input.failureMessage,
    logContext: input.logContext,
  });
  const onChainPlan =
    settled.state === "landed"
      ? subscriptionsProgram.decodePlan(settled.accounts[0])
      : await subscriptionsProgram.fetchMaybePlan(createClusterRpc(), input.planPda, {
          commitment: "confirmed",
          minContextSlot: settled.confirmedSlot,
        });
  return { attempt, signature: settled.signature, onChainPlan };
}

/**
 * Sends a replacement's authorization: its stage, the source wallet's setup when it needs one,
 * then subscribe to the new plan, each through the step runner. A subscribe refused as already
 * subscribed whose re-read shows the delegation goes on to the old cancel in this run with no
 * signature saved; a later run finds the slot empty, sends again, and re-derives landed from the
 * chain the same way, and an unwind first checks the chain for the delegation.
 *
 * @param input - The authorization's accounts, signers, terms and attempt.
 * @returns The attempt after its stage write, and the authorization signature (null when the
 *   subscribe was refused as already done).
 * @throws ResumedStepUnsettledError when the setup or subscribe is pending.
 * @throws RecurringPaymentStepFailedError when either cannot land.
 */
async function sendReplacementAuthorization(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  phase: RecurringPaymentStepPhase;
  sourceWallet: RecurringPaymentSourceWallet;
  stepSigner: () => Promise<TransactionSigner>;
  sourceTokenAccount: { tokenAccount: Address; exists: boolean };
  subscriptionAuthorityAddress: Address;
  subscriptionPda: Address;
  owner: Address;
  mint: Address;
  tokenProgram: Address;
  amountBaseUnits: bigint;
  planCreatedAt: string;
  periodHours: number;
  programPlanId: bigint;
  slot: UpdateAttemptStepSlot;
  failureMessage: string;
  logContext: RecurringPaymentStepLogContext;
}): Promise<{ attempt: PaymentRecurringPaymentUpdateAttemptRow; signature: Signature | null }> {
  const rpc = createClusterRpc();
  const attempt = requireUpdatedAttempt(
    await input.recurringRepo.updateUpdateAttempt({
      attemptId: input.attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      stage: "authorize_subscription",
      updatedAt: new Date().toISOString(),
    })
  );
  const fetchedSubscriptionAuthority = await subscriptionsProgram.fetchMaybeSubscriptionAuthority(
    rpc,
    input.subscriptionAuthorityAddress,
    { commitment: "confirmed" }
  );
  const feePayment = createSponsorshipFeePayment(
    input.env,
    await resolveProjectSponsorshipScope(input.env, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      actor: { type: "wallet", id: input.sourceWallet.walletId },
    }),
    "recurring.update"
  );
  const feePayer = await feePayment.getFeePayer();
  const payer = createNoopSigner(feePayer);
  const subscriptionAuthority = await prepareSubscriptionAuthorityForUpdate({
    env: input.env,
    recurringPaymentId: attempt.recurring_payment_id,
    attempt,
    phase: input.phase,
    organizationId: input.organizationId,
    projectId: input.projectId,
    rpc,
    sourceWallet: input.sourceWallet,
    stepSigner: input.stepSigner,
    sourceTokenAccount: input.sourceTokenAccount,
    subscriptionAuthority: fetchedSubscriptionAuthority,
    subscriptionAuthorityAddress: input.subscriptionAuthorityAddress,
    owner: input.owner,
    mint: input.mint,
    tokenProgram: input.tokenProgram,
    feePayer,
  });
  input.phase.step = input.slot;
  if (!subscriptionAuthority.exists) {
    throw transactionFailed("Subscription authority was not found on-chain");
  }

  const sourceSigner = await input.stepSigner();
  const subscribeInstruction = await subscriptionsProgram.getSubscribeOverlayInstructionAsync({
    expectedAmount: input.amountBaseUnits,
    expectedCreatedAt: BigInt(input.planCreatedAt),
    expectedPeriodHours: BigInt(input.periodHours),
    expectedSubscriptionAuthorityInitId: subscriptionAuthority.data.initId,
    merchant: input.owner,
    payer,
    planId: input.programPlanId,
    subscriber: sourceSigner,
    tokenMint: input.mint,
  });
  const settled = await sendRecurringPaymentStep({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: attempt.recurring_payment_id,
    attemptId: attempt.id,
    movement: "recurring.update",
    sourceWallet: input.sourceWallet,
    sourceSigner,
    feePayer,
    instructions: [subscribeInstruction],
    slot: input.slot,
    effect: delegationCreatedEffect(input.subscriptionPda),
    alreadyDone: {
      code: subscriptionsProgram.SUBSCRIPTIONS_ERROR__ALREADY_SUBSCRIBED,
      notLanded: "pending",
    },
    onFailure: { outcome: "unwind" },
    failureMessage: input.failureMessage,
    logContext: input.logContext,
  });
  return { attempt, signature: settled.signature };
}

/** What a replacement's steps leave for its old cancel and finalize. */
interface SettledReplacementSteps {
  oldPlanPda: Address;
  oldSubscriptionPda: Address;
  oldSubscription: PaymentSubscriptionRow;
  requestedNextDue: string | null;
  plan: PaymentSubscriptionPlanRow;
  planPda: Address;
  planCreatedAt: string;
  /** Null when the plan's resend was refused as already done. */
  planCreationSignature: Signature | null;
  subscription: PaymentSubscriptionRow;
  subscriptionPda: Address;
  subscriptionAuthorityAddress: Address;
  /** Null when the authorization landed with no signature this attempt holds. */
  authorizationSignature: Signature | null;
}

/**
 * A replacement's new mandate as its landed authorization leaves it, read back from the schedule
 * and the attempt, for the old cancel. The new delegation on chain proves the plan and setup
 * landed and the attempt recorded the new plan and subscription before the authorization, so no
 * step is read or sent: a setup whose token approval was revoked since can never hold the update
 * in flight. One plan account read supplies the plan's creation time, which nothing records
 * before finalize. The signatures are the attempt's, null when it holds none (the trace gap ADR
 * 0009 accepts).
 *
 * @param input - The run's repositories, RPC, tenant, schedule and attempt.
 * @param input.recurringRepo - The recurring payments repository.
 * @param input.subscriptionsRepo - The subscriptions repository.
 * @param input.rpc - The cluster RPC.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.recurringPaymentId - The schedule.
 * @param input.attemptId - The run's attempt.
 * @returns The attempt as re-read, and the new mandate's settled steps.
 * @throws AppError CONFLICT when the schedule is no longer `updating` or the attempt is no longer
 *   this run's in-flight attempt.
 * @throws AppError INTERNAL_ERROR when the attempt lacks the new plan or subscription it recorded
 *   before the authorization, their rows or addresses are missing, or the plan is not on chain.
 */
async function readLandedReplacement(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  subscriptionsRepo: PaymentSubscriptionsRepository;
  rpc: SolanaRpc;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  attemptId: string;
}): Promise<{
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  steps: Omit<
    SettledReplacementSteps,
    "oldPlanPda" | "oldSubscriptionPda" | "oldSubscription" | "requestedNextDue"
  >;
}> {
  const tenant = { organizationId: input.organizationId, projectId: input.projectId };
  const [schedule, attempt] = await Promise.all([
    input.recurringRepo.getRecurringPaymentById({
      ...tenant,
      recurringPaymentId: input.recurringPaymentId,
    }),
    input.recurringRepo.getLatestUpdateAttempt({
      ...tenant,
      recurringPaymentId: input.recurringPaymentId,
      statuses: IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
    }),
  ]);
  if (
    schedule === null ||
    !isUpdatingRecurringPaymentStatus(schedule.status) ||
    attempt === null ||
    attempt.id !== input.attemptId
  ) {
    throw conflict("Recurring payment update changed concurrently");
  }
  if (attempt.new_plan_id === null || attempt.new_subscription_id === null) {
    throw internalError("Recurring payment replacement landed without its recorded plan");
  }
  const [plan, subscription] = await Promise.all([
    input.subscriptionsRepo.getPlanById({ ...tenant, planId: attempt.new_plan_id }),
    input.subscriptionsRepo.getSubscriptionById({
      ...tenant,
      subscriptionId: attempt.new_subscription_id,
    }),
  ]);
  if (
    plan === null ||
    plan.plan_pda === null ||
    subscription === null ||
    subscription.subscription_pda === null ||
    subscription.subscription_authority_address === null
  ) {
    throw internalError("Recurring payment replacement plan or subscription was not recorded");
  }
  const planPda = assertValidAddress(plan.plan_pda, "planPda");
  const onChainPlan = await subscriptionsProgram.fetchMaybePlan(input.rpc, planPda, {
    commitment: "confirmed",
  });
  if (!onChainPlan.exists) {
    throw internalError("Recurring payment replacement plan was not found on-chain");
  }
  return {
    attempt,
    steps: {
      plan,
      planPda,
      planCreatedAt: onChainPlan.data.data.terms.createdAt.toString(),
      planCreationSignature: parseNullableStoredSignature(attempt.plan_creation_signature),
      subscription,
      subscriptionPda: assertValidAddress(subscription.subscription_pda, "subscriptionPda"),
      subscriptionAuthorityAddress: assertValidAddress(
        subscription.subscription_authority_address,
        "subscriptionAuthorityAddress"
      ),
      authorizationSignature: parseNullableStoredSignature(attempt.authorization_signature),
    },
  };
}

async function runReplacementUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  oldSourceWallet: RecurringPaymentSourceWallet;
  claimed: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow | null;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  resolved: ResolvedRecurringPaymentUpdate;
  requestedNextCollectionDueAt: string | null | undefined;
  createdBy: string | null;
  idempotency: RecurringPaymentUpdateIdempotency | null;
  startsAllowed: boolean;
}): Promise<PaymentRecurringPaymentRow> {
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
  const savedPlanCreationSignature = parseNullableStoredSignature(attempt.plan_creation_signature);
  const savedAuthorizationSignature = parseNullableStoredSignature(attempt.authorization_signature);
  const savedOldCancelSignature = parseNullableStoredSignature(attempt.old_cancel_signature);
  const replacementPeriodStartAt = attempt.created_at;
  const phase: RecurringPaymentStepPhase = {
    unreadSavedStep: latestSavedReplacementStep(attempt),
    step: { row: "update_attempt", column: "plan_creation_signature" },
  };
  const stepSigner = updateStepSigner({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.resolved.sourceWallet,
    startsAllowed: input.startsAllowed,
    logContext: { recurring_payment_id: input.claimed.id, attempt_id: attempt.id },
  });

  const resolveOldMandate = async () => {
    if (
      !input.claimed.plan_pda ||
      !input.claimed.subscription_id ||
      !input.claimed.subscription_pda
    ) {
      throw conflict("Recurring payment is missing on-chain subscription records");
    }
    const oldSubscription =
      input.subscription ??
      (await subscriptionsRepo.getSubscriptionById({
        subscriptionId: input.claimed.subscription_id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      }));
    if (!oldSubscription) {
      throw notFound("Subscription");
    }
    return {
      oldPlanPda: assertValidAddress(input.claimed.plan_pda, "planPda"),
      oldSubscriptionPda: assertValidAddress(input.claimed.subscription_pda, "subscriptionPda"),
      oldSubscription,
      requestedNextDue: replacementNextCollectionDueAt({
        requested: input.requestedNextCollectionDueAt,
        periodStartAt: replacementPeriodStartAt,
        periodHours: input.resolved.periodHours,
        clampToMinimum: Boolean(
          savedPlanCreationSignature || savedAuthorizationSignature || savedOldCancelSignature
        ),
      }),
    };
  };

  const replacementSteps = async (): Promise<SettledReplacementSteps> => {
    const { oldPlanPda, oldSubscriptionPda, oldSubscription, requestedNextDue } =
      await resolveOldMandate();

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

    const planFailureMessage = "Recurring payment replacement plan creation failed on-chain";
    const planSlot = { row: "update_attempt", column: "plan_creation_signature" } as const;
    const planLogContext: RecurringPaymentStepLogContext = {
      recurring_payment_id: attempt.recurring_payment_id,
      attempt_id: attempt.id,
      step: "create_plan",
    };
    // A signature saved in a step's slot means an earlier run reached its send (HOO-2044): the
    // chain settles whether it landed before anything is sent again. A step with no saved
    // signature never left, and reads nothing extra.
    const landedPlanAccounts =
      savedPlanCreationSignature === null
        ? null
        : await readSavedRecurringPaymentStep({
            phase,
            slot: planSlot,
            signature: savedPlanCreationSignature,
            lastValidBlockHeight: attempt.last_valid_block_height,
            effect: planCreatedEffect(planPda),
            failureMessage: planFailureMessage,
            logContext: planLogContext,
          });
    let planCreationSignature = savedPlanCreationSignature;
    let onChainPlan =
      landedPlanAccounts === null ? null : subscriptionsProgram.decodePlan(landedPlanAccounts[0]);
    if (!onChainPlan) {
      const created = await sendReplacementPlanCreation({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringRepo,
        attempt,
        sourceWallet: input.resolved.sourceWallet,
        sourceSigner: await stepSigner(),
        resolved: input.resolved,
        owner,
        destination,
        mint,
        tokenProgram,
        amountBaseUnits,
        programPlanId,
        planPda,
        slot: planSlot,
        failureMessage: planFailureMessage,
        logContext: planLogContext,
      });
      attempt = created.attempt;
      planCreationSignature = created.signature;
      onChainPlan = created.onChainPlan;
    }
    if (!onChainPlan.exists) {
      throw transactionFailed("Subscription plan was not found on-chain");
    }
    const planCreatedAt = onChainPlan.data.data.terms.createdAt.toString();
    phase.step = { row: "update_attempt", column: "authorization_setup_signature" };

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

    const authorizeFailureMessage = "Recurring payment replacement authorization failed on-chain";
    const authorizeSlot = { row: "update_attempt", column: "authorization_signature" } as const;
    const authorizeLogContext: RecurringPaymentStepLogContext = {
      recurring_payment_id: attempt.recurring_payment_id,
      attempt_id: attempt.id,
      step: "authorize_subscription",
    };
    if (savedAuthorizationSignature !== null) {
      phase.step = authorizeSlot;
      await readSavedRecurringPaymentStep({
        phase,
        slot: authorizeSlot,
        signature: savedAuthorizationSignature,
        lastValidBlockHeight: attempt.last_valid_block_height,
        effect: delegationCreatedEffect(subscriptionPda),
        failureMessage: authorizeFailureMessage,
        logContext: authorizeLogContext,
      });
    }
    let authorizationSignature = savedAuthorizationSignature;
    if (savedAuthorizationSignature === null) {
      const authorized = await sendReplacementAuthorization({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringRepo,
        attempt,
        phase,
        sourceWallet: input.resolved.sourceWallet,
        stepSigner,
        sourceTokenAccount,
        subscriptionAuthorityAddress,
        subscriptionPda,
        owner,
        mint,
        tokenProgram,
        amountBaseUnits,
        planCreatedAt,
        periodHours: input.resolved.periodHours,
        programPlanId,
        slot: authorizeSlot,
        failureMessage: authorizeFailureMessage,
        logContext: authorizeLogContext,
      });
      attempt = authorized.attempt;
      authorizationSignature = authorized.signature;
    }

    return {
      oldPlanPda,
      oldSubscriptionPda,
      oldSubscription,
      requestedNextDue,
      plan,
      planPda,
      planCreatedAt,
      planCreationSignature,
      subscription,
      subscriptionPda,
      subscriptionAuthorityAddress,
      authorizationSignature,
    };
  };
  const replacement = await insideRecurringPaymentStepPhase(phase, replacementSteps, {
    finalStep: { row: "update_attempt", column: "authorization_signature" },
    check: (cause) =>
      checkReplacementUnwind({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        attempt,
        cause,
      }),
    continueFromLanded: async () => {
      const landed = await readLandedReplacement({
        recurringRepo,
        subscriptionsRepo,
        rpc,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.claimed.id,
        attemptId: attempt.id,
      });
      attempt = landed.attempt;
      return { ...(await resolveOldMandate()), ...landed.steps };
    },
  });

  const cancelOldLogContext: RecurringPaymentStepLogContext = {
    recurring_payment_id: attempt.recurring_payment_id,
    attempt_id: attempt.id,
    step: "cancel_old_subscription",
  };
  const oldCanceledOnChain =
    savedOldCancelSignature !== null &&
    (await readSavedOldCancel({
      env: input.env,
      attempt,
      signature: savedOldCancelSignature,
      oldSubscriptionPda: replacement.oldSubscriptionPda,
      logContext: cancelOldLogContext,
    }));
  let oldCancelSignature = oldCanceledOnChain ? savedOldCancelSignature : null;
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
    try {
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
          planPda: replacement.oldPlanPda,
          subscriber: oldSourceSigner,
          subscriptionPda: replacement.oldSubscriptionPda,
        });
      const settledCancel = await sendRecurringPaymentStep({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.claimed.id,
        attemptId: attempt.id,
        movement: "recurring.update_cancel_old",
        sourceWallet: input.oldSourceWallet,
        sourceSigner: oldSourceSigner,
        instructions: [cancelInstruction],
        slot: { row: "update_attempt", column: "old_cancel_signature" },
        effect: delegationCanceledEffect(replacement.oldSubscriptionPda),
        alreadyDone: {
          code: subscriptionsProgram.SUBSCRIPTIONS_ERROR__SUBSCRIPTION_ALREADY_CANCELLED,
          notLanded: "pending",
        },
        onFailure: {
          outcome: "stay_in_flight",
          onDropped: (signature) =>
            clearDroppedOldCancel({
              env: input.env,
              organizationId: input.organizationId,
              projectId: input.projectId,
              recurringPaymentId: input.claimed.id,
              attemptId: attempt.id,
              signature,
              oldSubscriptionPda: replacement.oldSubscriptionPda,
              logContext: cancelOldLogContext,
            }),
        },
        failureMessage: "Recurring payment old subscription cancellation failed on-chain",
        logContext: cancelOldLogContext,
      });
      oldCancelSignature = settledCancel.signature;
    } catch (error) {
      if (!(error instanceof Error) || error instanceof ResumedStepUnsettledError) throw error;
      // The new mandate is live, so the old one's cancel never unwinds: the attempt stays
      // `updating` and the next run sends it again.
      logEvent("error", {
        event: "sdp_api_recurring_payment_old_cancel_failed",
        ...cancelOldLogContext,
        old_subscription_pda: replacement.oldSubscriptionPda,
        refused_signature: error instanceof SponsoredSendRefusedError ? error.signature : null,
        ...describeError(error),
      });
      throw error;
    }
  }

  const finalizedAt = new Date().toISOString();
  const safeNextDue = replacementNextCollectionDueAt({
    requested: replacement.requestedNextDue,
    periodStartAt: finalizedAt,
    periodHours: input.resolved.periodHours,
    clampToMinimum: true,
  });

  return finalizeReplacementUpdate({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    claimed: input.claimed,
    oldSubscription: replacement.oldSubscription,
    plan: replacement.plan,
    subscription: replacement.subscription,
    attempt,
    resolved: input.resolved,
    planPda: replacement.planPda,
    planCreatedAt: replacement.planCreatedAt,
    planCreationSignature: replacement.planCreationSignature,
    subscriptionPda: replacement.subscriptionPda,
    subscriptionAuthorityAddress: replacement.subscriptionAuthorityAddress,
    authorizationSignature: replacement.authorizationSignature,
    oldCancelSignature,
    currentPeriodStartAt: finalizedAt,
    nextCollectionDueAt: safeNextDue,
    createdBy: input.createdBy,
    idempotency: input.idempotency,
  });
}

/**
 * Fails an update whose unwinding step cannot land, in one transaction: fences the step's slot (a
 * dropped signature is cleared while the slot still holds it; otherwise the slot must still be
 * empty), fails the attempt (its stage stays where the
 * run left it), and moves the schedule from `updating` back to `active` with the activator it had.
 * Both writes are fenced to this run: the attempt must still be `processing`, and the schedule
 * must still carry this run's claim stamp, so a stalled run never undoes a later run's re-claim.
 *
 * @param input - The run's schedule, attempt and step failure.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.claimed - The claimed schedule.
 * @param input.attempt - The run's attempt.
 * @param input.stepFailure - The step failure.
 * @throws AppError CONFLICT when the slot fence fails, the attempt is no longer `processing`, or
 *   the schedule left this run's claim; the transaction rolls back and the
 *   attempt stays in flight.
 */
async function failRecurringPaymentUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  claimed: PaymentRecurringPaymentRow;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  stepFailure: RecurringPaymentStepFailedError;
}): Promise<void> {
  const failedAt = new Date().toISOString();
  await getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    await fenceRecurringPaymentStepFailure({
      recurringRepo,
      attemptId: input.attempt.id,
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      stepFailure: input.stepFailure,
      updatedAt: failedAt,
    });
    requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: input.attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "failed",
        error: recurringPaymentErrorMessage(input.stepFailure.failure),
        expectedStatus: "processing",
        updatedAt: failedAt,
      })
    );
    const updatedRecurringPayment = await recurringRepo.updateRecurringPayment({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "active",
      expectedStatus: "updating",
      expectedUpdatedAt: input.claimed.updated_at,
      updatedAt: failedAt,
    });
    if (updatedRecurringPayment === null) {
      throw conflict("Recurring payment update changed concurrently");
    }
    // The new terms never took effect, so neither does the hand-over.
    if (input.attempt.previous_activator !== null) {
      await recurringRepo.restoreRecurringPaymentActivator({
        recurringPaymentId: input.claimed.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        activator: input.attempt.previous_activator,
      });
    }
  });
}

async function claimSourceChangingRecurringPaymentUpdate(input: {
  db: DatabaseExecutor;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  sourceWallet: RecurringPaymentSourceWallet;
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
 * Admits a fresh update that will sign, before its claim, for every wallet it
 * signs with: the source and, when the source changes, the new one, since the
 * caller must be able to sign with the wallet it moves the mandate away from as
 * well. A recovered update is never admitted here: its saved steps are read
 * first, the lazy step signer resolves the wallet only when a step needs a new
 * send, and the signing waist decides each signature (HOO-2099), so a wallet
 * that can no longer sign still finishes what landed.
 */
async function admitUpdateExecution(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  walletIds: readonly string[];
  admitStart: (custodyWalletId: string) => Promise<void>;
}): Promise<void> {
  for (const walletId of input.walletIds) {
    await input.admitStart(walletId);
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
  sourceWallet: RecurringPaymentSourceWallet;
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
  sourceWallet: RecurringPaymentSourceWallet;
  nextSourceWallet?: RecurringPaymentSourceWallet;
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
  if (requiresRuntimeExecution && !recoveringStaleUpdate) {
    await admitUpdateExecution({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      walletIds: sourceChanged
        ? [input.sourceWallet.id, resolved.sourceWallet.id]
        : [input.sourceWallet.id],
      admitStart: input.admitStart,
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

  return runClaimedRecurringPaymentUpdate({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    claimed: claimResult.claimed,
    attempt: claimResult.attempt,
    subscription: settled.subscription,
    mode,
    resolved,
    requestedNextCollectionDueAt: input.request.nextCollectionDueAt,
    createdBy: input.createdBy,
    idempotency: input.idempotency,
    startsAllowed: true,
  });
}

/**
 * Runs a claimed update's steps from its attempt and settles the run. An unwinding step that
 * cannot land fails the update back to `active` on its old terms in one transaction; any other
 * error leaves the attempt in flight and records only the error, so a concurrent finalize is
 * never flipped back.
 *
 * @param input - The claimed schedule, its attempt and the update's resolved terms.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.sourceWallet - The schedule's source wallet before the update.
 * @param input.claimed - The claimed schedule.
 * @param input.attempt - The claim's in-flight attempt.
 * @param input.subscription - The schedule's subscription as collection recovery read it, or null.
 * @param input.mode - The attempt's mode.
 * @param input.resolved - The update's resolved terms.
 * @param input.requestedNextCollectionDueAt - The next due date the update asks for, null for the
 *   next period, or undefined when it asks for none.
 * @param input.createdBy - Who the update's journal names.
 * @param input.idempotency - The request's key and fingerprint; null for the cron.
 * @param input.startsAllowed - False for the cron, which sends no new update step.
 * @returns The schedule after the update.
 */
async function runClaimedRecurringPaymentUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
  claimed: PaymentRecurringPaymentRow;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  subscription: PaymentSubscriptionRow | null;
  mode: PaymentRecurringPaymentUpdateAttemptMode;
  resolved: ResolvedRecurringPaymentUpdate;
  requestedNextCollectionDueAt: string | null | undefined;
  createdBy: string | null;
  idempotency: RecurringPaymentUpdateIdempotency | null;
  startsAllowed: boolean;
}): Promise<PaymentRecurringPaymentRow> {
  const { attempt, claimed } = input;
  try {
    switch (input.mode) {
      case "metadata_schedule":
        return await runMetadataScheduleUpdate({
          env: input.env,
          organizationId: input.organizationId,
          projectId: input.projectId,
          sourceWallet: input.sourceWallet,
          claimed,
          subscription: input.subscription,
          attempt,
          resolved: input.resolved,
          requestedNextCollectionDueAt: input.requestedNextCollectionDueAt,
          createdBy: input.createdBy,
          idempotency: input.idempotency,
          startsAllowed: input.startsAllowed,
        });
      case "replacement":
        return await runReplacementUpdate({
          env: input.env,
          organizationId: input.organizationId,
          projectId: input.projectId,
          oldSourceWallet: input.sourceWallet,
          claimed,
          subscription: input.subscription,
          attempt,
          resolved: input.resolved,
          requestedNextCollectionDueAt: input.requestedNextCollectionDueAt,
          createdBy: input.createdBy,
          idempotency: input.idempotency,
          startsAllowed: input.startsAllowed,
        });
      default:
        return assertNever(input.mode);
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const stepFailure = error instanceof RecurringPaymentStepFailedError ? error : null;
    getLogger().error(
      {
        err: stepFailure === null ? error : stepFailure.failure,
        organization_id: input.organizationId,
        project_id: input.projectId,
        recurring_payment_id: claimed.id,
        attempt_id: attempt.id,
      },
      "Recurring payment update failed"
    );
    if (stepFailure !== null) {
      await failRecurringPaymentUpdate({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        claimed,
        attempt,
        stepFailure,
      });
      throw stepFailure.failure;
    }
    await journalInFlightRecurringPaymentAttempt({
      write: () =>
        createPaymentRecurringPaymentsRepository(
          input.env,
          createTenantScope(input)
        ).updateUpdateAttempt({
          attemptId: attempt.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          error: recurringPaymentErrorMessage(error),
          expectedStatus: "processing",
          updatedAt: new Date().toISOString(),
        }),
      logContext: { recurring_payment_id: claimed.id, attempt_id: attempt.id },
    });

    throw error;
  }
}

const savedUpdateChangedFieldsSchema = z.array(z.enum(RECURRING_PAYMENT_UPDATE_FIELDS));

/**
 * The source wallet a resumed update ends on. An update that keeps its source signs with the
 * schedule's pin. One that moves it signs with the new wallet its replacement plan was created
 * for: the plan row, written before the plan's send, records that wallet's provider id and
 * address. With no plan row recorded, no step of the update was ever sent.
 *
 * @param input - The schedule's pin, the attempt and its saved terms.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.sourceWallet - The schedule's source wallet pin.
 * @param input.attempt - The resumed attempt.
 * @param input.after - The attempt's saved new terms.
 * @returns The wallet, or null when the update moves its source and never reached its plan.
 * @throws AppError INTERNAL_ERROR when the attempt's new source is inconsistent or its plan row is
 *   missing.
 */
async function resumedUpdateSourceWallet(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  after: RecurringPaymentUpdateSnapshot;
}): Promise<RecurringPaymentSourceWallet | null> {
  const nextSourceCustodyWalletId = input.after.sourceCustodyWalletId;
  if (nextSourceCustodyWalletId === input.sourceWallet.id) {
    return input.sourceWallet;
  }
  if (
    nextSourceCustodyWalletId === null ||
    input.attempt.new_source_custody_wallet_id !== nextSourceCustodyWalletId
  ) {
    throw internalError("Recurring payment update attempt names an inconsistent source wallet");
  }
  if (input.attempt.new_plan_id === null) {
    return null;
  }
  const plan = await createPaymentSubscriptionsRepository(
    input.env,
    createTenantScope(input)
  ).getPlanById({
    planId: input.attempt.new_plan_id,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (plan === null) {
    throw internalError("Recurring payment replacement plan was not found");
  }
  return {
    id: nextSourceCustodyWalletId,
    walletId: plan.owner_wallet_id,
    publicKey: plan.owner_address,
  };
}

/**
 * Resumes a stale `updating` schedule for the cron, from the attempt its first claim opened. The
 * claim takes the schedule while it is still stale (`updating`, unchanged for the stale window),
 * so the cron and a stale same-key PATCH race safely: the first claimant runs and the other gets
 * a 409. The attempt is read in the same transaction; an `updating` schedule always has one in
 * flight (its claim opened it), so none means this claim took a schedule another run finished,
 * and the claim rolls back. A fresh attempt is never opened.
 *
 * The run uses the attempt's saved terms and creator, with no idempotency key, and starts no
 * update send (the cron's mandate admits no `recurring.update`): landed steps finish, a pending
 * step keeps the attempt in flight, a dropped one unwinds, an unsent one fails the update back to
 * `active` on its old terms with an error log, and the old subscription's cancel (an exit) is
 * still sent. A changed destination is resolved again from its counterparty account.
 *
 * @param input - The stale schedule and its source wallet pin.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.sourceWallet - The schedule's source wallet pin.
 * @param input.recurringPayment - The stale `updating` schedule as listed.
 * @returns The schedule once the update finished.
 * @throws AppError CONFLICT when another run holds or finished the update, a step is pending, or
 *   an unsent or failed step failed the update back to `active`.
 */
export async function resumeRecurringPaymentUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
  recurringPayment: PaymentRecurringPaymentRow;
}): Promise<PaymentRecurringPaymentRow> {
  if (!isUpdatingRecurringPaymentStatus(input.recurringPayment.status)) {
    throw internalError(
      `Recurring payment update cannot resume from ${input.recurringPayment.status}`
    );
  }
  assertRecurringPaymentSourceWallet(input.recurringPayment, input.sourceWallet);
  const settled = await recoverOrBlockLifecycleCollection({
    env: input.env,
    recurringRepo: createPaymentRecurringPaymentsRepository(input.env, createTenantScope(input)),
    subscriptionsRepo: createPaymentSubscriptionsRepository(input.env, createTenantScope(input)),
    paymentsRepo: createPaymentsRepository(input.env, createTenantScope(input)),
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: input.recurringPayment,
  });

  const nowIso = new Date().toISOString();
  const claimResult = await getDb(input.env).transaction(async (tx) => {
    const transactionRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const claimed = await transactionRepo.claimRecurringPaymentUpdate({
      recurringPaymentId: settled.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      updatedAt: nowIso,
      staleBefore: getRecurringPaymentOperationStaleBefore(nowIso),
      activatedBy: null,
    });
    if (!claimed) return null;
    const attempt = await transactionRepo.getLatestUpdateAttempt({
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: claimed.id,
      statuses: IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
    });
    if (!attempt) {
      throw conflict("Recurring payment update finished before it was resumed");
    }
    return { claimed, attempt };
  });
  if (!claimResult) {
    throw conflict("Recurring payment update is already processing");
  }
  const { claimed, attempt } = claimResult;

  const before = recurringPaymentUpdateSnapshotSchema.parse(attempt.before_values);
  const after = recurringPaymentUpdateSnapshotSchema.parse(attempt.after_values);
  const changedFields = savedUpdateChangedFieldsSchema.parse(attempt.changed_fields);
  const sourceWallet = await resumedUpdateSourceWallet({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    attempt,
    after,
  });
  if (sourceWallet === null) {
    const stepFailure = new RecurringPaymentStepFailedError({
      failure: refuseCronUpdateStepSend({
        recurring_payment_id: claimed.id,
        attempt_id: attempt.id,
      }),
      slot: { row: "update_attempt", column: "plan_creation_signature" },
      droppedSignature: null,
    });
    await failRecurringPaymentUpdate({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      claimed,
      attempt,
      stepFailure,
    });
    throw stepFailure.failure;
  }
  const accountChanged =
    after.counterpartyId !== claimed.counterparty_id ||
    after.counterpartyAccountId !== claimed.counterparty_account_id;
  const destinationAddress = accountChanged
    ? (
        await resolveSolanaCounterpartyAccount({
          env: input.env,
          organizationId: input.organizationId,
          projectId: input.projectId,
          counterpartyId: after.counterpartyId,
          counterpartyAccountId: after.counterpartyAccountId,
        })
      ).destinationAddress
    : claimed.destination_address;

  return runClaimedRecurringPaymentUpdate({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    claimed,
    attempt,
    subscription: settled.subscription,
    mode: attempt.mode,
    resolved: {
      sourceWallet,
      counterpartyId: after.counterpartyId,
      counterpartyAccountId: after.counterpartyAccountId,
      destinationAddress,
      token: after.token,
      amount: after.amount,
      periodHours: after.periodHours,
      firstCollectionAt: after.firstCollectionAt,
      nextCollectionDueAt: after.nextCollectionDueAt,
      metadataUri: after.metadataUri,
      changedFields,
      beforeValues: before,
      afterValues: after,
    },
    requestedNextCollectionDueAt: changedFields.includes("nextCollectionDueAt")
      ? after.nextCollectionDueAt
      : undefined,
    createdBy: attempt.created_by,
    idempotency: null,
    startsAllowed: false,
  });
}
