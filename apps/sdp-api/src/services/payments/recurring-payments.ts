import { type DatabaseExecutor, getDb } from "@/db";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
  createPostgresPaymentRecurringPaymentsRepository,
  createPostgresPaymentSubscriptionsRepository,
  createPostgresPaymentsRepository,
} from "@/db/repositories";
import type { PaymentRecurringPaymentRow } from "@/db/repositories/payment-recurring-payments.repository";
import type {
  PaymentSubscriptionCollectionAttemptRow,
  PaymentSubscriptionPlanRow,
  PaymentSubscriptionRow,
} from "@/db/repositories/payment-subscriptions.repository";
import type {
  PaymentsRepository,
  PaymentTransferRow,
  PaymentTransferStatus,
} from "@/db/repositories/payments.repository";
import { parsePositiveIntegerConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { assertValidAddress } from "@/lib/solana";
import { createSigningService } from "@/services/domain/signing.service";
import { assertWalletPolicyAllowsTransferWithRepository } from "@/services/payments/wallet-policy";
import * as solanaServices from "@/services/solana";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { resolveSolanaCounterpartyAccount } from "./counterparty-account-resolution";
import {
  assertSubscriptionTokenMint,
  collectSubscriptionOnChain,
  deriveAssociatedTokenAccount,
  type ExecutedSubscriptionTransaction,
  ensureSubscriptionAuthorizationOnChain,
  ensureSubscriptionPlanOnChain,
  executeSubscriptionLifecycleOnChain,
  generateProgramPlanId,
  isImmediateRecurringSubscriptionRetryError,
  isSubscriptionLifecycleTargetReachedOnChain,
  readSubscriptionLifecycleStateOnChain,
  resolveRecurringSubscriptionRuntime,
  type SubmittedSubscriptionTransaction,
} from "./solana-subscriptions-adapter";

export type ActivationResult = {
  recurringPayment: PaymentRecurringPaymentRow;
  planSignature?: string;
  authorizationSignature?: string;
};

export type CollectionResult = {
  recurringPayment: PaymentRecurringPaymentRow;
  collectionAttempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
};

function addPeriodHours(timestamp: string, periodHours: number): string {
  return new Date(new Date(timestamp).getTime() + periodHours * 60 * 60 * 1000).toISOString();
}

function advanceCollectionDueAtAfter(input: {
  nextCollectionDueAt: string | null;
  periodHours: number;
  after: string;
}): string {
  const periodMs = input.periodHours * 60 * 60 * 1000;
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    throw new AppError("BAD_REQUEST", "Recurring payment period must be greater than zero");
  }

  const afterMs = new Date(input.after).getTime();
  const dueMs = input.nextCollectionDueAt ? new Date(input.nextCollectionDueAt).getTime() : NaN;

  if (input.nextCollectionDueAt && Number.isFinite(dueMs) && dueMs > afterMs) {
    return input.nextCollectionDueAt;
  }

  if (Number.isFinite(dueMs)) {
    const elapsedPeriods = Math.floor((afterMs - dueMs) / periodMs) + 1;
    return new Date(dueMs + elapsedPeriods * periodMs).toISOString();
  }

  return new Date(afterMs + periodMs).toISOString();
}

const ACTIVATION_CLAIM_TTL_MS = 10 * 60 * 1000;
const LIFECYCLE_CLAIM_TTL_MS = 10 * 60 * 1000;
const ACTIVE_COLLECTION_ATTEMPT_STATUSES = new Set(["pending", "processing", "confirmed"]);
const DEFAULT_COLLECTION_RETRY_AFTER_MINUTES = 30;

function getCollectionRetryAfter(env: Env, now = new Date()): string {
  const retryAfterMinutes = parsePositiveIntegerConfig(
    env.PAYMENTS_RECURRING_COLLECTION_RETRY_AFTER_MINUTES,
    DEFAULT_COLLECTION_RETRY_AFTER_MINUTES
  );

  return new Date(now.getTime() - retryAfterMinutes * 60 * 1000).toISOString();
}

function isFreshActivationClaim(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() < ACTIVATION_CLAIM_TTL_MS;
}

function isFreshLifecycleClaim(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() < LIFECYCLE_CLAIM_TTL_MS;
}

type RecurringLifecycleOperation = "cancel" | "resume";
type RecurringOperation = RecurringLifecycleOperation | "collect";
type RecurringLifecycleClaimStatus = Extract<
  PaymentRecurringPaymentRow["status"],
  "canceling" | "resuming"
>;
type RecurringOperationAttemptClaim = {
  id: string;
  operation: RecurringOperation;
  status: "processing" | "submitted";
  signature: string | null;
  slot: number | null;
  block_time: string | null;
  updated_at: string;
};

function getLifecycleClaimStatus(
  operation: RecurringLifecycleOperation
): RecurringLifecycleClaimStatus {
  return operation === "cancel" ? "canceling" : "resuming";
}

function getLifecycleTargetStatus(
  operation: RecurringLifecycleOperation
): Extract<PaymentRecurringPaymentRow["status"], "active" | "canceled"> {
  return operation === "cancel" ? "canceled" : "active";
}

function isLifecycleClaimStatus(
  status: PaymentRecurringPaymentRow["status"]
): status is RecurringLifecycleClaimStatus {
  return status === "canceling" || status === "resuming";
}

function isRecurringPaymentLifecycleFinalized(input: {
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  operation: RecurringLifecycleOperation;
}): boolean {
  const targetStatus = getLifecycleTargetStatus(input.operation);
  if (
    input.recurringPayment.status !== targetStatus ||
    input.subscription.status !== targetStatus
  ) {
    return false;
  }

  if (input.operation === "cancel") {
    return input.subscription.canceled_at !== null;
  }

  return (
    input.subscription.canceled_at === null &&
    input.recurringPayment.next_collection_due_at !== null &&
    input.recurringPayment.next_collection_due_at === input.subscription.next_collection_due_at
  );
}

function isRecurringPaymentLifecycleClaimStillFinalizable(input: {
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  operation: RecurringLifecycleOperation;
}): boolean {
  const claimStatus = getLifecycleClaimStatus(input.operation);
  if (
    input.recurringPayment.status !== claimStatus ||
    input.recurringPayment.next_collection_due_at !== input.subscription.next_collection_due_at
  ) {
    return false;
  }

  return input.operation === "cancel"
    ? input.subscription.status === "canceling"
    : input.subscription.status === "canceled" || input.subscription.status === "paused";
}

function assertRecurringPaymentCanClaimLifecycle(input: {
  recurringPayment: PaymentRecurringPaymentRow;
  operation: RecurringLifecycleOperation;
  claimStatus: RecurringLifecycleClaimStatus;
}) {
  const { recurringPayment, operation, claimStatus } = input;
  if (
    !recurringPayment.subscription_id ||
    !recurringPayment.plan_pda ||
    !recurringPayment.subscription_pda
  ) {
    throw new AppError("BAD_REQUEST", "Recurring payment has not been activated");
  }

  if (isLifecycleClaimStatus(recurringPayment.status)) {
    if (
      recurringPayment.status !== claimStatus &&
      isFreshLifecycleClaim(recurringPayment.updated_at)
    ) {
      throw new AppError("CONFLICT", "Recurring payment lifecycle update is already in progress");
    }
    return;
  }

  if (
    operation === "cancel" &&
    recurringPayment.status !== "active" &&
    recurringPayment.status !== "paused"
  ) {
    throw new AppError("BAD_REQUEST", "Only active or paused recurring payments can be canceled");
  }
  if (
    operation === "resume" &&
    recurringPayment.status !== "canceled" &&
    recurringPayment.status !== "paused"
  ) {
    throw new AppError("BAD_REQUEST", "Only canceled or paused recurring payments can be resumed");
  }
}

function assertSubscriptionCanClaimLifecycle(input: {
  subscription: PaymentSubscriptionRow;
  operation: RecurringLifecycleOperation;
}) {
  const { subscription, operation } = input;
  if (
    operation === "cancel" &&
    subscription.status !== "active" &&
    subscription.status !== "paused" &&
    subscription.status !== "canceling"
  ) {
    throw new AppError("CONFLICT", "Recurring payment subscription cannot be canceled");
  }
  if (
    operation === "resume" &&
    subscription.status !== "canceled" &&
    subscription.status !== "paused"
  ) {
    throw new AppError("CONFLICT", "Recurring payment subscription cannot be resumed");
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function markRecurringLifecycleAttemptSubmitted(input: {
  env: Env;
  attemptId: string;
  executed: ExecutedSubscriptionTransaction | null;
}) {
  const now = new Date().toISOString();
  await getDb(input.env)
    .prepare(
      `UPDATE payment_recurring_operation_attempts
          SET status = 'submitted',
              signature = CASE WHEN ?::boolean THEN ? ELSE signature END,
              slot = CASE WHEN ?::boolean THEN ? ELSE slot END,
              block_time = CASE WHEN ?::boolean THEN ? ELSE block_time END,
              error = NULL,
              updated_at = ?
        WHERE id = ?`
    )
    .bind(
      input.executed?.signature !== undefined,
      input.executed?.signature ?? null,
      input.executed?.slot !== undefined,
      input.executed?.slot ?? null,
      input.executed?.blockTime !== undefined,
      input.executed?.blockTime ?? null,
      now,
      input.attemptId
    )
    .run();
}

async function retryPersistRecurringLifecycleSubmittedMarker(input: {
  env: Env;
  recurringPaymentId: string;
  attemptId: string;
  operation: RecurringLifecycleOperation;
  submitted: SubmittedSubscriptionTransaction | null;
}) {
  if (!input.submitted) {
    return;
  }

  try {
    await markRecurringLifecycleAttemptSubmitted({
      env: input.env,
      attemptId: input.attemptId,
      executed: {
        signature: input.submitted.signature,
        slot: null,
        blockTime: null,
      },
    });
  } catch (markerError) {
    console.warn("Failed to persist recurring lifecycle submitted recovery marker", {
      recurringPaymentId: input.recurringPaymentId,
      attemptId: input.attemptId,
      operation: input.operation,
      error: toErrorMessage(markerError),
    });
  }
}

async function markRecurringLifecycleAttemptFinalized(input: { env: Env; attemptId: string }) {
  await getDb(input.env)
    .prepare(
      `UPDATE payment_recurring_operation_attempts
          SET status = 'confirmed',
              updated_at = ?
        WHERE id = ?`
    )
    .bind(new Date().toISOString(), input.attemptId)
    .run();
}

async function markActiveRecurringLifecycleAttemptsFinalized(input: {
  executor: DatabaseExecutor;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  operation: RecurringLifecycleOperation;
  updatedAt: string;
}) {
  await input.executor
    .prepare(
      `UPDATE payment_recurring_operation_attempts
          SET status = 'confirmed',
              updated_at = ?
        WHERE organization_id = ?
          AND project_id = ?
          AND recurring_payment_id = ?
          AND operation = ?
          AND status IN ('processing', 'submitted')`
    )
    .bind(
      input.updatedAt,
      input.organizationId,
      input.projectId,
      input.recurringPaymentId,
      input.operation
    )
    .run();
}

async function markRecurringLifecycleAttemptFailed(input: {
  env: Env;
  attemptId: string;
  error: string;
}) {
  await getDb(input.env)
    .prepare(
      `UPDATE payment_recurring_operation_attempts
          SET status = 'failed',
              error = ?,
              updated_at = ?
        WHERE id = ?`
    )
    .bind(input.error, new Date().toISOString(), input.attemptId)
    .run();
}

async function failActiveRecurringCollectOperationAttempt(input: {
  executor: DatabaseExecutor;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  error: string;
  updatedAt: string;
}) {
  await input.executor
    .prepare(
      `UPDATE payment_recurring_operation_attempts
          SET status = 'failed',
              error = COALESCE(error, ?),
              updated_at = ?
        WHERE organization_id = ?
          AND project_id = ?
          AND recurring_payment_id = ?
          AND operation = 'collect'
          AND status = 'processing'`
    )
    .bind(
      input.error,
      input.updatedAt,
      input.organizationId,
      input.projectId,
      input.recurringPaymentId
    )
    .run();
}

async function markActiveRecurringCollectOperationAttemptSubmitted(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  signature: string;
  slot: number | null;
  blockTime: string | null;
}): Promise<boolean> {
  const updatedAt = new Date().toISOString();
  const changes = await getDb(input.env)
    .prepare(
      `UPDATE payment_recurring_operation_attempts
          SET status = 'submitted',
              signature = ?,
              slot = CASE WHEN ?::boolean THEN ? ELSE slot END,
              block_time = CASE WHEN ?::boolean THEN ? ELSE block_time END,
              error = NULL,
              updated_at = ?
        WHERE organization_id = ?
          AND project_id = ?
          AND recurring_payment_id = ?
          AND operation = 'collect'
          AND status IN ('processing', 'submitted')`
    )
    .bind(
      input.signature,
      input.slot !== null,
      input.slot,
      input.blockTime !== null,
      input.blockTime,
      updatedAt,
      input.organizationId,
      input.projectId,
      input.recurringPaymentId
    )
    .run();

  return changes > 0;
}

async function markActiveRecurringCollectOperationAttemptFinalized(input: {
  executor: DatabaseExecutor;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  updatedAt: string;
}) {
  await input.executor
    .prepare(
      `UPDATE payment_recurring_operation_attempts
          SET status = 'confirmed',
              updated_at = ?
        WHERE organization_id = ?
          AND project_id = ?
          AND recurring_payment_id = ?
          AND operation = 'collect'
          AND status IN ('processing', 'submitted')`
    )
    .bind(input.updatedAt, input.organizationId, input.projectId, input.recurringPaymentId)
    .run();
}

async function getActiveRecurringCollectOperationAttempt(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
}): Promise<RecurringOperationAttemptClaim | null> {
  const row = await getDb(input.env)
    .prepare(
      `SELECT id, operation, status, signature, slot, block_time, updated_at
         FROM payment_recurring_operation_attempts
        WHERE organization_id = ?
          AND project_id = ?
          AND recurring_payment_id = ?
          AND operation = 'collect'
          AND status IN ('processing', 'submitted')
        ORDER BY updated_at DESC
        LIMIT 1`
    )
    .bind(input.organizationId, input.projectId, input.recurringPaymentId)
    .first<RecurringOperationAttemptClaim>();

  return row ?? null;
}

