import {
  decideRecurringPaymentUpdateTransition,
  generateProgramPlanId,
  getRecurringPaymentOperationStaleBefore,
  resolveRecurringPaymentCollectionSchedule,
} from "@sdp/payments/recurring-payment-lifecycle";
import * as solanaRpc from "@sdp/rpc/solana";
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
  recurringPaymentInFlightLifecycleOperation,
  recurringPaymentPolicyPayloadSchema,
  type UpdatePaymentRecurringPaymentRequest,
  type WalletOperationActor,
} from "@sdp/types";
import {
  type Address,
  createNoopSigner,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token-2022";
import { type DatabaseExecutor, getDb } from "@/db";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
  createPostgresPaymentRecurringPaymentsRepository,
  createPostgresPaymentSubscriptionsRepository,
  type PaymentRecurringPaymentRow,
  type PaymentRecurringPaymentsRepository,
  type PaymentRecurringPaymentUpdateAttemptMode,
  type PaymentRecurringPaymentUpdateAttemptRow,
  type PaymentSubscriptionPlanRow,
  type PaymentSubscriptionRow,
  type PaymentSubscriptionsRepository,
} from "@/db/repositories";
import {
  AppError,
  badRequest,
  conflict,
  internalError,
  notFound,
  transactionFailed,
} from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import {
  resolveMintTokenProgram,
  resolveSourceTokenAccountOrAta,
} from "@/routes/payments/token-accounts";
import { getLogger } from "@/runtime/logger";
import { createSigningService } from "@/services/domain/signing.service";
import { parseU64String } from "@/services/payment-operation.service";
import * as solanaServices from "@/services/solana";
import { createProjectSponsorshipFeePayment } from "@/services/sponsorship.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { resolveSolanaCounterpartyAccount } from "../counterparty-account-resolution";
import { recoverOrBlockLifecycleCollection } from "./collection";
import {
  assertNoPendingRecurringCollectionApproval,
  enforceRecurringPaymentPolicy,
} from "./policy";
import {
  assertRecurringPaymentSourceWallet,
  assertRecurringPaymentTokenMint,
  confirmSubscriptionSignature,
  parseNullableStoredSignature,
  recurringPaymentErrorMessage,
  requireUpdatedAttempt,
  requireUpdatedPlan,
  requireUpdatedSubscription,
  sendSubscriptionInstructions,
  subscriptionProgramMetadataUri,
} from "./shared";

type RecurringPaymentUpdateSnapshot = {
  sourceCustodyWalletId: string | null;
  counterpartyId: string;
  counterpartyAccountId: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt: string | null;
  nextCollectionDueAt: string | null;
  metadataUri: string | null;
};

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
  beforeValues: Record<string, unknown>;
  afterValues: Record<string, unknown>;
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
  const changedFields = RECURRING_PAYMENT_UPDATE_FIELDS.filter(
    (field) => before[field] !== after[field]
  );
  const beforeValues: Partial<RecurringPaymentUpdateSnapshot> = { ...before };
  const afterValues: Partial<RecurringPaymentUpdateSnapshot> = { ...after };

  return { changedFields, beforeValues, afterValues };
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sameFlatRecord(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = Object.keys(left);
  return sameStringSet(keys, Object.keys(right)) && keys.every((key) => left[key] === right[key]);
}

