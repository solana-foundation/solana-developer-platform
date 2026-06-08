import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
} from "@/db/repositories";
import { parsePositiveIntegerConfig } from "@/lib/config";
import {
  isRecurringPaymentCollectionEnabled,
  isRecurringPaymentsEnabled,
} from "@/lib/feature-flags";
import {
  activateRecurringPayment,
  collectRecurringPayment as collectRecurringPaymentRecord,
  executeRecurringPaymentLifecycle,
} from "@/services/payments/recurring-payments";
import type { Env } from "@/types/env";

const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 20;
const DEFAULT_RETRY_AFTER_MINUTES = 30;

type RecurringPaymentsRepository = ReturnType<typeof createPaymentRecurringPaymentsRepository>;
type PaymentSubscriptionsRepository = ReturnType<typeof createPaymentSubscriptionsRepository>;

interface RecurringPaymentCollectionJobResult {
  scanned: number;
  collected: number;
  failed: number;
  expirationFailures: number;
  activationRecovered: number;
  activationFailures: number;
  lifecycleRecovered: number;
  lifecycleFailures: number;
  submittedCollectionRecovered: number;
  submittedCollectionFailures: number;
  collectionFailures: number;
}

function emptyResult(): RecurringPaymentCollectionJobResult {
  return {
    scanned: 0,
    collected: 0,
    failed: 0,
    expirationFailures: 0,
    activationRecovered: 0,
    activationFailures: 0,
    lifecycleRecovered: 0,
    lifecycleFailures: 0,
    submittedCollectionRecovered: 0,
    submittedCollectionFailures: 0,
    collectionFailures: 0,
  };
}

function resolveBatchSize(env: Env): number {
  const requestedBatchSize = parsePositiveIntegerConfig(
    env.PAYMENTS_RECURRING_COLLECTION_BATCH_SIZE,
    DEFAULT_BATCH_SIZE
  );
  const batchSize = Math.min(requestedBatchSize, MAX_BATCH_SIZE);
  if (requestedBatchSize > MAX_BATCH_SIZE) {
    console.warn("Recurring payment collection batch size capped", {
      requestedBatchSize,
      maxBatchSize: MAX_BATCH_SIZE,
      // Collection runs sequential on-chain work on a five-minute cron tick.
      // Keep the batch bounded so slow confirmations do not routinely overlap
      // the next scheduled run.
      cronIntervalMinutes: 5,
    });
  }

  return batchSize;
}