async function assertNoActiveRecurringOperationAttempt(input: {
  executor: DatabaseExecutor;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
}) {
  const activeOperationAttempt = await input.executor
    .prepare(
      `SELECT id, operation, status, signature, slot, block_time, updated_at
         FROM payment_recurring_operation_attempts
        WHERE organization_id = ?
          AND project_id = ?
          AND recurring_payment_id = ?
          AND status IN ('processing', 'submitted')
        ORDER BY updated_at DESC
        LIMIT 1
        FOR UPDATE`
    )
    .bind(input.organizationId, input.projectId, input.recurringPaymentId)
    .first<RecurringOperationAttemptClaim>();

  if (!activeOperationAttempt) {
    return;
  }

  throw new AppError(
    "CONFLICT",
    activeOperationAttempt.operation === "collect"
      ? "Recurring payment collection is already in progress"
      : "Recurring payment lifecycle update is already in progress"
  );
}

function isActiveCollectionAttempt(attempt: PaymentSubscriptionCollectionAttemptRow): boolean {
  return ACTIVE_COLLECTION_ATTEMPT_STATUSES.has(attempt.status);
}

function isStaleUnsignedProcessingAttempt(
  attempt: PaymentSubscriptionCollectionAttemptRow,
  retryAfter: string
): boolean {
  return (
    attempt.status === "processing" &&
    !attempt.signature &&
    new Date(attempt.updated_at).getTime() <= new Date(retryAfter).getTime()
  );
}

async function getSourceSigner(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWalletId: string;
  expectedAddress: string;
}) {
  const signer = await solanaServices.createOrgSigner(
    input.env,
    input.organizationId,
    input.projectId,
    input.sourceWalletId
  );

  if (signer.address !== input.expectedAddress) {
    throw new AppError("BAD_REQUEST", "Resolved signing wallet does not match source wallet");
  }

  return signer;
}

async function resolveSourceWalletForExecution(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWalletId: string;
}): Promise<CustodyWallet> {
  const signingService = createSigningService(input.env);
  const wallets = await signingService.getWalletsWithProviders(
    input.organizationId,
    input.projectId,
    { includeAllProviders: true }
  );
  const wallet = wallets.find((entry) => entry.walletId === input.sourceWalletId);

  if (!wallet) {
    throw new AppError("NOT_FOUND", "Wallet not found. Provision wallets through /v1/wallets");
  }

  return wallet;
}