function updateAttemptMatchesRequest(
  attempt: PaymentRecurringPaymentUpdateAttemptRow,
  input: {
    changedFields: string[];
    beforeValues: Record<string, unknown>;
    afterValues: Record<string, unknown>;
  }
): boolean {
  return (
    sameStringSet(attempt.changed_fields, input.changedFields) &&
    sameFlatRecord(attempt.before_values, input.beforeValues) &&
    sameFlatRecord(attempt.after_values, input.afterValues)
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
  apiKeyId: string | null;
  actor: WalletOperationActor | null;
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

async function enforceResolvedRecurringPaymentUpdatePolicy(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  resolved: ResolvedRecurringPaymentUpdate;
  apiKeyId: string | null;
  actor: WalletOperationActor | null;
}): Promise<void> {
  await enforceRecurringPaymentPolicy({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.resolved.sourceWallet,
    token: input.resolved.token,
    amount: input.resolved.amount,
    destination: input.resolved.destinationAddress,
    apiKeyId: input.apiKeyId,
    actor: input.actor,
    rawPayload: recurringPaymentPolicyPayloadSchema.parse({
      operationType: "recurring_payment_update",
      recurringPaymentId: input.recurringPaymentId,
      counterpartyId: input.resolved.counterpartyId,
      counterpartyAccountId: input.resolved.counterpartyAccountId,
      periodHours: input.resolved.periodHours,
    }),
  });
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

async function updatePendingRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  resolved: ResolvedRecurringPaymentUpdate;
  createdBy: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  if (input.resolved.changedFields.length === 0) {
    return input.recurringPayment;
  }

  const changedDestinationOrToken =
    input.resolved.destinationAddress !== input.recurringPayment.destination_address ||
    input.resolved.token !== input.recurringPayment.token;
  const updatedAt = new Date().toISOString();
  const recurringRepo = createPaymentRecurringPaymentsRepository(
    input.env,
    createTenantScope(input)
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

  await recordRecurringPaymentUpdateEvent({
    recurringRepo,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPayment.id,
    attemptId: null,
    changedFields: input.resolved.changedFields.map(String),
    beforeValues: input.resolved.beforeValues,
    afterValues: input.resolved.afterValues,
    createdBy: input.createdBy,
    createdAt: updatedAt,
  });

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
}): Promise<PaymentRecurringPaymentUpdateAttemptRow> {
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
}): Promise<PaymentRecurringPaymentRow> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(
    input.env,
    createTenantScope(input)
  );
  const rpc = solanaRpc.createRpc(input.env);
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
    const sourceSigner = await solanaServices.createOrgSignerForCustodyWallet(
      input.env,
      input.organizationId,
      input.projectId,
      input.sourceWallet.id
    );
    if (sourceSigner.address !== input.sourceWallet.publicKey) {
      throw badRequest("Resolved signing wallet does not match source wallet");
    }

    if (!planUpdateSignature) {
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
        expectedCreatedAt: onChainPlan.data.data.terms.createdAt,
        expectedEndTs: onChainPlan.data.data.endTs,
        expectedMetadataUri: onChainPlan.data.data.metadataUri,
        expectedPullers: onChainPlan.data.data.pullers,
        metadataUri: subscriptionProgramMetadataUri(input.resolved.metadataUri),
        owner: sourceSigner,
        planPda,
        pullers: onChainPlan.data.data.pullers,
        status: parsePlanStatus(onChainPlan.data.status),
      });
      planUpdateSignature = await sendSubscriptionInstructions({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWallet: input.sourceWallet,
        sourceSigner,
        instructions: [instruction],
      });
      attempt = requireUpdatedAttempt(
        await recurringRepo.updateUpdateAttempt({
          attemptId: attempt.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          planUpdateSignature,
          updatedAt: new Date().toISOString(),
        })
      );
    }

    await confirmSubscriptionSignature(
      input.env,
      planUpdateSignature,
      "Recurring payment update failed on-chain"
    );
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
  });
}