async function expireStaleUnsignedAttempts(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  retryAfter: string;
  updatedAt: string;
  batchSize: number;
}): Promise<number> {
  try {
    const expiredAttempts = await input.subscriptionsRepo.expireStaleUnsignedProcessingAttempts({
      olderThan: input.retryAfter,
      updatedAt: input.updatedAt,
      limit: input.batchSize,
    });
    if (expiredAttempts > 0) {
      console.warn("Expired stale unsigned recurring collection attempts", {
        expiredAttempts,
        retryAfter: input.retryAfter,
      });
    }

    return 0;
  } catch (error) {
    console.warn("Failed to expire stale unsigned recurring collection attempts", {
      retryAfter: input.retryAfter,
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

async function deferFailedActivationRecovery(input: {
  recurringPaymentsRepo: RecurringPaymentsRepository;
  recurringPayment: Awaited<
    ReturnType<RecurringPaymentsRepository["listStaleActivationClaims"]>
  >[number];
  updatedAt: string;
  error: unknown;
}) {
  try {
    await input.recurringPaymentsRepo.updateRecurringPayment({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.recurringPayment.organization_id,
      projectId: input.recurringPayment.project_id,
      expectedStatus: "activating",
      updatedAt: input.updatedAt,
    });
  } catch (updateError) {
    console.warn("Failed to defer stale recurring payment activation recovery", {
      recurringPaymentId: input.recurringPayment.id,
      activationError: input.error instanceof Error ? input.error.message : String(input.error),
      updateError: updateError instanceof Error ? updateError.message : String(updateError),
    });
  }
}

async function recoverStaleActivationClaims(input: {
  env: Env;
  recurringPaymentsRepo: RecurringPaymentsRepository;
  retryAfter: string;
  updatedAt: string;
  batchSize: number;
}): Promise<{ scanned: number; recovered: number; failures: number }> {
  if (input.batchSize <= 0) {
    return { scanned: 0, recovered: 0, failures: 0 };
  }

  let staleActivationClaims: Awaited<
    ReturnType<RecurringPaymentsRepository["listStaleActivationClaims"]>
  > = [];
  try {
    staleActivationClaims = await input.recurringPaymentsRepo.listStaleActivationClaims({
      olderThan: input.retryAfter,
      limit: input.batchSize,
    });
  } catch (error) {
    console.warn("Failed to list stale recurring payment activation claims", {
      retryAfter: input.retryAfter,
      error: error instanceof Error ? error.message : String(error),
    });
    return { scanned: 0, recovered: 0, failures: 1 };
  }

  let recovered = 0;
  let failures = 0;
  for (const recurringPayment of staleActivationClaims) {
    try {
      await activateRecurringPayment({
        env: input.env,
        organizationId: recurringPayment.organization_id,
        projectId: recurringPayment.project_id,
        recurringPaymentId: recurringPayment.id,
      });
      recovered += 1;
    } catch (error) {
      failures += 1;
      await deferFailedActivationRecovery({
        recurringPaymentsRepo: input.recurringPaymentsRepo,
        recurringPayment,
        updatedAt: input.updatedAt,
        error,
      });
      console.warn("Recurring payment activation recovery failed", {
        recurringPaymentId: recurringPayment.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { scanned: staleActivationClaims.length, recovered, failures };
}

async function recoverStaleLifecycleClaims(input: {
  env: Env;
  recurringPaymentsRepo: RecurringPaymentsRepository;
  retryAfter: string;
  batchSize: number;
}): Promise<{ scanned: number; recovered: number; failures: number }> {
  if (input.batchSize <= 0) {
    return { scanned: 0, recovered: 0, failures: 0 };
  }

  let staleLifecycleClaims: Awaited<
    ReturnType<RecurringPaymentsRepository["listStaleLifecycleClaims"]>
  > = [];
  try {
    staleLifecycleClaims = await input.recurringPaymentsRepo.listStaleLifecycleClaims({
      olderThan: input.retryAfter,
      limit: input.batchSize,
    });
  } catch (error) {
    console.warn("Failed to list stale recurring payment lifecycle claims", {
      retryAfter: input.retryAfter,
      error: error instanceof Error ? error.message : String(error),
    });
    return { scanned: 0, recovered: 0, failures: 1 };
  }

  let recovered = 0;
  let failures = 0;
  for (const recurringPayment of staleLifecycleClaims) {
    try {
      await executeRecurringPaymentLifecycle({
        env: input.env,
        organizationId: recurringPayment.organization_id,
        projectId: recurringPayment.project_id,
        recurringPaymentId: recurringPayment.id,
        operation: recurringPayment.status === "canceling" ? "cancel" : "resume",
      });
      recovered += 1;
    } catch (error) {
      failures += 1;
      console.warn("Recurring payment lifecycle recovery failed", {
        recurringPaymentId: recurringPayment.id,
        status: recurringPayment.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { scanned: staleLifecycleClaims.length, recovered, failures };
}

async function recoverSubmittedCollections(input: {
  env: Env;
  subscriptionsRepo: PaymentSubscriptionsRepository;
  batchSize: number;
}): Promise<{ scanned: number; recovered: number; failures: number }> {
  if (input.batchSize <= 0) {
    return { scanned: 0, recovered: 0, failures: 0 };
  }

  let submittedCollectionAttempts: Awaited<
    ReturnType<PaymentSubscriptionsRepository["listSubmittedRecurringCollectionAttempts"]>
  > = [];
  try {
    submittedCollectionAttempts =
      await input.subscriptionsRepo.listSubmittedRecurringCollectionAttempts({
        limit: input.batchSize,
      });
  } catch (error) {
    console.warn("Failed to list submitted recurring collection recoveries", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { scanned: 0, recovered: 0, failures: 1 };
  }

  let recovered = 0;
  let failures = 0;
  for (const attempt of submittedCollectionAttempts) {
    if (!attempt.recurring_payment_id) {
      continue;
    }

    try {
      await collectRecurringPaymentRecord({
        env: input.env,
        organizationId: attempt.organization_id,
        projectId: attempt.project_id,
        recurringPaymentId: attempt.recurring_payment_id,
        initiatedByKeyId: null,
        enforceDue: false,
      });
      recovered += 1;
    } catch (error) {
      failures += 1;
      console.warn("Submitted recurring collection recovery failed", {
        recurringPaymentId: attempt.recurring_payment_id,
        attemptId: attempt.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { scanned: submittedCollectionAttempts.length, recovered, failures };
}

async function collectDueActivePayments(input: {
  env: Env;
  recurringPaymentsRepo: RecurringPaymentsRepository;
  now: string;
  retryAfter: string;
  batchSize: number;
}): Promise<{ scanned: number; collected: number; failures: number }> {
  if (input.batchSize <= 0) {
    return { scanned: 0, collected: 0, failures: 0 };
  }

  let due: Awaited<ReturnType<RecurringPaymentsRepository["listDueRecurringPayments"]>> = [];
  try {
    due = await input.recurringPaymentsRepo.listDueRecurringPayments({
      now: input.now,
      retryAfter: input.retryAfter,
      limit: input.batchSize,
    });
  } catch (error) {
    console.warn("Failed to list due recurring payments", {
      now: input.now,
      retryAfter: input.retryAfter,
      error: error instanceof Error ? error.message : String(error),
    });
    return { scanned: 0, collected: 0, failures: 1 };
  }

  let collected = 0;
  let failures = 0;

  for (const recurringPayment of due) {
    try {
      await collectRecurringPaymentRecord({
        env: input.env,
        organizationId: recurringPayment.organization_id,
        projectId: recurringPayment.project_id,
        recurringPaymentId: recurringPayment.id,
        initiatedByKeyId: null,
        enforceDue: true,
      });
      collected += 1;
    } catch (error) {
      failures += 1;
      console.warn("Recurring payment collection failed", {
        recurringPaymentId: recurringPayment.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { scanned: due.length, collected, failures };
}

export async function collectDueRecurringPayments(
  env: Env
): Promise<RecurringPaymentCollectionJobResult> {
  if (!isRecurringPaymentsEnabled(env) || !isRecurringPaymentCollectionEnabled(env)) {
    return emptyResult();
  }

  const batchSize = resolveBatchSize(env);
  const retryAfterMinutes = parsePositiveIntegerConfig(
    env.PAYMENTS_RECURRING_COLLECTION_RETRY_AFTER_MINUTES,
    DEFAULT_RETRY_AFTER_MINUTES
  );
  const now = new Date();
  const nowIso = now.toISOString();
  const retryAfter = new Date(now.getTime() - retryAfterMinutes * 60 * 1000).toISOString();
  const subscriptionsRepo = createPaymentSubscriptionsRepository(env);
  const recurringPaymentsRepo = createPaymentRecurringPaymentsRepository(env);
  let remainingCollectionBudget = batchSize;

  const expirationFailures = await expireStaleUnsignedAttempts({
    subscriptionsRepo,
    retryAfter,
    updatedAt: nowIso,
    batchSize,
  });
  const activationRecovery = await recoverStaleActivationClaims({
    env,
    recurringPaymentsRepo,
    retryAfter,
    updatedAt: nowIso,
    batchSize: remainingCollectionBudget,
  });
  remainingCollectionBudget = Math.max(remainingCollectionBudget - activationRecovery.scanned, 0);
  const lifecycleRecovery = await recoverStaleLifecycleClaims({
    env,
    recurringPaymentsRepo,
    retryAfter,
    batchSize: remainingCollectionBudget,
  });
  remainingCollectionBudget = Math.max(remainingCollectionBudget - lifecycleRecovery.scanned, 0);
  const submittedCollectionRecovery = await recoverSubmittedCollections({
    env,
    subscriptionsRepo,
    batchSize: remainingCollectionBudget,
  });
  remainingCollectionBudget = Math.max(
    remainingCollectionBudget - submittedCollectionRecovery.scanned,
    0
  );
  const dueCollection = await collectDueActivePayments({
    env,
    recurringPaymentsRepo,
    now: nowIso,
    retryAfter,
    batchSize: remainingCollectionBudget,
  });

  return {
    scanned: dueCollection.scanned,
    collected: dueCollection.collected,
    failed:
      expirationFailures +
      activationRecovery.failures +
      lifecycleRecovery.failures +
      submittedCollectionRecovery.failures +
      dueCollection.failures,
    expirationFailures,
    activationRecovered: activationRecovery.recovered,
    activationFailures: activationRecovery.failures,
    lifecycleRecovered: lifecycleRecovery.recovered,
    lifecycleFailures: lifecycleRecovery.failures,
    submittedCollectionRecovered: submittedCollectionRecovery.recovered,
    submittedCollectionFailures: submittedCollectionRecovery.failures,
    collectionFailures: dueCollection.failures,
  };
}