async function createTransferRecord(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  status: PaymentTransferStatus;
  initiatedByKeyId?: string | null;
  paymentsRepo?: PaymentsRepository;
  createdAt?: string;
}) {
  const now = input.createdAt ?? new Date().toISOString();
  const paymentsRepo = input.paymentsRepo ?? createPaymentsRepository(input.env);
  const transfer = await paymentsRepo.createTransfer({
    id: `xfr_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    walletId: input.recurringPayment.source_wallet_id,
    counterpartyId: input.recurringPayment.counterparty_id,
    sourceAddress: input.recurringPayment.source_address,
    destinationAddress: input.recurringPayment.destination_address,
    token: input.recurringPayment.token,
    amount: input.recurringPayment.amount,
    memo: null,
    type: "transfer",
    direction: "outbound",
    status: input.status,
    provider: null,
    providerReference: null,
    deliveryMode: null,
    fiatCurrency: null,
    fiatAmount: null,
    providerData: {},
    serializedTx: null,
    initiatedByKeyId: input.initiatedByKeyId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  if (!transfer) {
    throw new AppError("INTERNAL_ERROR", "Failed to create payment transfer record");
  }

  return transfer;
}

async function claimActivationRecords(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  destinationTokenAccount: string;
  subscriberTokenAccount: string;
}): Promise<
  | {
      alreadyActive: true;
      recurringPayment: PaymentRecurringPaymentRow;
      plan?: never;
      subscription?: never;
    }
  | {
      alreadyActive: false;
      recurringPayment: PaymentRecurringPaymentRow;
      plan: PaymentSubscriptionPlanRow;
      subscription: PaymentSubscriptionRow;
    }
> {
  return getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);

    await tx
      .prepare(
        `SELECT id
           FROM payment_recurring_payments
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
          FOR UPDATE`
      )
      .bind(input.recurringPaymentId, input.organizationId, input.projectId)
      .first();

    const recurringPayment = await txRecurringRepo.getRecurringPaymentById({
      recurringPaymentId: input.recurringPaymentId,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });

    if (!recurringPayment) {
      throw new AppError("NOT_FOUND", "Recurring payment not found");
    }
    if (recurringPayment.status === "active") {
      return { alreadyActive: true, recurringPayment };
    }
    if (
      recurringPayment.status === "activating" &&
      isFreshActivationClaim(recurringPayment.updated_at)
    ) {
      throw new AppError("CONFLICT", "Recurring payment activation is already in progress");
    }
    if (
      recurringPayment.status !== "pending_activation" &&
      recurringPayment.status !== "activating"
    ) {
      throw new AppError(
        "BAD_REQUEST",
        "Recurring payment cannot be activated from its current status"
      );
    }

    const now = new Date().toISOString();
    let plan = recurringPayment.plan_id
      ? await txSubscriptionsRepo.getPlanById({
          planId: recurringPayment.plan_id,
          organizationId: input.organizationId,
          projectId: input.projectId,
        })
      : null;

    if (!plan) {
      plan = await txSubscriptionsRepo.createPlan({
        id: `psp_${crypto.randomUUID()}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        ownerWalletId: recurringPayment.source_wallet_id,
        ownerAddress: recurringPayment.source_address,
        token: recurringPayment.token,
        amount: recurringPayment.amount,
        periodHours: recurringPayment.period_hours,
        programPlanId: generateProgramPlanId(),
        planPda: null,
        destinationAddress: input.destinationTokenAccount,
        pullerWalletId: recurringPayment.source_wallet_id,
        pullerAddress: recurringPayment.source_address,
        metadataUri: recurringPayment.metadata_uri,
        status: "draft",
        createdBy: recurringPayment.created_by,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (!plan) {
      throw new AppError("INTERNAL_ERROR", "Failed to create subscription plan");
    }

    let subscription = recurringPayment.subscription_id
      ? await txSubscriptionsRepo.getSubscriptionById({
          subscriptionId: recurringPayment.subscription_id,
          organizationId: input.organizationId,
          projectId: input.projectId,
        })
      : null;

    if (!subscription) {
      subscription = await txSubscriptionsRepo.createSubscription({
        id: `psub_${crypto.randomUUID()}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planId: plan.id,
        counterpartyId: recurringPayment.counterparty_id,
        subscriberAddress: recurringPayment.source_address,
        subscriberTokenAccount: input.subscriberTokenAccount,
        subscriptionPda: null,
        subscriptionAuthorityAddress: null,
        authorizationSignature: null,
        status: "pending_authorization",
        currentPeriodStartAt: null,
        nextCollectionDueAt: null,
        createdBy: recurringPayment.created_by,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (!subscription) {
      throw new AppError("INTERNAL_ERROR", "Failed to create subscription");
    }

    const claimedPayment = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      destinationTokenAccount: input.destinationTokenAccount,
      planId: plan.id,
      subscriptionId: subscription.id,
      status: "activating",
      updatedAt: now,
    });

    if (!claimedPayment) {
      throw new AppError("INTERNAL_ERROR", "Failed to claim recurring payment activation");
    }

    return {
      alreadyActive: false,
      recurringPayment: claimedPayment,
      plan,
      subscription,
    };
  });
}

async function persistActivationPlanRecoveryMarker(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  plan: PaymentSubscriptionPlanRow;
  destinationTokenAccount: string;
  planPda: string;
  planCreatedAt: string;
  signature: string | null;
}) {
  await getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const updatedAt = new Date().toISOString();
    const updatedPlan = await txSubscriptionsRepo.updatePlan({
      planId: input.plan.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planPda: input.planPda,
      destinationAddress: input.destinationTokenAccount,
      pullerWalletId: input.recurringPayment.source_wallet_id,
      pullerAddress: input.recurringPayment.source_address,
      status: "active",
      updatedAt,
    });
    const updatedRecurringPayment = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: "activating",
      destinationTokenAccount: input.destinationTokenAccount,
      planPda: input.planPda,
      planCreatedAt: input.planCreatedAt,
      planCreationSignature: input.signature,
      updatedAt,
    });

    if (!updatedPlan || !updatedRecurringPayment) {
      throw new AppError("INTERNAL_ERROR", "Failed to persist activation plan recovery marker");
    }
  });
}

async function persistActivationAuthorizationRecoveryMarker(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  sourceTokenAccount: string;
  subscriptionPda: string;
  subscriptionAuthorityAddress: string;
  signature: string | null;
}) {
  await getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const updatedAt = new Date().toISOString();
    const updatedSubscription = await txSubscriptionsRepo.updateSubscription({
      subscriptionId: input.subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriberTokenAccount: input.sourceTokenAccount,
      subscriptionPda: input.subscriptionPda,
      subscriptionAuthorityAddress: input.subscriptionAuthorityAddress,
      authorizationSignature: input.signature,
      updatedAt,
    });
    const updatedRecurringPayment = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: "activating",
      subscriptionPda: input.subscriptionPda,
      subscriptionAuthorityAddress: input.subscriptionAuthorityAddress,
      authorizationSignature: input.signature,
      updatedAt,
    });

    if (!updatedSubscription || !updatedRecurringPayment) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Failed to persist activation authorization recovery marker"
      );
    }
  });
}

async function deferStaleActivationClaim(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
}) {
  if (
    input.recurringPayment.status !== "activating" ||
    isFreshActivationClaim(input.recurringPayment.updated_at)
  ) {
    return;
  }

  await createPaymentRecurringPaymentsRepository(input.env).updateRecurringPayment({
    recurringPaymentId: input.recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    expectedStatus: "activating",
    updatedAt: new Date().toISOString(),
  });
}

async function claimSubmittedLifecycleAttemptOrExpireStale(input: {
  executor: DatabaseExecutor;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  operation: RecurringLifecycleOperation;
  updatedAt: string;
}): Promise<string | null> {
  const submittedLifecycleAttempt = await input.executor
    .prepare(
      `SELECT id
         FROM payment_recurring_operation_attempts
        WHERE organization_id = ?
          AND project_id = ?
          AND recurring_payment_id = ?
          AND operation = ?
          AND status = 'submitted'
        ORDER BY updated_at DESC
        LIMIT 1`
    )
    .bind(input.organizationId, input.projectId, input.recurringPayment.id, input.operation)
    .first<{ id: string }>();

  if (!submittedLifecycleAttempt) {
    return null;
  }
  if (isFreshLifecycleClaim(input.recurringPayment.updated_at)) {
    return submittedLifecycleAttempt.id;
  }

  await input.executor
    .prepare(
      `UPDATE payment_recurring_operation_attempts
          SET status = 'failed',
              error = COALESCE(error, 'Stale submitted recurring lifecycle attempt expired before confirmation'),
              updated_at = ?
        WHERE id = ?
          AND status = 'submitted'`
    )
    .bind(input.updatedAt, submittedLifecycleAttempt.id)
    .run();

  return null;
}

async function claimLifecycleRecords(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  operation: RecurringLifecycleOperation;
}): Promise<{
  alreadyFinalized: boolean;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  lifecycleAttemptId: string | null;
  lifecycleAttemptSubmitted: boolean;
}> {
  return getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const claimStatus = getLifecycleClaimStatus(input.operation);

    await tx
      .prepare(
        `SELECT id
           FROM payment_recurring_payments
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
          FOR UPDATE`
      )
      .bind(input.recurringPaymentId, input.organizationId, input.projectId)
      .first();

    const recurringPayment = await txRecurringRepo.getRecurringPaymentById({
      recurringPaymentId: input.recurringPaymentId,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });

    if (!recurringPayment) {
      throw new AppError("NOT_FOUND", "Recurring payment not found");
    }
    const subscriptionId = recurringPayment.subscription_id;
    if (!subscriptionId) {
      throw new AppError("BAD_REQUEST", "Recurring payment has not been activated");
    }

    await tx
      .prepare(
        `SELECT id
           FROM payment_subscriptions
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
          FOR UPDATE`
      )
      .bind(subscriptionId, input.organizationId, input.projectId)
      .first();

    const subscription = await txSubscriptionsRepo.getSubscriptionById({
      subscriptionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (!subscription) {
      throw new AppError("NOT_FOUND", "Recurring payment subscription not found");
    }
    if (
      isRecurringPaymentLifecycleFinalized({
        recurringPayment,
        subscription,
        operation: input.operation,
      })
    ) {
      await markActiveRecurringLifecycleAttemptsFinalized({
        executor: tx,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: recurringPayment.id,
        operation: input.operation,
        updatedAt: new Date().toISOString(),
      });
      return {
        alreadyFinalized: true,
        recurringPayment,
        subscription,
        lifecycleAttemptId: null,
        lifecycleAttemptSubmitted: false,
      };
    }
    assertRecurringPaymentCanClaimLifecycle({
      recurringPayment,
      operation: input.operation,
      claimStatus,
    });
    assertSubscriptionCanClaimLifecycle({ subscription, operation: input.operation });

    const now = new Date().toISOString();
    if (recurringPayment.status === claimStatus) {
      const submittedLifecycleAttemptId = await claimSubmittedLifecycleAttemptOrExpireStale({
        executor: tx,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPayment,
        operation: input.operation,
        updatedAt: now,
      });

      if (submittedLifecycleAttemptId) {
        return {
          alreadyFinalized: false,
          recurringPayment,
          subscription,
          lifecycleAttemptId: submittedLifecycleAttemptId,
          lifecycleAttemptSubmitted: true,
        };
      }

      if (isFreshLifecycleClaim(recurringPayment.updated_at)) {
        throw new AppError("CONFLICT", "Recurring payment lifecycle update is already in progress");
      }

      await tx
        .prepare(
          `UPDATE payment_recurring_operation_attempts
              SET status = 'failed',
                  error = COALESCE(error, 'Stale recurring lifecycle attempt expired before submission'),
                  updated_at = ?
            WHERE organization_id = ?
              AND project_id = ?
              AND recurring_payment_id = ?
              AND operation = ?
              AND status = 'processing'`
        )
        .bind(now, input.organizationId, input.projectId, recurringPayment.id, input.operation)
        .run();
    }
    // Collection claims insert a collect operation attempt before creating or
    // signing a transfer. Holding this lifecycle-side mutex check in the claim
    // transaction prevents cancel/resume from racing a collection into an
    // orphaned processing transfer.
    await assertNoActiveRecurringOperationAttempt({
      executor: tx,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: recurringPayment.id,
    });
    if (
      input.operation === "cancel" &&
      recurringPayment.status !== claimStatus &&
      recurringPayment.next_collection_due_at
    ) {
      const activeCollectionAttempt = await tx
        .prepare(
          `SELECT id
             FROM payment_subscription_collection_attempts
            WHERE organization_id = ?
              AND project_id = ?
              AND recurring_payment_id = ?
              AND due_at = ?
              AND status IN ('pending', 'processing')
            ORDER BY updated_at DESC
            LIMIT 1
            FOR UPDATE`
        )
        .bind(
          input.organizationId,
          input.projectId,
          recurringPayment.id,
          recurringPayment.next_collection_due_at
        )
        .first<{ id: string }>();

      if (activeCollectionAttempt) {
        throw new AppError("CONFLICT", "Recurring payment collection is already in progress");
      }
    }
    const claimedPayment = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: recurringPayment.status,
      expectedNextCollectionDueAt: recurringPayment.next_collection_due_at,
      status: claimStatus,
      updatedAt: now,
    });
    if (!claimedPayment) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment lifecycle state changed before the update was claimed"
      );
    }

    const createLifecycleAttempt = async (
      payment: PaymentRecurringPaymentRow,
      claimedSubscription: PaymentSubscriptionRow
    ) => {
      const lifecycleAttemptId = `prlo_${crypto.randomUUID()}`;
      await tx
        .prepare(
          `INSERT INTO payment_recurring_operation_attempts (
             id,
             organization_id,
             project_id,
             recurring_payment_id,
             operation,
             status,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)`
        )
        .bind(
          lifecycleAttemptId,
          input.organizationId,
          input.projectId,
          payment.id,
          input.operation,
          now,
          now
        )
        .run();

      return {
        alreadyFinalized: false,
        recurringPayment: payment,
        subscription: claimedSubscription,
        lifecycleAttemptId,
        lifecycleAttemptSubmitted: false,
      };
    };

    if (input.operation !== "cancel" || subscription.status === "canceling") {
      return createLifecycleAttempt(claimedPayment, subscription);
    }

    const claimedSubscription = await txSubscriptionsRepo.updateSubscription({
      subscriptionId: subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: subscription.status,
      expectedNextCollectionDueAt: subscription.next_collection_due_at,
      status: "canceling",
      updatedAt: now,
    });
    if (!claimedSubscription) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment subscription lifecycle state changed before the update was claimed"
      );
    }

    return {
      ...(await createLifecycleAttempt(claimedPayment, claimedSubscription)),
    };
  });
}

async function finalizeRecurringPaymentLifecycle(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  operation: RecurringLifecycleOperation;
  lifecycleAttemptId: string;
}): Promise<PaymentRecurringPaymentRow> {
  const now = new Date().toISOString();
  const claimStatus = getLifecycleClaimStatus(input.operation);
  const status = getLifecycleTargetStatus(input.operation);
  const resumeNextCollectionDueAt =
    input.operation === "resume"
      ? advanceCollectionDueAtAfter({
          nextCollectionDueAt: input.recurringPayment.next_collection_due_at,
          periodHours: input.recurringPayment.period_hours,
          after: now,
        })
      : undefined;
  const resumeCurrentPeriodStartAt =
    resumeNextCollectionDueAt === undefined
      ? undefined
      : addPeriodHours(resumeNextCollectionDueAt, -input.recurringPayment.period_hours);

  return getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);

    await tx
      .prepare(
        `SELECT id
           FROM payment_recurring_payments
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
          FOR UPDATE`
      )
      .bind(input.recurringPayment.id, input.organizationId, input.projectId)
      .first();
    await tx
      .prepare(
        `SELECT id
           FROM payment_subscriptions
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
          FOR UPDATE`
      )
      .bind(input.subscription.id, input.organizationId, input.projectId)
      .first();

    const lockedRecurringPayment = await txRecurringRepo.getRecurringPaymentById({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    const lockedSubscription = await txSubscriptionsRepo.getSubscriptionById({
      subscriptionId: input.subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (!lockedRecurringPayment || !lockedSubscription) {
      throw new AppError("NOT_FOUND", "Recurring payment lifecycle state not found");
    }
    if (
      isRecurringPaymentLifecycleFinalized({
        recurringPayment: lockedRecurringPayment,
        subscription: lockedSubscription,
        operation: input.operation,
      })
    ) {
      await markActiveRecurringLifecycleAttemptsFinalized({
        executor: tx,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.recurringPayment.id,
        operation: input.operation,
        updatedAt: now,
      });
      return lockedRecurringPayment;
    }
    if (
      lockedRecurringPayment.status !== claimStatus ||
      lockedRecurringPayment.next_collection_due_at !==
        input.recurringPayment.next_collection_due_at
    ) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment lifecycle state changed before finalization started"
      );
    }
    if (
      input.operation === "cancel" &&
      (lockedSubscription.status !== "canceling" ||
        lockedSubscription.next_collection_due_at !== input.recurringPayment.next_collection_due_at)
    ) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment subscription lifecycle state changed before finalization started"
      );
    }
    if (
      input.operation === "resume" &&
      (lockedSubscription.status !== input.subscription.status ||
        lockedSubscription.next_collection_due_at !== input.recurringPayment.next_collection_due_at)
    ) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment subscription lifecycle state changed before finalization started"
      );
    }

    const updated = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: claimStatus,
      expectedNextCollectionDueAt: input.recurringPayment.next_collection_due_at,
      status,
      nextCollectionDueAt: resumeNextCollectionDueAt,
      updatedAt: now,
    });
    const updatedSubscription = await txSubscriptionsRepo.updateSubscription({
      subscriptionId: input.subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: lockedSubscription.status,
      expectedNextCollectionDueAt: input.recurringPayment.next_collection_due_at,
      status,
      currentPeriodStartAt: resumeCurrentPeriodStartAt,
      nextCollectionDueAt: resumeNextCollectionDueAt,
      canceledAt:
        input.operation === "cancel" ? now : input.operation === "resume" ? null : undefined,
      updatedAt: now,
    });

    if (!updated || !updatedSubscription) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment lifecycle state changed before the update completed"
      );
    }
    const confirmedAttemptChanges = await tx
      .prepare(
        `UPDATE payment_recurring_operation_attempts
            SET status = 'confirmed',
                updated_at = ?
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
            AND recurring_payment_id = ?
            AND operation = ?
            AND status IN ('processing', 'submitted', 'confirmed')`
      )
      .bind(
        now,
        input.lifecycleAttemptId,
        input.organizationId,
        input.projectId,
        input.recurringPayment.id,
        input.operation
      )
      .run();

    if (confirmedAttemptChanges === 0) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment lifecycle attempt changed before finalization completed"
      );
    }

    return updated;
  });
}

async function readRecurringPaymentLifecycleRecords(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  subscriptionId: string;
}): Promise<{
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
}> {
  const [recurringPayment, subscription] = await Promise.all([
    createPaymentRecurringPaymentsRepository(input.env).getRecurringPaymentById({
      recurringPaymentId: input.recurringPaymentId,
      organizationId: input.organizationId,
      projectId: input.projectId,
    }),
    createPaymentSubscriptionsRepository(input.env).getSubscriptionById({
      subscriptionId: input.subscriptionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
    }),
  ]);

  if (!recurringPayment || !subscription) {
    throw new AppError("NOT_FOUND", "Recurring payment lifecycle state not found");
  }

  return { recurringPayment, subscription };
}

async function reconcileCanceledRecurringPaymentFromChain(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  sourceAddress: ReturnType<typeof assertValidAddress>;
  planPda: ReturnType<typeof assertValidAddress>;
  subscriptionPda: ReturnType<typeof assertValidAddress>;
  knownCanceledOnChain?: boolean;
  finalizeLifecycleOperation?: boolean;
}): Promise<PaymentRecurringPaymentRow | null> {
  let canceledOnChain = input.knownCanceledOnChain === true;
  if (!canceledOnChain) {
    try {
      canceledOnChain = await isSubscriptionLifecycleTargetReachedOnChain({
        env: input.env,
        operation: "cancel",
        sourceAddress: input.sourceAddress,
        planPda: input.planPda,
        subscriptionPda: input.subscriptionPda,
      });
    } catch {
      return null;
    }
  }
  if (!canceledOnChain) {
    return null;
  }

  const now = new Date().toISOString();
  return getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);

    await tx
      .prepare(
        `SELECT id
           FROM payment_recurring_payments
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
          FOR UPDATE`
      )
      .bind(input.recurringPayment.id, input.organizationId, input.projectId)
      .first();
    await tx
      .prepare(
        `SELECT id
           FROM payment_subscriptions
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
          FOR UPDATE`
      )
      .bind(input.subscriptionId, input.organizationId, input.projectId)
      .first();

    const currentRecurringPayment = await txRecurringRepo.getRecurringPaymentById({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    const currentSubscription = await txSubscriptionsRepo.getSubscriptionById({
      subscriptionId: input.subscriptionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (!currentRecurringPayment || !currentSubscription) {
      throw new AppError("NOT_FOUND", "Recurring payment lifecycle state not found");
    }
    if (
      currentRecurringPayment.status === "canceled" &&
      currentSubscription.status === "canceled"
    ) {
      if (input.finalizeLifecycleOperation) {
        await markActiveRecurringLifecycleAttemptsFinalized({
          executor: tx,
          organizationId: input.organizationId,
          projectId: input.projectId,
          recurringPaymentId: input.recurringPayment.id,
          operation: "cancel",
          updatedAt: now,
        });
      }
      return currentRecurringPayment;
    }
    if (
      !["active", "paused", "canceling", "resuming", "canceled"].includes(
        currentRecurringPayment.status
      ) ||
      !["active", "paused", "canceling", "canceled"].includes(currentSubscription.status)
    ) {
      return null;
    }

    const updatedRecurringPayment = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: currentRecurringPayment.status,
      expectedNextCollectionDueAt: currentRecurringPayment.next_collection_due_at,
      status: "canceled",
      updatedAt: now,
    });
    const updatedSubscription = await txSubscriptionsRepo.updateSubscription({
      subscriptionId: input.subscriptionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: currentSubscription.status,
      expectedNextCollectionDueAt: currentSubscription.next_collection_due_at,
      status: "canceled",
      canceledAt: currentSubscription.canceled_at ?? now,
      updatedAt: now,
    });

    if (!updatedRecurringPayment || !updatedSubscription) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment lifecycle state changed before canceled-state reconciliation completed"
      );
    }
    if (input.finalizeLifecycleOperation) {
      await markActiveRecurringLifecycleAttemptsFinalized({
        executor: tx,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.recurringPayment.id,
        operation: "cancel",
        updatedAt: now,
      });
    }

    return updatedRecurringPayment;
  });
}

async function reconcileActiveRecurringPaymentFromChain(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  finalizeLifecycleOperation?: boolean;
}): Promise<PaymentRecurringPaymentRow | null> {
  const now = new Date().toISOString();
  return getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);

    await tx
      .prepare(
        `SELECT id
           FROM payment_recurring_payments
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
          FOR UPDATE`
      )
      .bind(input.recurringPayment.id, input.organizationId, input.projectId)
      .first();
    await tx
      .prepare(
        `SELECT id
           FROM payment_subscriptions
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
          FOR UPDATE`
      )
      .bind(input.subscriptionId, input.organizationId, input.projectId)
      .first();

    const currentRecurringPayment = await txRecurringRepo.getRecurringPaymentById({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    const currentSubscription = await txSubscriptionsRepo.getSubscriptionById({
      subscriptionId: input.subscriptionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (!currentRecurringPayment || !currentSubscription) {
      throw new AppError("NOT_FOUND", "Recurring payment lifecycle state not found");
    }
    if (
      isRecurringPaymentLifecycleFinalized({
        recurringPayment: currentRecurringPayment,
        subscription: currentSubscription,
        operation: "resume",
      })
    ) {
      if (input.finalizeLifecycleOperation) {
        await markActiveRecurringLifecycleAttemptsFinalized({
          executor: tx,
          organizationId: input.organizationId,
          projectId: input.projectId,
          recurringPaymentId: input.recurringPayment.id,
          operation: "resume",
          updatedAt: now,
        });
      }
      return currentRecurringPayment;
    }
    if (
      !["active", "paused", "resuming", "canceled"].includes(currentRecurringPayment.status) ||
      !["active", "paused", "canceled"].includes(currentSubscription.status)
    ) {
      return null;
    }

    const nextCollectionDueAt = advanceCollectionDueAtAfter({
      nextCollectionDueAt: currentRecurringPayment.next_collection_due_at,
      periodHours: currentRecurringPayment.period_hours,
      after: now,
    });
    const currentPeriodStartAt = addPeriodHours(
      nextCollectionDueAt,
      -currentRecurringPayment.period_hours
    );
    const updatedRecurringPayment = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: currentRecurringPayment.status,
      expectedNextCollectionDueAt: currentRecurringPayment.next_collection_due_at,
      status: "active",
      nextCollectionDueAt,
      updatedAt: now,
    });
    const updatedSubscription = await txSubscriptionsRepo.updateSubscription({
      subscriptionId: input.subscriptionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: currentSubscription.status,
      expectedNextCollectionDueAt: currentSubscription.next_collection_due_at,
      status: "active",
      currentPeriodStartAt,
      nextCollectionDueAt,
      canceledAt: null,
      updatedAt: now,
    });

    if (!updatedRecurringPayment || !updatedSubscription) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment lifecycle state changed before active-state reconciliation completed"
      );
    }
    if (input.finalizeLifecycleOperation) {
      await markActiveRecurringLifecycleAttemptsFinalized({
        executor: tx,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.recurringPayment.id,
        operation: "resume",
        updatedAt: now,
      });
    }

    return updatedRecurringPayment;
  });
}

async function assertRecurringPaymentNotCanceledOnChain(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  sourceAddress: ReturnType<typeof assertValidAddress>;
  planPda: ReturnType<typeof assertValidAddress>;
  subscriptionPda: ReturnType<typeof assertValidAddress>;
}) {
  const reconciledCanceledPayment = await reconcileCanceledRecurringPaymentFromChain({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: input.recurringPayment,
    subscriptionId: input.subscriptionId,
    sourceAddress: input.sourceAddress,
    planPda: input.planPda,
    subscriptionPda: input.subscriptionPda,
  });
  if (reconciledCanceledPayment?.status === "canceled") {
    throw new AppError(
      "BAD_REQUEST",
      "Recurring payment subscription is already canceled on-chain"
    );
  }
}

async function assertRecurringPaymentCanResumeOnChain(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  sourceAddress: ReturnType<typeof assertValidAddress>;
  planPda: ReturnType<typeof assertValidAddress>;
  subscriptionPda: ReturnType<typeof assertValidAddress>;
}) {
  const lifecycleState = await readSubscriptionLifecycleStateOnChain({
    env: input.env,
    sourceAddress: input.sourceAddress,
    planPda: input.planPda,
    subscriptionPda: input.subscriptionPda,
  });

  if (!lifecycleState.isCanceled) {
    return;
  }

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  if (lifecycleState.expiresAtTs > nowSeconds) {
    return;
  }

  await reconcileCanceledRecurringPaymentFromChain({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: input.recurringPayment,
    subscriptionId: input.subscriptionId,
    sourceAddress: input.sourceAddress,
    planPda: input.planPda,
    subscriptionPda: input.subscriptionPda,
    knownCanceledOnChain: true,
  });
  throw new AppError("BAD_REQUEST", "Recurring payment subscription is already canceled on-chain");
}

async function finalizeRecurringPaymentLifecycleAfterChain(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  operation: RecurringLifecycleOperation;
  lifecycleAttemptId: string;
  sourceAddress: ReturnType<typeof assertValidAddress>;
  planPda: ReturnType<typeof assertValidAddress>;
  subscriptionPda: ReturnType<typeof assertValidAddress>;
}): Promise<PaymentRecurringPaymentRow> {
  // If the normal optimistic finalization loses the DB race after the chain
  // confirms, use the on-chain target state as the recovery source of truth.
  const reconcileFromConfirmedChain = async () => {
    const targetReached = await isSubscriptionLifecycleTargetReachedOnChain({
      env: input.env,
      operation: input.operation,
      sourceAddress: input.sourceAddress,
      planPda: input.planPda,
      subscriptionPda: input.subscriptionPda,
    });
    if (!targetReached) {
      return null;
    }

    if (input.operation === "cancel") {
      return reconcileCanceledRecurringPaymentFromChain({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPayment: input.recurringPayment,
        subscriptionId: input.subscription.id,
        sourceAddress: input.sourceAddress,
        planPda: input.planPda,
        subscriptionPda: input.subscriptionPda,
        knownCanceledOnChain: true,
        finalizeLifecycleOperation: true,
      });
    }

    return reconcileActiveRecurringPaymentFromChain({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: input.recurringPayment,
      subscriptionId: input.subscription.id,
      finalizeLifecycleOperation: true,
    });
  };

  try {
    return await finalizeRecurringPaymentLifecycle(input);
  } catch (error) {
    console.error("Recurring payment lifecycle finalized on-chain but DB finalization failed", {
      recurringPaymentId: input.recurringPayment.id,
      subscriptionId: input.subscription.id,
      operation: input.operation,
      error: toErrorMessage(error),
    });

    const current = await readRecurringPaymentLifecycleRecords({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      subscriptionId: input.subscription.id,
    });
    if (isRecurringPaymentLifecycleFinalized({ ...current, operation: input.operation })) {
      return current.recurringPayment;
    }
    if (error instanceof AppError && error.code === "CONFLICT") {
      const reconciled = await reconcileFromConfirmedChain();
      if (reconciled) {
        return reconciled;
      }

      throw error;
    }
    if (
      !isRecurringPaymentLifecycleClaimStillFinalizable({
        ...current,
        operation: input.operation,
      })
    ) {
      const reconciled = await reconcileFromConfirmedChain();
      if (reconciled) {
        return reconciled;
      }

      throw error;
    }

    try {
      return await finalizeRecurringPaymentLifecycle({
        ...input,
        recurringPayment: current.recurringPayment,
        subscription: current.subscription,
      });
    } catch (retryError) {
      const reconciled = await readRecurringPaymentLifecycleRecords({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.recurringPayment.id,
        subscriptionId: input.subscription.id,
      });
      if (
        isRecurringPaymentLifecycleFinalized({
          ...reconciled,
          operation: input.operation,
        })
      ) {
        return reconciled.recurringPayment;
      }
      const chainReconciled = await reconcileFromConfirmedChain();
      if (chainReconciled) {
        return chainReconciled;
      }

      throw new AppError(
        "INTERNAL_ERROR",
        "Recurring payment lifecycle finalized on-chain but DB finalization could not be recovered",
        {
          recurringPaymentId: input.recurringPayment.id,
          subscriptionId: input.subscription.id,
          operation: input.operation,
          originalError: toErrorMessage(error),
          retryError: toErrorMessage(retryError),
        }
      );
    }
  }
}

async function updateTransferRecord(input: {
  env: Env;
  transferId: string;
  status?: PaymentTransferStatus;
  signature?: string | null;
  slot?: number | null;
  blockTime?: string | null;
  error?: string | null;
}) {
  const updated = await createPaymentsRepository(input.env).updateTransfer({
    transferId: input.transferId,
    status: input.status,
    signature: input.signature,
    slot: input.slot,
    blockTime: input.blockTime,
    error: input.error,
    updatedAt: new Date().toISOString(),
  });

  if (!updated) {
    throw new AppError("INTERNAL_ERROR", "Payment transfer record not found for update");
  }

  return updated;
}

function getStringMetadataValue(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getNumberMetadataValue(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function markRecurringCollectionSubmitted(input: {
  env: Env;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  signature: string;
  slot: number | null;
  blockTime: string | null;
  destinationTokenAccount: string;
}): Promise<{
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  hasRecoveryMarker: boolean;
  hasAttemptRecoveryMarker: boolean;
}> {
  const updatedAt = new Date().toISOString();
  const metadata = {
    ...input.attempt.metadata,
    source: "recurring_payments",
    destinationTokenAccount: input.destinationTokenAccount,
    collectionSignature: input.signature,
    collectionSlot: input.slot,
    collectionBlockTime: input.blockTime,
  };

  const operationAttemptPromise = input.attempt.recurring_payment_id
    ? markActiveRecurringCollectOperationAttemptSubmitted({
        env: input.env,
        organizationId: input.attempt.organization_id,
        projectId: input.attempt.project_id,
        recurringPaymentId: input.attempt.recurring_payment_id,
        signature: input.signature,
        slot: input.slot,
        blockTime: input.blockTime,
      })
    : Promise.resolve(false);

  const [transferResult, attemptResult, operationAttemptResult] = await Promise.allSettled([
    updateTransferRecord({
      env: input.env,
      transferId: input.transfer.id,
      status: "processing",
      signature: input.signature,
      slot: input.slot,
      blockTime: input.blockTime,
      error: null,
    }),
    createPaymentSubscriptionsRepository(input.env).updateCollectionAttempt({
      attemptId: input.attempt.id,
      transferId: input.transfer.id,
      status: "processing",
      signature: input.signature,
      error: null,
      metadata,
      attemptedAt: updatedAt,
      updatedAt,
    }),
    operationAttemptPromise,
  ]);

  if (transferResult.status === "rejected") {
    console.error("Failed to persist recurring collection transfer recovery marker", {
      transferId: input.transfer.id,
      error:
        transferResult.reason instanceof Error
          ? transferResult.reason.message
          : String(transferResult.reason),
    });
  }
  if (attemptResult.status === "rejected") {
    console.error("Failed to persist recurring collection attempt recovery marker", {
      attemptId: input.attempt.id,
      error:
        attemptResult.reason instanceof Error
          ? attemptResult.reason.message
          : String(attemptResult.reason),
    });
  }
  if (operationAttemptResult.status === "rejected") {
    console.error("Failed to persist recurring collection operation recovery marker", {
      recurringPaymentId: input.attempt.recurring_payment_id,
      signature: input.signature,
      error:
        operationAttemptResult.reason instanceof Error
          ? operationAttemptResult.reason.message
          : String(operationAttemptResult.reason),
    });
  }

  const updatedTransfer =
    transferResult.status === "fulfilled" ? transferResult.value : input.transfer;
  const updatedAttempt =
    attemptResult.status === "fulfilled" && attemptResult.value
      ? attemptResult.value
      : input.attempt;
  const transferHasSubmissionMarker =
    transferResult.status === "fulfilled" && Boolean(transferResult.value?.signature);
  const attemptHasSubmissionMarker =
    attemptResult.status === "fulfilled" && Boolean(attemptResult.value?.signature);
  const operationHasSubmissionMarker =
    operationAttemptResult.status === "fulfilled" && operationAttemptResult.value === true;

  if (
    !transferHasSubmissionMarker &&
    !attemptHasSubmissionMarker &&
    !operationHasSubmissionMarker
  ) {
    console.error("Recurring collection submitted on-chain without a persisted recovery marker", {
      attemptId: input.attempt.id,
      transferId: input.transfer.id,
      signature: input.signature,
    });
  }

  return {
    attempt: updatedAttempt,
    transfer: updatedTransfer,
    hasRecoveryMarker:
      transferHasSubmissionMarker || attemptHasSubmissionMarker || operationHasSubmissionMarker,
    hasAttemptRecoveryMarker: attemptHasSubmissionMarker,
  };
}

async function retryPersistRecurringCollectionSubmittedMarker(input: {
  env: Env;
  recurringPaymentId: string;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  signature: string | null;
  destinationTokenAccount: string | null;
}): Promise<Awaited<ReturnType<typeof markRecurringCollectionSubmitted>> | null> {
  if (!input.signature || !input.destinationTokenAccount) {
    return null;
  }

  try {
    return await markRecurringCollectionSubmitted({
      env: input.env,
      attempt: input.attempt,
      transfer: input.transfer,
      signature: input.signature,
      slot: null,
      blockTime: null,
      destinationTokenAccount: input.destinationTokenAccount,
    });
  } catch (markerError) {
    console.warn("Failed to persist recurring collection submitted recovery marker", {
      recurringPaymentId: input.recurringPaymentId,
      attemptId: input.attempt.id,
      transferId: input.transfer.id,
      signature: input.signature,
      error: toErrorMessage(markerError),
    });
    return null;
  }
}

async function executeRecurringCollectionOnChainWithRecoveryMarker(input: {
  env: Env;
  recurringPaymentId: string;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  sourceSigner: Awaited<ReturnType<typeof getSourceSigner>>;
  sourceAddress: ReturnType<typeof assertValidAddress>;
  destinationAddress: ReturnType<typeof assertValidAddress>;
  planPda: ReturnType<typeof assertValidAddress>;
  subscriptionPda: ReturnType<typeof assertValidAddress>;
  runtime: Awaited<ReturnType<typeof resolveRecurringSubscriptionRuntime>>;
}): Promise<{
  executed: Awaited<ReturnType<typeof collectSubscriptionOnChain>>;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
}> {
  let collectionAttempt = input.attempt;
  let transfer = input.transfer;
  const submittedCollection = {
    current: null as Awaited<ReturnType<typeof markRecurringCollectionSubmitted>> | null,
  };
  let submittedSignature: string | null = null;
  let submittedDestinationTokenAccount: string | null = null;

  try {
    const executed = await collectSubscriptionOnChain({
      env: input.env,
      sourceSigner: input.sourceSigner,
      sourceAddress: input.sourceAddress,
      destinationAddress: input.destinationAddress,
      planPda: input.planPda,
      subscriptionPda: input.subscriptionPda,
      runtime: input.runtime,
      onSubmitted: async (submittedTransaction) => {
        submittedSignature = submittedTransaction.signature;
        submittedDestinationTokenAccount = String(submittedTransaction.destinationTokenAccount);
        submittedCollection.current = await markRecurringCollectionSubmitted({
          env: input.env,
          attempt: collectionAttempt,
          transfer,
          signature: submittedTransaction.signature,
          slot: null,
          blockTime: null,
          destinationTokenAccount: submittedDestinationTokenAccount,
        });
        collectionAttempt = submittedCollection.current.attempt;
        transfer = submittedCollection.current.transfer;
      },
    });

    return { executed, attempt: collectionAttempt, transfer };
  } catch (error) {
    let submittedBeforeConfirmation = submittedCollection.current;
    if (submittedBeforeConfirmation || submittedSignature) {
      const retriedSubmittedMarker =
        submittedBeforeConfirmation ??
        (await retryPersistRecurringCollectionSubmittedMarker({
          env: input.env,
          recurringPaymentId: input.recurringPaymentId,
          attempt: collectionAttempt,
          transfer,
          signature: submittedSignature,
          destinationTokenAccount: submittedDestinationTokenAccount,
        }));
      if (retriedSubmittedMarker) {
        submittedBeforeConfirmation = retriedSubmittedMarker;
        collectionAttempt = retriedSubmittedMarker.attempt;
        transfer = retriedSubmittedMarker.transfer;
      }
      console.error("Recurring collection submitted on-chain but confirmation failed", {
        recurringPaymentId: input.recurringPaymentId,
        attemptId: collectionAttempt.id,
        transferId: transfer.id,
        signature:
          submittedBeforeConfirmation?.transfer.signature ??
          submittedBeforeConfirmation?.attempt.signature ??
          submittedSignature,
        error: toErrorMessage(error),
      });
      throw error;
    }

    const message = toErrorMessage(error);
    await markRecurringCollectionFailedBeforeSubmission({
      env: input.env,
      attempt: collectionAttempt,
      transfer,
      error: message,
      retryImmediately: isImmediateRecurringSubscriptionRetryError(error),
    });

    throw error;
  }
}

async function markRecurringCollectionFailedBeforeSubmission(input: {
  env: Env;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  error: string;
  retryImmediately?: boolean;
}): Promise<{
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
}> {
  const failRecords = async () =>
    getDb(input.env).transaction(async (tx) => {
      const txPaymentsRepo = createPostgresPaymentsRepository(tx);
      const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
      const now = new Date().toISOString();
      const updatedTransfer = await txPaymentsRepo.updateTransfer({
        transferId: input.transfer.id,
        status: "failed",
        error: input.error,
        updatedAt: now,
      });
      const failedAttempt = await txSubscriptionsRepo.updateCollectionAttempt({
        attemptId: input.attempt.id,
        transferId: input.transfer.id,
        status: "failed",
        error: input.error,
        metadata: input.retryImmediately
          ? {
              ...input.attempt.metadata,
              retryImmediately: true,
              retryReason: "blockhash_expired",
            }
          : undefined,
        attemptedAt: now,
        updatedAt: now,
      });
      if (input.attempt.recurring_payment_id) {
        await failActiveRecurringCollectOperationAttempt({
          executor: tx,
          organizationId: input.attempt.organization_id,
          projectId: input.attempt.project_id,
          recurringPaymentId: input.attempt.recurring_payment_id,
          error: input.error,
          updatedAt: now,
        });
      }

      if (!updatedTransfer || !failedAttempt) {
        throw new AppError("INTERNAL_ERROR", "Failed to mark recurring collection failed");
      }

      return { attempt: failedAttempt, transfer: updatedTransfer };
    });

  try {
    return await failRecords();
  } catch (error) {
    console.error("Failed to mark recurring collection failed before submission; retrying", {
      attemptId: input.attempt.id,
      transferId: input.transfer.id,
      error: toErrorMessage(error),
    });
    try {
      return await failRecords();
    } catch (retryError) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Recurring collection failed before submission and cleanup could not be persisted",
        {
          attemptId: input.attempt.id,
          transferId: input.transfer.id,
          collectionError: input.error,
          cleanupError: toErrorMessage(retryError),
        }
      );
    }
  }
}

async function finalizeRecurringCollection(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  dueAt: string;
  signature: string;
  slot: number | null;
  blockTime: string | null;
  destinationTokenAccount: string;
}): Promise<CollectionResult> {
  const updatedAt = new Date().toISOString();
  const nextDueAt = advanceCollectionDueAtAfter({
    nextCollectionDueAt: input.dueAt,
    periodHours: input.recurringPayment.period_hours,
    after: updatedAt,
  });
  const currentPeriodStartAt = addPeriodHours(nextDueAt, -input.recurringPayment.period_hours);

  return getDb(input.env).transaction(async (tx) => {
    const txPaymentsRepo = createPostgresPaymentsRepository(tx);
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const lockedRecurringPayment = await tx.queryOne<{
      status: string;
      next_collection_due_at: string | null;
    }>(
      `SELECT status, next_collection_due_at
         FROM payment_recurring_payments
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?
        FOR UPDATE`,
      [input.recurringPayment.id, input.organizationId, input.projectId]
    );
    const lockedSubscription = await tx.queryOne<{
      status: string;
      next_collection_due_at: string | null;
    }>(
      `SELECT status, next_collection_due_at
         FROM payment_subscriptions
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?
        FOR UPDATE`,
      [input.subscriptionId, input.organizationId, input.projectId]
    );

    if (!lockedRecurringPayment || !lockedSubscription) {
      throw new AppError("NOT_FOUND", "Recurring payment collection state not found");
    }

    const transferStatus = input.transfer.status === "finalized" ? "finalized" : "confirmed";
    const confirmCollectionRecords = async () => {
      const updatedTransfer = await txPaymentsRepo.updateTransfer({
        transferId: input.transfer.id,
        status: transferStatus,
        signature: input.signature,
        slot: input.slot,
        blockTime: input.blockTime,
        error: null,
        updatedAt,
      });
      const updatedAttempt = await txSubscriptionsRepo.updateCollectionAttempt({
        attemptId: input.attempt.id,
        transferId: input.transfer.id,
        status: "confirmed",
        signature: input.signature,
        attemptedAt: updatedAt,
        updatedAt,
      });

      if (!updatedTransfer || !updatedAttempt) {
        throw new AppError("INTERNAL_ERROR", "Failed to update recurring payment collection state");
      }

      return { updatedAttempt, updatedTransfer };
    };

    const collectionStateChanged =
      lockedRecurringPayment.status !== "active" ||
      lockedRecurringPayment.next_collection_due_at !== input.dueAt ||
      lockedSubscription.status !== "active" ||
      lockedSubscription.next_collection_due_at !== input.dueAt;

    if (collectionStateChanged) {
      const { updatedAttempt, updatedTransfer } = await confirmCollectionRecords();
      await markActiveRecurringCollectOperationAttemptFinalized({
        executor: tx,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.recurringPayment.id,
        updatedAt,
      });
      const currentRecurringPayment = await txRecurringRepo.getRecurringPaymentById({
        recurringPaymentId: input.recurringPayment.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });

      if (!currentRecurringPayment) {
        throw new AppError("NOT_FOUND", "Recurring payment collection state not found");
      }

      console.warn("Recurring collection confirmed after lifecycle state changed", {
        recurringPaymentId: input.recurringPayment.id,
        attemptId: input.attempt.id,
        transferId: input.transfer.id,
        dueAt: input.dueAt,
        recurringPaymentStatus: lockedRecurringPayment.status,
        subscriptionStatus: lockedSubscription.status,
      });

      return {
        recurringPayment: currentRecurringPayment,
        collectionAttempt: updatedAttempt,
        transfer: updatedTransfer,
      };
    }

    const { updatedAttempt, updatedTransfer } = await confirmCollectionRecords();
    await markActiveRecurringCollectOperationAttemptFinalized({
      executor: tx,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      updatedAt,
    });
    const updatedRecurringPayment = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: "active",
      expectedNextCollectionDueAt: input.dueAt,
      destinationTokenAccount: input.destinationTokenAccount,
      nextCollectionDueAt: nextDueAt,
      updatedAt,
    });
    const updatedSubscription = await txSubscriptionsRepo.updateSubscription({
      subscriptionId: input.subscriptionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: "active",
      expectedNextCollectionDueAt: input.dueAt,
      currentPeriodStartAt,
      nextCollectionDueAt: nextDueAt,
      updatedAt,
    });

    if (!updatedRecurringPayment || !updatedSubscription) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment collection state changed before finalization completed"
      );
    }

    return {
      recurringPayment: updatedRecurringPayment,
      collectionAttempt: updatedAttempt,
      transfer: updatedTransfer,
    };
  });
}

async function recoverSubmittedRecurringCollection(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  dueAt: string;
  attempt: PaymentSubscriptionCollectionAttemptRow;
}): Promise<CollectionResult | null> {
  if (!input.attempt.transfer_id) {
    return null;
  }

  const transfer = await createPaymentsRepository(input.env).getTransferById({
    transferId: input.attempt.transfer_id,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (!transfer) {
    return null;
  }

  const activeCollectOperationAttempt =
    input.attempt.signature || transfer.signature
      ? null
      : await getActiveRecurringCollectOperationAttempt({
          env: input.env,
          organizationId: input.organizationId,
          projectId: input.projectId,
          recurringPaymentId: input.recurringPayment.id,
        });
  const signature =
    input.attempt.signature ?? transfer.signature ?? activeCollectOperationAttempt?.signature;
  if (!signature) {
    return null;
  }

  const destinationTokenAccount =
    getStringMetadataValue(input.attempt.metadata, "destinationTokenAccount") ??
    input.recurringPayment.destination_token_account;
  if (!destinationTokenAccount) {
    return null;
  }

  return finalizeRecurringCollection({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: input.recurringPayment,
    subscriptionId: input.subscriptionId,
    attempt: input.attempt,
    transfer,
    dueAt: input.dueAt,
    signature,
    slot:
      transfer.slot ??
      getNumberMetadataValue(input.attempt.metadata, "collectionSlot") ??
      activeCollectOperationAttempt?.slot ??
      null,
    blockTime:
      transfer.block_time ??
      getStringMetadataValue(input.attempt.metadata, "collectionBlockTime") ??
      activeCollectOperationAttempt?.block_time ??
      null,
    destinationTokenAccount,
  });
}

async function pauseRecurringPaymentAfterRetryBackoffFailure(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  dueAt: string;
}): Promise<boolean> {
  try {
    return await getDb(input.env).transaction(async (tx) => {
      const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
      const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
      const now = new Date().toISOString();
      const recurringPayment = await txRecurringRepo.getRecurringPaymentById({
        recurringPaymentId: input.recurringPayment.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
      const subscription = await txSubscriptionsRepo.getSubscriptionById({
        subscriptionId: input.subscriptionId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });

      if (!recurringPayment || !subscription) {
        throw new AppError("NOT_FOUND", "Recurring payment collection state not found");
      }
      if (
        recurringPayment.status !== "active" ||
        recurringPayment.next_collection_due_at !== input.dueAt ||
        subscription.status !== "active" ||
        subscription.next_collection_due_at !== input.dueAt
      ) {
        return false;
      }

      const pausedRecurringPayment = await txRecurringRepo.updateRecurringPayment({
        recurringPaymentId: input.recurringPayment.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        expectedStatus: "active",
        expectedNextCollectionDueAt: input.dueAt,
        status: "paused",
        updatedAt: now,
      });
      const pausedSubscription = await txSubscriptionsRepo.updateSubscription({
        subscriptionId: input.subscriptionId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        expectedStatus: "active",
        expectedNextCollectionDueAt: input.dueAt,
        status: "paused",
        updatedAt: now,
      });

      return Boolean(pausedRecurringPayment && pausedSubscription);
    });
  } catch (error) {
    console.warn("Failed to pause recurring payment after retry backoff marker failure", {
      recurringPaymentId: input.recurringPayment.id,
      dueAt: input.dueAt,
      error: toErrorMessage(error),
    });
    return false;
  }
}

async function createFailedCollectionAttemptForRetry(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  dueAt: string;
  error: string;
  initiatedByKeyId?: string | null;
}) {
  const now = new Date().toISOString();
  const recordAttempt = () =>
    createPaymentSubscriptionsRepository(input.env).createCollectionAttempt({
      id: `psca_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId: input.subscriptionId,
      recurringPaymentId: input.recurringPayment.id,
      transferId: null,
      token: input.recurringPayment.token,
      amount: input.recurringPayment.amount,
      dueAt: input.dueAt,
      attemptedAt: now,
      status: "failed",
      signature: null,
      error: input.error,
      metadata: {
        source: "recurring_payments",
        initiatedByKeyId: input.initiatedByKeyId ?? null,
      },
      createdAt: now,
      updatedAt: now,
    });

  try {
    await recordAttempt();
  } catch (recordError) {
    console.error("Failed to record recurring collection retry backoff attempt", {
      recurringPaymentId: input.recurringPayment.id,
      dueAt: input.dueAt,
      originalError: input.error,
      error: recordError instanceof Error ? recordError.message : String(recordError),
    });
    try {
      await recordAttempt();
    } catch (retryError) {
      const pausedForReconciliation = await pauseRecurringPaymentAfterRetryBackoffFailure(input);
      console.error("Recurring collection failed before retry marker could be persisted", {
        recurringPaymentId: input.recurringPayment.id,
        dueAt: input.dueAt,
        originalError: input.error,
        recordError: toErrorMessage(recordError),
        retryError: toErrorMessage(retryError),
        pausedForReconciliation,
      });
      throw new AppError(
        "INTERNAL_ERROR",
        `Recurring collection failed and retry backoff could not be recorded: ${input.error}`,
        {
          recurringPaymentId: input.recurringPayment.id,
          dueAt: input.dueAt,
          originalError: input.error,
          recordError: toErrorMessage(recordError),
          retryError: toErrorMessage(retryError),
          pausedForReconciliation,
        }
      );
    }
  }
}

async function resolveStaleUnsignedProcessingAttempt(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  retryAfter: string;
}): Promise<boolean> {
  if (!isStaleUnsignedProcessingAttempt(input.attempt, input.retryAfter)) {
    return false;
  }

  const now = new Date().toISOString();
  if (!input.attempt.transfer_id) {
    const failedAttempt = await createPaymentSubscriptionsRepository(
      input.env
    ).updateCollectionAttempt({
      attemptId: input.attempt.id,
      status: "failed",
      error: "Stale recurring collection attempt expired before transfer submission",
      attemptedAt: now,
      updatedAt: now,
    });

    if (!failedAttempt) {
      throw new AppError("INTERNAL_ERROR", "Failed to expire stale collection attempt");
    }

    await failActiveRecurringCollectOperationAttempt({
      executor: getDb(input.env),
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      error: "Stale recurring collection attempt expired before transfer submission",
      updatedAt: now,
    });

    return true;
  }

  const message =
    "Stale recurring collection attempt has a linked transfer but no submission signature; paused for reconciliation";

  const cleanupResult = await getDb(input.env).transaction(async (tx) => {
    const txPaymentsRepo = createPostgresPaymentsRepository(tx);
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const currentRecurringPayment = await txRecurringRepo.getRecurringPaymentById({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    const currentSubscription = await txSubscriptionsRepo.getSubscriptionById({
      subscriptionId: input.subscriptionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (!currentRecurringPayment || !currentSubscription) {
      throw new AppError("NOT_FOUND", "Recurring payment collection state not found");
    }

    const updatedTransfer = await txPaymentsRepo.updateTransfer({
      transferId: input.attempt.transfer_id ?? "",
      status: "failed",
      error: message,
      updatedAt: now,
    });
    const failedAttempt = await txSubscriptionsRepo.updateCollectionAttempt({
      attemptId: input.attempt.id,
      transferId: input.attempt.transfer_id,
      status: "failed",
      error: message,
      attemptedAt: now,
      updatedAt: now,
    });
    await failActiveRecurringCollectOperationAttempt({
      executor: tx,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      error: message,
      updatedAt: now,
    });
    const shouldPauseForReconciliation =
      currentRecurringPayment.status === "active" &&
      currentRecurringPayment.next_collection_due_at === input.attempt.due_at &&
      currentSubscription.status === "active" &&
      currentSubscription.next_collection_due_at === input.attempt.due_at;
    const pausedRecurringPayment = shouldPauseForReconciliation
      ? await txRecurringRepo.updateRecurringPayment({
          recurringPaymentId: input.recurringPayment.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          expectedStatus: "active",
          status: "paused",
          updatedAt: now,
        })
      : currentRecurringPayment;
    const pausedSubscription = shouldPauseForReconciliation
      ? await txSubscriptionsRepo.updateSubscription({
          subscriptionId: input.subscriptionId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          expectedStatus: "active",
          status: "paused",
          updatedAt: now,
        })
      : currentSubscription;

    if (!updatedTransfer || !failedAttempt || !pausedRecurringPayment || !pausedSubscription) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Failed to pause recurring payment with ambiguous collection attempt"
      );
    }

    return { pausedForReconciliation: shouldPauseForReconciliation };
  });

  if (!cleanupResult.pausedForReconciliation) {
    console.warn("Stale recurring collection attempt expired after lifecycle state changed", {
      recurringPaymentId: input.recurringPayment.id,
      attemptId: input.attempt.id,
      transferId: input.attempt.transfer_id,
    });

    throw new AppError(
      "CONFLICT",
      "Recurring payment collection state changed while expiring stale attempt"
    );
  }

  console.warn("Recurring payment paused for collection reconciliation", {
    recurringPaymentId: input.recurringPayment.id,
    attemptId: input.attempt.id,
    transferId: input.attempt.transfer_id,
  });

  throw new AppError(
    "CONFLICT",
    "Recurring payment collection paused for reconciliation after an ambiguous submission state"
  );
}

async function recoverActiveCollectionAttemptOrThrow(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  dueAt: string;
  attempt: PaymentSubscriptionCollectionAttemptRow | null;
  retryAfter: string;
}): Promise<CollectionResult | null> {
  if (!input.attempt || !isActiveCollectionAttempt(input.attempt)) {
    return null;
  }

  const recovered = await recoverSubmittedRecurringCollection({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: input.recurringPayment,
    subscriptionId: input.subscriptionId,
    dueAt: input.dueAt,
    attempt: input.attempt,
  });
  if (recovered) {
    return recovered;
  }

  const staleAttemptExpired = await resolveStaleUnsignedProcessingAttempt({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: input.recurringPayment,
    subscriptionId: input.subscriptionId,
    attempt: input.attempt,
    retryAfter: input.retryAfter,
  });
  if (staleAttemptExpired) {
    return null;
  }

  throw new AppError("CONFLICT", "Collection attempt already exists for this due time");
}

async function createProcessingCollectionAttempt(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  dueAt: string;
}): Promise<PaymentSubscriptionCollectionAttemptRow> {
  const now = new Date().toISOString();
  return getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);

    await tx
      .prepare(
        `SELECT id
           FROM payment_recurring_payments
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
          FOR UPDATE`
      )
      .bind(input.recurringPayment.id, input.organizationId, input.projectId)
      .first();
    await tx
      .prepare(
        `SELECT id
           FROM payment_subscriptions
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
          FOR UPDATE`
      )
      .bind(input.subscriptionId, input.organizationId, input.projectId)
      .first();

    const currentRecurringPayment = await txRecurringRepo.getRecurringPaymentById({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    const currentSubscription = await txSubscriptionsRepo.getSubscriptionById({
      subscriptionId: input.subscriptionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });

    if (!currentRecurringPayment || !currentSubscription) {
      throw new AppError("NOT_FOUND", "Recurring payment collection state not found");
    }
    if (
      currentRecurringPayment.status !== "active" ||
      currentRecurringPayment.next_collection_due_at !== input.dueAt ||
      currentSubscription.status !== "active" ||
      currentSubscription.next_collection_due_at !== input.dueAt
    ) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment collection state changed before the attempt was claimed"
      );
    }
    const existingActiveAttempt = await tx.queryOne<{ id: string }>(
      `SELECT id
         FROM payment_subscription_collection_attempts
        WHERE organization_id = ?
          AND project_id = ?
          AND recurring_payment_id = ?
          AND due_at = ?
          AND status IN ('pending', 'processing', 'confirmed')
        ORDER BY updated_at DESC
        LIMIT 1
        FOR UPDATE`,
      [input.organizationId, input.projectId, input.recurringPayment.id, input.dueAt]
    );
    if (existingActiveAttempt) {
      throw new AppError("CONFLICT", "Collection attempt already exists for this due time");
    }
    await assertNoActiveRecurringOperationAttempt({
      executor: tx,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
    });

    const operationAttemptId = `prlo_${crypto.randomUUID()}`;
    await tx
      .prepare(
        `INSERT INTO payment_recurring_operation_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           operation,
           status,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, 'collect', 'processing', ?, ?)`
      )
      .bind(
        operationAttemptId,
        input.organizationId,
        input.projectId,
        input.recurringPayment.id,
        now,
        now
      )
      .run();

    const attempt = await txSubscriptionsRepo.createCollectionAttempt({
      id: `psca_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId: input.subscriptionId,
      recurringPaymentId: input.recurringPayment.id,
      transferId: null,
      token: input.recurringPayment.token,
      amount: input.recurringPayment.amount,
      dueAt: input.dueAt,
      attemptedAt: now,
      status: "processing",
      signature: null,
      error: null,
      metadata: { source: "recurring_payments" },
      createdAt: now,
      updatedAt: now,
    });

    if (!attempt) {
      throw new AppError("CONFLICT", "Collection attempt already exists for this due time");
    }

    return attempt;
  });
}

async function createTransferAndLinkCollectionAttempt(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  initiatedByKeyId?: string | null;
}): Promise<{
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
}> {
  let transferId: string | null = null;

  try {
    return await getDb(input.env).transaction(async (tx) => {
      const txPaymentsRepo = createPostgresPaymentsRepository(tx);
      const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
      const now = new Date().toISOString();
      const transfer = await createTransferRecord({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPayment: input.recurringPayment,
        status: "processing",
        initiatedByKeyId: input.initiatedByKeyId ?? null,
        paymentsRepo: txPaymentsRepo,
        createdAt: now,
      });
      transferId = transfer.id;
      const attempt = await txSubscriptionsRepo.updateCollectionAttempt({
        attemptId: input.attempt.id,
        transferId: transfer.id,
        status: "processing",
        attemptedAt: now,
        updatedAt: now,
      });

      if (!attempt) {
        throw new AppError("INTERNAL_ERROR", "Failed to update collection attempt");
      }

      return { attempt, transfer };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await getDb(input.env).transaction(async (tx) => {
        const txPaymentsRepo = createPostgresPaymentsRepository(tx);
        const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
        const now = new Date().toISOString();
        await txSubscriptionsRepo.updateCollectionAttempt({
          attemptId: input.attempt.id,
          transferId,
          status: "failed",
          error: message,
          attemptedAt: now,
          updatedAt: now,
        });
        if (transferId) {
          await txPaymentsRepo.updateTransfer({
            transferId,
            status: "failed",
            error: message,
            updatedAt: now,
          });
        }
        await failActiveRecurringCollectOperationAttempt({
          executor: tx,
          organizationId: input.organizationId,
          projectId: input.projectId,
          recurringPaymentId: input.recurringPayment.id,
          error: message,
          updatedAt: now,
        });
      });
    } catch (cleanupError) {
      console.warn("Failed to mark collection attempt failed after transfer-link error", {
        recurringPaymentId: input.recurringPayment.id,
        attemptId: input.attempt.id,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }

    throw error;
  }
}

async function assertRecurringCollectionClaimStillActive(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  subscriptionId: string;
  attemptId: string;
  transferId: string;
  dueAt: string;
}) {
  await getDb(input.env).transaction(async (tx) => {
    const recurringPayment = await tx.queryOne<{
      status: string;
      next_collection_due_at: string | null;
    }>(
      `SELECT status, next_collection_due_at
         FROM payment_recurring_payments
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?
        FOR UPDATE`,
      [input.recurringPaymentId, input.organizationId, input.projectId]
    );
    const subscription = await tx.queryOne<{
      status: string;
      next_collection_due_at: string | null;
    }>(
      `SELECT status, next_collection_due_at
         FROM payment_subscriptions
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?
        FOR UPDATE`,
      [input.subscriptionId, input.organizationId, input.projectId]
    );
    const attempt = await tx.queryOne<{
      status: string;
      transfer_id: string | null;
      signature: string | null;
    }>(
      `SELECT status, transfer_id, signature
         FROM payment_subscription_collection_attempts
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?
          AND recurring_payment_id = ?
          AND due_at = ?
        FOR UPDATE`,
      [
        input.attemptId,
        input.organizationId,
        input.projectId,
        input.recurringPaymentId,
        input.dueAt,
      ]
    );
    const operationAttempt = await tx.queryOne<RecurringOperationAttemptClaim>(
      `SELECT id, operation, status, signature, slot, block_time, updated_at
         FROM payment_recurring_operation_attempts
        WHERE organization_id = ?
          AND project_id = ?
          AND recurring_payment_id = ?
          AND operation = 'collect'
          AND status = 'processing'
        ORDER BY updated_at DESC
        LIMIT 1
        FOR UPDATE`,
      [input.organizationId, input.projectId, input.recurringPaymentId]
    );

    if (!recurringPayment || !subscription || !attempt || !operationAttempt) {
      throw new AppError("NOT_FOUND", "Recurring payment collection claim not found");
    }
    if (
      recurringPayment.status !== "active" ||
      recurringPayment.next_collection_due_at !== input.dueAt ||
      subscription.status !== "active" ||
      subscription.next_collection_due_at !== input.dueAt ||
      attempt.status !== "processing" ||
      attempt.transfer_id !== input.transferId ||
      attempt.signature !== null
    ) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment collection state changed before on-chain submission"
      );
    }
  });
}

async function assertRecurringLifecycleClaimStillActive(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  operation: RecurringLifecycleOperation;
  lifecycleAttemptId: string;
}) {
  const claimStatus = getLifecycleClaimStatus(input.operation);

  await getDb(input.env).transaction(async (tx) => {
    const recurringPayment = await tx.queryOne<{
      status: string;
      next_collection_due_at: string | null;
    }>(
      `SELECT status, next_collection_due_at
         FROM payment_recurring_payments
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?
        FOR UPDATE`,
      [input.recurringPayment.id, input.organizationId, input.projectId]
    );
    const subscription = await tx.queryOne<{
      status: string;
      next_collection_due_at: string | null;
    }>(
      `SELECT status, next_collection_due_at
         FROM payment_subscriptions
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?
        FOR UPDATE`,
      [input.subscription.id, input.organizationId, input.projectId]
    );
    const operationAttempt = await tx.queryOne<{
      status: string;
      signature: string | null;
    }>(
      `SELECT status, signature
         FROM payment_recurring_operation_attempts
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?
          AND recurring_payment_id = ?
          AND operation = ?
        FOR UPDATE`,
      [
        input.lifecycleAttemptId,
        input.organizationId,
        input.projectId,
        input.recurringPayment.id,
        input.operation,
      ]
    );

    if (!recurringPayment || !subscription || !operationAttempt) {
      throw new AppError("NOT_FOUND", "Recurring payment lifecycle claim not found");
    }

    const subscriptionStillClaimed =
      input.operation === "cancel"
        ? subscription.status === "canceling" &&
          subscription.next_collection_due_at === input.recurringPayment.next_collection_due_at
        : subscription.status === input.subscription.status &&
          subscription.next_collection_due_at === input.recurringPayment.next_collection_due_at;

    if (
      recurringPayment.status !== claimStatus ||
      recurringPayment.next_collection_due_at !== input.recurringPayment.next_collection_due_at ||
      !subscriptionStillClaimed ||
      operationAttempt.status !== "processing" ||
      operationAttempt.signature !== null
    ) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment lifecycle state changed before on-chain submission"
      );
    }
  });
}

export async function createRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  counterpartyId: string;
  counterpartyAccountId: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt?: string | null;
  metadataUri?: string | null;
  createdBy: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  assertSubscriptionTokenMint(input.token);

  const destination = await resolveSolanaCounterpartyAccount({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    counterpartyId: input.counterpartyId,
    counterpartyAccountId: input.counterpartyAccountId,
  });
  await assertWalletPolicyAllowsTransferWithRepository(createPaymentsRepository(input.env), {
    organizationId: input.organizationId,
    projectId: input.projectId,
    wallet: input.sourceWallet,
    destinationAddress: destination.destinationAddress,
    enforceDailyLimit: false,
    token: input.token,
    amount: input.amount,
  });

  const now = new Date().toISOString();
  const recurringPayment = await createPaymentRecurringPaymentsRepository(
    input.env
  ).createRecurringPayment({
    id: `prp_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWalletId: input.sourceWallet.walletId,
    sourceAddress: input.sourceWallet.publicKey,
    counterpartyId: input.counterpartyId,
    counterpartyAccountId: input.counterpartyAccountId,
    destinationAddress: destination.destinationAddress,
    token: input.token,
    amount: input.amount,
    periodHours: input.periodHours,
    firstCollectionAt: input.firstCollectionAt ?? null,
    metadataUri: input.metadataUri ?? null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });

  if (!recurringPayment) {
    throw new AppError("INTERNAL_ERROR", "Failed to create recurring payment");
  }

  return recurringPayment;
}

export async function activateRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
}): Promise<ActivationResult> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  let recurringPayment = await recurringRepo.getRecurringPaymentById({
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }
  if (recurringPayment.status === "active") {
    return { recurringPayment };
  }
  if (
    recurringPayment.status !== "pending_activation" &&
    recurringPayment.status !== "activating"
  ) {
    throw new AppError(
      "BAD_REQUEST",
      "Recurring payment cannot be activated from its current status"
    );
  }

  const sourceAddress = assertValidAddress(recurringPayment.source_address, "sourceAddress");
  let sourceSigner: Awaited<ReturnType<typeof getSourceSigner>>;
  let runtime: Awaited<ReturnType<typeof resolveRecurringSubscriptionRuntime>>;
  let destinationTokenAccount: Awaited<ReturnType<typeof deriveAssociatedTokenAccount>>;
  try {
    sourceSigner = await getSourceSigner({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWalletId: recurringPayment.source_wallet_id,
      expectedAddress: sourceAddress,
    });
    runtime = await resolveRecurringSubscriptionRuntime(input.env, recurringPayment);
    const destinationAddress = assertValidAddress(
      recurringPayment.destination_address,
      "destinationAddress"
    );
    destinationTokenAccount = await deriveAssociatedTokenAccount({
      owner: destinationAddress,
      runtime,
    });
  } catch (error) {
    await deferStaleActivationClaim({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
    });
    throw error;
  }

  const activation = await claimActivationRecords({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: recurringPayment.id,
    destinationTokenAccount,
    subscriberTokenAccount: runtime.sourceTokenAccount,
  });

  if (activation.alreadyActive) {
    return { recurringPayment: activation.recurringPayment };
  }

  recurringPayment = activation.recurringPayment;
  const { plan, subscription } = activation;

  const onChainPlan = await ensureSubscriptionPlanOnChain({
    env: input.env,
    sourceSigner,
    sourceAddress,
    destinationTokenAccount,
    programPlanId: plan.program_plan_id,
    metadataUri: recurringPayment.metadata_uri ?? "",
    runtime,
    periodHours: recurringPayment.period_hours,
    existingSignature: recurringPayment.plan_creation_signature,
  });
  await persistActivationPlanRecoveryMarker({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment,
    plan,
    destinationTokenAccount,
    planPda: String(onChainPlan.planPda),
    planCreatedAt: onChainPlan.planCreatedAt.toString(),
    signature: onChainPlan.signature ?? recurringPayment.plan_creation_signature ?? null,
  });

  const onChainAuthorization = await ensureSubscriptionAuthorizationOnChain({
    env: input.env,
    sourceSigner,
    sourceAddress,
    sourceTokenAccount: runtime.sourceTokenAccount,
    planId: onChainPlan.planId,
    planPda: onChainPlan.planPda,
    planCreatedAt: onChainPlan.planCreatedAt,
    runtime,
    periodHours: recurringPayment.period_hours,
    existingSignature:
      recurringPayment.authorization_signature ?? subscription.authorization_signature,
  });
  await persistActivationAuthorizationRecoveryMarker({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment,
    subscription,
    sourceTokenAccount: String(runtime.sourceTokenAccount),
    subscriptionPda: String(onChainAuthorization.subscriptionPda),
    subscriptionAuthorityAddress: String(onChainAuthorization.subscriptionAuthorityAddress),
    signature:
      onChainAuthorization.signature ??
      recurringPayment.authorization_signature ??
      subscription.authorization_signature ??
      null,
  });
  const activationNow = new Date().toISOString();
  const dueAt = recurringPayment.first_collection_at
    ? advanceCollectionDueAtAfter({
        nextCollectionDueAt: recurringPayment.first_collection_at,
        periodHours: recurringPayment.period_hours,
        after: activationNow,
      })
    : activationNow;
  const currentPeriodStartAt = addPeriodHours(dueAt, -recurringPayment.period_hours);
  const claimedRecurringPayment = recurringPayment;
  recurringPayment = await getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const updatedAt = new Date().toISOString();
    const updatedPlan = await txSubscriptionsRepo.updatePlan({
      planId: plan.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planPda: onChainPlan.planPda,
      destinationAddress: destinationTokenAccount,
      pullerWalletId: claimedRecurringPayment.source_wallet_id,
      pullerAddress: claimedRecurringPayment.source_address,
      status: "active",
      updatedAt,
    });
    const updatedSubscription = await txSubscriptionsRepo.updateSubscription({
      subscriptionId: subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriberTokenAccount: runtime.sourceTokenAccount,
      subscriptionPda: onChainAuthorization.subscriptionPda,
      subscriptionAuthorityAddress: onChainAuthorization.subscriptionAuthorityAddress,
      authorizationSignature:
        onChainAuthorization.signature ?? subscription.authorization_signature,
      status: "active",
      currentPeriodStartAt,
      nextCollectionDueAt: dueAt,
      updatedAt,
    });
    const updatedRecurringPayment = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: claimedRecurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      destinationTokenAccount,
      nextCollectionDueAt: dueAt,
      planId: plan.id,
      subscriptionId: subscription.id,
      planPda: onChainPlan.planPda,
      planCreatedAt: onChainPlan.planCreatedAt.toString(),
      planCreationSignature:
        onChainPlan.signature ?? claimedRecurringPayment.plan_creation_signature ?? null,
      subscriptionPda: onChainAuthorization.subscriptionPda,
      subscriptionAuthorityAddress: onChainAuthorization.subscriptionAuthorityAddress,
      authorizationSignature:
        onChainAuthorization.signature ??
        claimedRecurringPayment.authorization_signature ??
        subscription.authorization_signature ??
        null,
      status: "active",
      updatedAt,
    });

    if (!updatedPlan || !updatedSubscription || !updatedRecurringPayment) {
      throw new AppError("INTERNAL_ERROR", "Failed to activate subscription records");
    }

    return updatedRecurringPayment;
  });

  return {
    recurringPayment,
    planSignature: onChainPlan.signature,
    authorizationSignature: onChainAuthorization.signature,
  };
}