async function prepareSubscriptionAuthorityForUpdate(input: {
  env: Env;
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  organizationId: string;
  projectId: string;
  rpc: ReturnType<typeof solanaRpc.createRpc>;
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
  });
  await input.recurringRepo.updateUpdateAttempt({
    attemptId: input.attempt.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    authorizationSetupSignature: initSignature,
    updatedAt: new Date().toISOString(),
  });
  await confirmSubscriptionSignature(
    input.env,
    initSignature,
    "Recurring payment update failed on-chain"
  );

  if (!initAuthorityInstruction) {
    return input.subscriptionAuthority;
  }

  const subscriptionAuthority = await subscriptionsProgram.fetchMaybeSubscriptionAuthority(
    input.rpc,
    input.subscriptionAuthorityAddress,
    { commitment: "confirmed" }
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
  planCreationSignature: Signature;
  subscriptionPda: Address;
  subscriptionAuthorityAddress: Address;
  authorizationSignature: Signature;
  oldCancelSignature: Signature;
  currentPeriodStartAt: string;
  nextCollectionDueAt: string;
  createdBy: string | null;
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
  const rpc = solanaRpc.createRpc(input.env);
  let attempt = input.attempt;
  let planCreationSignature = parseNullableStoredSignature(attempt.plan_creation_signature);
  let authorizationSignature = parseNullableStoredSignature(attempt.authorization_signature);
  let oldCancelSignature = parseNullableStoredSignature(attempt.old_cancel_signature);
  const replacementPeriodStartAt = attempt.created_at;
  const requestedNextDue = replacementNextCollectionDueAt({
    requested: input.request.nextCollectionDueAt,
    periodStartAt: replacementPeriodStartAt,
    periodHours: input.resolved.periodHours,
    clampToMinimum: Boolean(planCreationSignature || authorizationSignature || oldCancelSignature),
  });

  const sourceSigner = await solanaServices.createOrgSignerForCustodyWallet(
    input.env,
    input.organizationId,
    input.projectId,
    input.resolved.sourceWallet.id
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

  if (!planCreationSignature) {
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
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.resolved.sourceWallet,
      sourceSigner,
      instructions: [createPlanInstruction],
    });
    attempt = requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planCreationSignature,
        updatedAt: new Date().toISOString(),
      })
    );
  }

  await confirmSubscriptionSignature(
    input.env,
    planCreationSignature,
    "Recurring payment replacement plan creation failed on-chain"
  );
  const onChainPlan = await subscriptionsProgram.fetchMaybePlan(rpc, planPda, {
    commitment: "confirmed",
  });
  if (!onChainPlan.exists) {
    throw transactionFailed("Subscription plan was not found on-chain");
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

  if (!authorizationSignature) {
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
    const feePayment = await createProjectSponsorshipFeePayment(input.env, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      actor: { type: "wallet", id: input.resolved.sourceWallet.walletId },
    });
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
      throw transactionFailed("Subscription authority was not found on-chain");
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
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.resolved.sourceWallet,
      sourceSigner,
      instructions: [subscribeInstruction],
      feePayer,
    });
    attempt = requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        authorizationSignature,
        updatedAt: new Date().toISOString(),
      })
    );
  }

  await confirmSubscriptionSignature(
    input.env,
    authorizationSignature,
    "Recurring payment replacement authorization failed on-chain"
  );

  if (!oldCancelSignature) {
    attempt = requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: "cancel_old_subscription",
        updatedAt: new Date().toISOString(),
      })
    );
    const oldSourceSigner = await solanaServices.createOrgSignerForCustodyWallet(
      input.env,
      input.organizationId,
      input.projectId,
      input.oldSourceWallet.id
    );
    if (oldSourceSigner.address !== input.oldSourceWallet.publicKey) {
      throw badRequest("Resolved signing wallet does not match source wallet");
    }
    const cancelInstruction =
      await subscriptionsProgram.getCancelSubscriptionOverlayInstructionAsync({
        planPda: assertValidAddress(input.claimed.plan_pda, "planPda"),
        subscriber: oldSourceSigner,
        subscriptionPda: assertValidAddress(input.claimed.subscription_pda, "subscriptionPda"),
      });
    oldCancelSignature = await sendSubscriptionInstructions({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.oldSourceWallet,
      sourceSigner: oldSourceSigner,
      instructions: [cancelInstruction],
    });
    attempt = requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        oldCancelSignature,
        updatedAt: new Date().toISOString(),
      })
    );
  }

  await confirmSubscriptionSignature(
    input.env,
    oldCancelSignature,
    "Recurring payment old subscription cancellation failed on-chain"
  );

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

  await assertNoPendingRecurringCollectionApproval({
    db: input.db,
    organizationId: input.organizationId,
    projectId: input.projectId,
    custodyWalletId: input.sourceWallet.id,
    recurringPaymentId: input.recurringPayment.id,
    collectionDueAt: input.recurringPayment.next_collection_due_at,
  });

  return createPostgresPaymentRecurringPaymentsRepository(input.db).claimRecurringPaymentUpdate({
    recurringPaymentId: input.recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    updatedAt: input.updatedAt,
    staleBefore: input.staleBefore,
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
  apiKeyId: string | null;
  actor: WalletOperationActor | null;
}): Promise<PaymentRecurringPaymentRow> {
  assertRecurringPaymentSourceWallet(input.recurringPayment, input.sourceWallet);

  const nowIso = new Date().toISOString();
  assertRecurringPaymentUpdateStatus(input.recurringPayment, nowIso);

  if (isPendingActivationRecurringPaymentStatus(input.recurringPayment.status)) {
    if (input.request.nextCollectionDueAt !== undefined) {
      throw badRequest("nextCollectionDueAt can only be updated after activation");
    }
    const resolved = await resolveRecurringPaymentUpdate(input);
    await enforceResolvedRecurringPaymentUpdatePolicy({
      ...input,
      recurringPaymentId: input.recurringPayment.id,
      resolved,
    });
    return updatePendingRecurringPayment({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: input.recurringPayment,
      resolved,
      createdBy: input.createdBy,
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
  if (sourceChanged) {
    await assertNoPendingRecurringCollectionApproval({
      db: getDb(input.env),
      organizationId: input.organizationId,
      projectId: input.projectId,
      custodyWalletId: input.sourceWallet.id,
      recurringPaymentId: settled.recurringPayment.id,
      collectionDueAt: settled.recurringPayment.next_collection_due_at,
    });
  }

  const mode = requestedActiveUpdateMode(resolved.changedFields);
  const requiresRuntimeExecution =
    mode === "replacement" || resolved.metadataUri !== settled.recurringPayment.metadata_uri;
  if (requiresRuntimeExecution) {
    const signingService = createSigningService(input.env);
    await signingService.admitRuntimeExecution(
      input.organizationId,
      input.projectId,
      input.sourceWallet.id
    );
    if (sourceChanged) {
      await signingService.admitRuntimeExecution(
        input.organizationId,
        input.projectId,
        resolved.sourceWallet.id
      );
    }
  }

  await enforceResolvedRecurringPaymentUpdatePolicy({
    ...input,
    recurringPaymentId: settled.recurringPayment.id,
    resolved,
  });
  if (resolved.changedFields.length === 0) {
    return settled.recurringPayment;
  }

  const recoveringStaleUpdate = isUpdatingRecurringPaymentStatus(settled.recurringPayment.status);
  const claimUpdatedAt = new Date().toISOString();
  const staleBefore = getRecurringPaymentOperationStaleBefore(nowIso);
  const claimResult = await getDb(input.env).transaction(async (tx) => {
    const transactionRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const claimed = sourceChanged
      ? await claimSourceChangingRecurringPaymentUpdate({
          db: tx,
          organizationId: input.organizationId,
          projectId: input.projectId,
          recurringPayment: settled.recurringPayment,
          sourceWallet: input.sourceWallet,
          updatedAt: claimUpdatedAt,
          staleBefore,
        })
      : await transactionRepo.claimRecurringPaymentUpdate({
          recurringPaymentId: settled.recurringPayment.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          updatedAt: claimUpdatedAt,
          staleBefore,
        });
    if (!claimed) return null;
    const attempt = await getOrCreateRecurringPaymentUpdateAttempt({
      recurringRepo: transactionRepo,
      claimed,
      organizationId: input.organizationId,
      projectId: input.projectId,
      mode,
      changedFields: resolved.changedFields.map(String),
      beforeValues: resolved.beforeValues,
      afterValues: resolved.afterValues,
      newSourceCustodyWalletId: sourceChanged ? resolved.sourceWallet.id : null,
      createdBy: input.createdBy,
      nowIso,
      recoveringStaleUpdate,
    });
    return { claimed, attempt };
  });
  if (!claimResult) {
    throw conflict("Recurring payment update is already processing");
  }
  const { attempt, claimed } = claimResult;

  try {
    if (mode === "metadata_schedule") {
      return await runMetadataScheduleUpdate({
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
      });
    }

    return await runReplacementUpdate({
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
    });
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
      resetToActive =
        !hasReplacementAuthorization && (!hasSubmittedMetadataUpdate || transactionFailed);

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
}
