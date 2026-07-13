import type { PaymentRecurringPaymentStatus } from "@sdp/types";

export const RECURRING_PAYMENT_OPERATION_STALE_AFTER_MS = 15 * 60 * 1000;

export type RecurringPaymentLifecycleOperation = "cancel" | "resume";
export type RecurringPaymentTransition =
  | "already_final"
  | "claimable"
  | "recoverable"
  | "processing"
  | "invalid";

export type RecurringPaymentScheduleResolution =
  | {
      kind: "scheduled";
      nextCollectionDueAt: string;
      minimumDueAt: string;
      clamped: boolean;
    }
  | {
      kind: "too_early";
      minimumDueAt: string;
    };

export function getRecurringPaymentOperationStaleBefore(nowIso: string): string {
  return new Date(
    new Date(nowIso).getTime() - RECURRING_PAYMENT_OPERATION_STALE_AFTER_MS
  ).toISOString();
}

export function isRecurringPaymentOperationStale(input: {
  updatedAt: string;
  nowIso: string;
}): boolean {
  const updatedAt = new Date(input.updatedAt).getTime();
  const staleBefore = new Date(getRecurringPaymentOperationStaleBefore(input.nowIso)).getTime();
  return Number.isFinite(updatedAt) && Number.isFinite(staleBefore) && updatedAt <= staleBefore;
}

export function getRecurringPaymentLifecycleStatuses(
  operation: RecurringPaymentLifecycleOperation
): {
  processingStatus: PaymentRecurringPaymentStatus;
  claimableStatus: PaymentRecurringPaymentStatus;
  finalStatus: PaymentRecurringPaymentStatus;
} {
  return operation === "cancel"
    ? {
        processingStatus: "canceling",
        claimableStatus: "active",
        finalStatus: "canceled",
      }
    : {
        processingStatus: "resuming",
        claimableStatus: "canceled",
        finalStatus: "active",
      };
}

export function decideRecurringPaymentLifecycleTransition(input: {
  operation: RecurringPaymentLifecycleOperation;
  status: PaymentRecurringPaymentStatus;
  updatedAt: string;
  nowIso: string;
}): RecurringPaymentTransition {
  const { claimableStatus, finalStatus, processingStatus } = getRecurringPaymentLifecycleStatuses(
    input.operation
  );
  if (input.status === finalStatus) {
    return "already_final";
  }
  if (input.status === processingStatus) {
    return isRecurringPaymentOperationStale(input) ? "recoverable" : "processing";
  }
  return input.status === claimableStatus ? "claimable" : "invalid";
}

export function decideRecurringPaymentActivationTransition(input: {
  status: PaymentRecurringPaymentStatus;
  updatedAt: string;
  nowIso: string;
}): RecurringPaymentTransition {
  if (input.status === "active") {
    return "already_final";
  }
  if (input.status === "activating") {
    return isRecurringPaymentOperationStale(input) ? "recoverable" : "processing";
  }
  return input.status === "pending_activation" ? "claimable" : "invalid";
}

export function decideRecurringPaymentUpdateTransition(input: {
  status: PaymentRecurringPaymentStatus;
  updatedAt: string;
  nowIso: string;
}): RecurringPaymentTransition {
  if (input.status === "pending_activation" || input.status === "active") {
    return "claimable";
  }
  if (input.status === "updating") {
    return isRecurringPaymentOperationStale(input) ? "recoverable" : "processing";
  }
  return "invalid";
}

export function nextRecurringPaymentCollectionDueAt(dueAt: string, periodHours: number): string {
  return new Date(new Date(dueAt).getTime() + periodHours * 60 * 60 * 1000).toISOString();
}

export function hasRecurringPaymentAdvancedPastDueAt(
  nextDueAt: string | null,
  dueAt: string
): boolean {
  const nextDueTime = nextDueAt ? new Date(nextDueAt).getTime() : Number.NaN;
  const dueTime = new Date(dueAt).getTime();
  return Number.isFinite(nextDueTime) && Number.isFinite(dueTime) && nextDueTime > dueTime;
}

export function isRecurringPaymentCollectionActive(status: PaymentRecurringPaymentStatus): boolean {
  return status === "active";
}

export function resolveRecurringPaymentCollectionSchedule(input: {
  requested: string | null;
  periodStartAt: string;
  periodHours: number;
  clampToMinimum?: boolean;
}): RecurringPaymentScheduleResolution {
  const minimumDueAt = nextRecurringPaymentCollectionDueAt(input.periodStartAt, input.periodHours);
  const requested = input.requested ?? minimumDueAt;
  if (new Date(requested).getTime() < new Date(minimumDueAt).getTime()) {
    if (input.clampToMinimum) {
      return {
        kind: "scheduled",
        nextCollectionDueAt: minimumDueAt,
        minimumDueAt,
        clamped: true,
      };
    }
    return { kind: "too_early", minimumDueAt };
  }

  return {
    kind: "scheduled",
    nextCollectionDueAt: requested,
    minimumDueAt,
    clamped: false,
  };
}