export async function collectRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  initiatedByKeyId?: string | null;
  enforceDue?: boolean;
  sourceWallet?: CustodyWallet;
}): Promise<CollectionResult> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const subscriptionsRepo = createPaymentSubscriptionsRepository(input.env);
  const recurringPayment = await recurringRepo.getRecurringPaymentById({
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }
  if (
    !recurringPayment.subscription_id ||
    !recurringPayment.plan_pda ||
    !recurringPayment.subscription_pda
  ) {
    throw new AppError("BAD_REQUEST", "Recurring payment has not been activated");
  }
  if (!recurringPayment.next_collection_due_at) {
    throw new AppError("BAD_REQUEST", "Recurring payment has no due collection");
  }

  const subscriptionId = recurringPayment.subscription_id;
  const dueAt = recurringPayment.next_collection_due_at;
  const retryAfter = getCollectionRetryAfter(input.env);

  let attempt = await subscriptionsRepo.getCollectionAttemptByRecurringDue({
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: recurringPayment.id,
    dueAt,
  });

  const recoveredExisting = await recoverActiveCollectionAttemptOrThrow({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment,
    subscriptionId,
    dueAt,
    attempt,
    retryAfter,
  });
  if (recoveredExisting) {
    return recoveredExisting;
  }
  if (recurringPayment.status !== "active") {
    throw new AppError("BAD_REQUEST", "Recurring payment must be active before collection");
  }
  if (input.enforceDue !== false && new Date(dueAt).getTime() > Date.now()) {
    throw new AppError("BAD_REQUEST", "Recurring payment is not due for collection");
  }

  const sourceAddress = assertValidAddress(recurringPayment.source_address, "sourceAddress");
  const destinationAddress = assertValidAddress(
    recurringPayment.destination_address,
    "destinationAddress"
  );
  let sourceWallet: CustodyWallet;
  try {
    sourceWallet =
      input.sourceWallet ??
      (await resolveSourceWalletForExecution({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWalletId: recurringPayment.source_wallet_id,
      }));
  } catch (error) {
    await createFailedCollectionAttemptForRetry({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      subscriptionId,
      dueAt,
      error: toErrorMessage(error),
      initiatedByKeyId: input.initiatedByKeyId ?? null,
    });

    throw error;
  }
  try {
    await assertWalletPolicyAllowsTransferWithRepository(createPaymentsRepository(input.env), {
      organizationId: input.organizationId,
      projectId: input.projectId,
      wallet: sourceWallet,
      destinationAddress,
      token: recurringPayment.token,
      amount: recurringPayment.amount,
    });
  } catch (error) {
    await createFailedCollectionAttemptForRetry({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      subscriptionId,
      dueAt,
      error: toErrorMessage(error),
      initiatedByKeyId: input.initiatedByKeyId ?? null,
    });

    throw error;
  }
  let planPda: ReturnType<typeof assertValidAddress>;
  let subscriptionPda: ReturnType<typeof assertValidAddress>;
  let sourceSigner: Awaited<ReturnType<typeof getSourceSigner>>;
  let runtime: Awaited<ReturnType<typeof resolveRecurringSubscriptionRuntime>>;
  try {
    planPda = assertValidAddress(recurringPayment.plan_pda, "planPda");
    subscriptionPda = assertValidAddress(recurringPayment.subscription_pda, "subscriptionPda");
    await assertRecurringPaymentNotCanceledOnChain({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      subscriptionId,
      sourceAddress,
      planPda,
      subscriptionPda,
    });
    sourceSigner = await getSourceSigner({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWalletId: recurringPayment.source_wallet_id,
      expectedAddress: sourceAddress,
    });
    runtime = await resolveRecurringSubscriptionRuntime(input.env, recurringPayment);
  } catch (error) {
    await createFailedCollectionAttemptForRetry({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      subscriptionId,
      dueAt,
      error: toErrorMessage(error),
      initiatedByKeyId: input.initiatedByKeyId ?? null,
    });

    throw error;
  }

  try {
    attempt = await createProcessingCollectionAttempt({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      subscriptionId,
      dueAt,
    });
  } catch (error) {
    const conflictingAttempt = await subscriptionsRepo.getCollectionAttemptByRecurringDue({
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: recurringPayment.id,
      dueAt,
    });
    const recoveredConflict = await recoverActiveCollectionAttemptOrThrow({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      subscriptionId,
      dueAt,
      attempt: conflictingAttempt,
      retryAfter,
    });
    if (recoveredConflict) {
      return recoveredConflict;
    }

    await createFailedCollectionAttemptForRetry({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      subscriptionId,
      dueAt,
      error: toErrorMessage(error),
      initiatedByKeyId: input.initiatedByKeyId ?? null,
    });

    throw error;
  }

  const linked = await createTransferAndLinkCollectionAttempt({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment,
    attempt,
    initiatedByKeyId: input.initiatedByKeyId ?? null,
  });
  let collectionAttempt: PaymentSubscriptionCollectionAttemptRow = linked.attempt;
  let transfer = linked.transfer;

  // Last no-money-moved checkpoint: if lifecycle state changed after the
  // transfer was linked, fail the DB records before signing anything on-chain.
  try {
    await assertRecurringCollectionClaimStillActive({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: recurringPayment.id,
      subscriptionId,
      attemptId: collectionAttempt.id,
      transferId: transfer.id,
      dueAt,
    });
  } catch (error) {
    await markRecurringCollectionFailedBeforeSubmission({
      env: input.env,
      attempt: collectionAttempt,
      transfer,
      error: toErrorMessage(error),
    });

    throw error;
  }

  const collectionExecution = await executeRecurringCollectionOnChainWithRecoveryMarker({
    env: input.env,
    recurringPaymentId: recurringPayment.id,
    attempt: collectionAttempt,
    transfer,
    sourceSigner,
    sourceAddress,
    destinationAddress,
    planPda,
    subscriptionPda,
    runtime,
  });
  const { executed } = collectionExecution;
  collectionAttempt = collectionExecution.attempt;
  transfer = collectionExecution.transfer;

  let submitted = await markRecurringCollectionSubmitted({
    env: input.env,
    attempt: collectionAttempt,
    transfer,
    signature: executed.signature,
    slot: executed.slot,
    blockTime: executed.blockTime,
    destinationTokenAccount: String(executed.destinationTokenAccount),
  });
  collectionAttempt = submitted.attempt;
  transfer = submitted.transfer;

  try {
    return await finalizeRecurringCollection({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      subscriptionId,
      attempt: collectionAttempt,
      transfer,
      dueAt,
      signature: executed.signature,
      slot: executed.slot,
      blockTime: executed.blockTime,
      destinationTokenAccount: String(executed.destinationTokenAccount),
    });
  } catch (error) {
    if (!submitted.hasAttemptRecoveryMarker) {
      submitted = await markRecurringCollectionSubmitted({
        env: input.env,
        attempt: collectionAttempt,
        transfer,
        signature: executed.signature,
        slot: executed.slot,
        blockTime: executed.blockTime,
        destinationTokenAccount: String(executed.destinationTokenAccount),
      });
      collectionAttempt = submitted.attempt;
      transfer = submitted.transfer;
    }

    try {
      const recovered = await recoverSubmittedRecurringCollection({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPayment,
        subscriptionId,
        dueAt,
        attempt: collectionAttempt,
      });
      if (recovered) {
        return recovered;
      }
    } catch (retryError) {
      console.error("Recurring collection finalized on-chain but DB recovery retry failed", {
        recurringPaymentId: recurringPayment.id,
        attemptId: collectionAttempt.id,
        transferId: transfer.id,
        signature: executed.signature,
        hasRecoveryMarker: submitted.hasRecoveryMarker,
        hasAttemptRecoveryMarker: submitted.hasAttemptRecoveryMarker,
        originalError: toErrorMessage(error),
        retryError: toErrorMessage(retryError),
      });
      throw new AppError(
        "INTERNAL_ERROR",
        "Recurring collection finalized on-chain but DB finalization could not be recovered",
        {
          recurringPaymentId: recurringPayment.id,
          attemptId: collectionAttempt.id,
          transferId: transfer.id,
          signature: executed.signature,
          originalError: toErrorMessage(error),
          retryError: toErrorMessage(retryError),
        }
      );
    }

    console.error("Recurring collection finalized on-chain but no recovery marker was readable", {
      recurringPaymentId: recurringPayment.id,
      attemptId: collectionAttempt.id,
      transferId: transfer.id,
      signature: executed.signature,
      hasRecoveryMarker: submitted.hasRecoveryMarker,
      hasAttemptRecoveryMarker: submitted.hasAttemptRecoveryMarker,
      error: toErrorMessage(error),
    });

    throw new AppError(
      "INTERNAL_ERROR",
      "Recurring collection finalized on-chain but no recovery marker was readable",
      {
        recurringPaymentId: recurringPayment.id,
        attemptId: collectionAttempt.id,
        transferId: transfer.id,
        signature: executed.signature,
        originalError: toErrorMessage(error),
      }
    );
  }
}

async function assertPendingResumeLifecycleCanProceed(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  operation: RecurringLifecycleOperation;
  lifecycleAttemptSubmitted: boolean;
  lifecycleAttemptId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  sourceAddress: ReturnType<typeof assertValidAddress>;
  planPda: ReturnType<typeof assertValidAddress>;
  subscriptionPda: ReturnType<typeof assertValidAddress>;
}) {
  if (input.operation !== "resume" || input.lifecycleAttemptSubmitted) {
    return;
  }

  try {
    await assertRecurringPaymentCanResumeOnChain({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: input.recurringPayment,
      subscriptionId: input.subscription.id,
      sourceAddress: input.sourceAddress,
      planPda: input.planPda,
      subscriptionPda: input.subscriptionPda,
    });
  } catch (error) {
    try {
      await markRecurringLifecycleAttemptFailed({
        env: input.env,
        attemptId: input.lifecycleAttemptId,
        error: toErrorMessage(error),
      });
    } catch (markerError) {
      console.warn("Failed to mark recurring lifecycle attempt failed after preflight error", {
        recurringPaymentId: input.recurringPayment.id,
        attemptId: input.lifecycleAttemptId,
        operation: input.operation,
        error: toErrorMessage(markerError),
      });
    }
    throw error;
  }
}

async function reconcileCanceledLifecycleBeforeSubmission(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  operation: RecurringLifecycleOperation;
  lifecycleAttemptSubmitted: boolean;
  lifecycleAttemptId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  sourceAddress: ReturnType<typeof assertValidAddress>;
  planPda: ReturnType<typeof assertValidAddress>;
  subscriptionPda: ReturnType<typeof assertValidAddress>;
}): Promise<PaymentRecurringPaymentRow | null> {
  if (input.operation !== "cancel" || input.lifecycleAttemptSubmitted) {
    return null;
  }

  const reconciledCanceledPayment = await reconcileCanceledRecurringPaymentFromChain({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: input.recurringPayment,
    subscriptionId: input.subscription.id,
    sourceAddress: input.sourceAddress,
    planPda: input.planPda,
    subscriptionPda: input.subscriptionPda,
    finalizeLifecycleOperation: true,
  });
  if (reconciledCanceledPayment?.status !== "canceled") {
    return null;
  }

  try {
    await markRecurringLifecycleAttemptFinalized({
      env: input.env,
      attemptId: input.lifecycleAttemptId,
    });
  } catch (error) {
    console.warn("Failed to mark reconciled recurring cancel attempt confirmed", {
      recurringPaymentId: input.recurringPayment.id,
      attemptId: input.lifecycleAttemptId,
      error: toErrorMessage(error),
    });
  }

  return reconciledCanceledPayment;
}

export async function executeRecurringPaymentLifecycle(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  operation: "cancel" | "resume";
}): Promise<PaymentRecurringPaymentRow> {
  const claim = await claimLifecycleRecords({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPaymentId,
    operation: input.operation,
  });

  if (claim.alreadyFinalized) {
    return claim.recurringPayment;
  }

  if (!claim.recurringPayment.plan_pda || !claim.recurringPayment.subscription_pda) {
    throw new AppError("BAD_REQUEST", "Recurring payment has not been activated");
  }
  const planPda = assertValidAddress(claim.recurringPayment.plan_pda, "planPda");
  const subscriptionPda = assertValidAddress(
    claim.recurringPayment.subscription_pda,
    "subscriptionPda"
  );
  const sourceAddress = assertValidAddress(claim.recurringPayment.source_address, "sourceAddress");
  if (!claim.lifecycleAttemptId) {
    throw new AppError("INTERNAL_ERROR", "Recurring lifecycle attempt was not created");
  }
  const lifecycleAttemptId = claim.lifecycleAttemptId;

  let lifecycleAttemptSubmitted = claim.lifecycleAttemptSubmitted;
  let sourceSigner: Awaited<ReturnType<typeof getSourceSigner>> | null = null;
  await assertPendingResumeLifecycleCanProceed({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    operation: input.operation,
    lifecycleAttemptSubmitted,
    lifecycleAttemptId,
    recurringPayment: claim.recurringPayment,
    subscription: claim.subscription,
    sourceAddress,
    planPda,
    subscriptionPda,
  });
  const reconciledCanceledPayment = await reconcileCanceledLifecycleBeforeSubmission({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    operation: input.operation,
    lifecycleAttemptSubmitted,
    lifecycleAttemptId,
    recurringPayment: claim.recurringPayment,
    subscription: claim.subscription,
    sourceAddress,
    planPda,
    subscriptionPda,
  });
  if (reconciledCanceledPayment) {
    return reconciledCanceledPayment;
  }
  if (!lifecycleAttemptSubmitted) {
    // claimLifecycleRecords inserts this attempt in the same transaction as the
    // canceling/resuming status claim, so signer failures below have an audit row.
    try {
      sourceSigner = await getSourceSigner({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWalletId: claim.recurringPayment.source_wallet_id,
        expectedAddress: sourceAddress,
      });
    } catch (error) {
      try {
        await markRecurringLifecycleAttemptFailed({
          env: input.env,
          attemptId: lifecycleAttemptId,
          error: toErrorMessage(error),
        });
      } catch (markerError) {
        console.warn("Failed to mark recurring lifecycle attempt failed after signer error", {
          recurringPaymentId: claim.recurringPayment.id,
          attemptId: lifecycleAttemptId,
          operation: input.operation,
          error: toErrorMessage(markerError),
        });
      }
      throw error;
    }
  }

  let executed: ExecutedSubscriptionTransaction | null;
  let submittedLifecycleTransaction: SubmittedSubscriptionTransaction | null = null;
  try {
    if (lifecycleAttemptSubmitted) {
      const targetReached = await isSubscriptionLifecycleTargetReachedOnChain({
        env: input.env,
        operation: input.operation,
        sourceAddress,
        planPda,
        subscriptionPda,
      });
      if (!targetReached) {
        throw new AppError(
          "CONFLICT",
          "Recurring payment lifecycle transaction is still pending confirmation"
        );
      }
      executed = null;
    } else {
      if (!sourceSigner) {
        throw new AppError("INTERNAL_ERROR", "Recurring lifecycle signer was not resolved");
      }
      await assertRecurringLifecycleClaimStillActive({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPayment: claim.recurringPayment,
        subscription: claim.subscription,
        operation: input.operation,
        lifecycleAttemptId,
      });
      // claimLifecycleRecords commits the canceling/resuming status claim plus
      // the active operation-attempt mutex before this submission. That unique
      // active attempt blocks concurrent collect/cancel/resume work; onSubmitted
      // then persists the recovery marker before final confirmation.
      executed = await executeSubscriptionLifecycleOnChain({
        env: input.env,
        operation: input.operation,
        sourceSigner,
        planPda,
        subscriptionPda,
        onSubmitted: async (submitted) => {
          lifecycleAttemptSubmitted = true;
          submittedLifecycleTransaction = submitted;
          await markRecurringLifecycleAttemptSubmitted({
            env: input.env,
            attemptId: lifecycleAttemptId,
            executed: { ...submitted, slot: null, blockTime: null },
          });
        },
      });
    }
  } catch (error) {
    if (lifecycleAttemptSubmitted) {
      await retryPersistRecurringLifecycleSubmittedMarker({
        env: input.env,
        recurringPaymentId: claim.recurringPayment.id,
        attemptId: lifecycleAttemptId,
        operation: input.operation,
        submitted: submittedLifecycleTransaction,
      });
      console.error("Recurring lifecycle submitted on-chain but confirmation failed", {
        recurringPaymentId: claim.recurringPayment.id,
        attemptId: lifecycleAttemptId,
        operation: input.operation,
        error: toErrorMessage(error),
      });
    } else {
      try {
        await markRecurringLifecycleAttemptFailed({
          env: input.env,
          attemptId: lifecycleAttemptId,
          error: toErrorMessage(error),
        });
      } catch (markerError) {
        console.warn("Failed to mark recurring lifecycle attempt failed", {
          recurringPaymentId: claim.recurringPayment.id,
          attemptId: lifecycleAttemptId,
          operation: input.operation,
          error: toErrorMessage(markerError),
        });
      }
    }
    throw error;
  }
  if (executed) {
    try {
      await markRecurringLifecycleAttemptSubmitted({
        env: input.env,
        attemptId: lifecycleAttemptId,
        executed,
      });
    } catch (error) {
      console.error("Failed to persist recurring lifecycle submission marker", {
        recurringPaymentId: claim.recurringPayment.id,
        attemptId: lifecycleAttemptId,
        operation: input.operation,
        error: toErrorMessage(error),
      });
    }
  }

  const recurringPayment = await finalizeRecurringPaymentLifecycleAfterChain({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: claim.recurringPayment,
    subscription: claim.subscription,
    operation: input.operation,
    lifecycleAttemptId,
    sourceAddress,
    planPda,
    subscriptionPda,
  });

  return recurringPayment;
}
