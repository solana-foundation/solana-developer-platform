import {
  type PaymentRecurringPaymentLifecycleOperation,
  type PaymentRecurringPaymentStatus,
  type PaymentRecurringPaymentTransitionResult,
  RECURRING_PAYMENT_ACTIVATION_TRANSITION,
  RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS,
  RECURRING_PAYMENT_UPDATE_TRANSITION,
} from "@sdp/types";
import { z } from "zod";

export const RECURRING_PAYMENT_OPERATION_STALE_AFTER_MS = 15 * 60 * 1000;

export type RecurringPaymentLifecycleOperation = PaymentRecurringPaymentLifecycleOperation;
export type RecurringPaymentTransition = PaymentRecurringPaymentTransitionResult;

export const recurringPaymentScheduleRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("requested"), dueAt: z.string(), clampToMinimum: z.boolean() }),
  z.object({ kind: z.literal("next_period") }),
]);
export type RecurringPaymentScheduleRequest = z.infer<typeof recurringPaymentScheduleRequestSchema>;

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
  return RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS[operation];
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
  if (input.status === finalStatus) return "already_final";
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
  const { claimableStatus, finalStatus, processingStatus } =
    RECURRING_PAYMENT_ACTIVATION_TRANSITION;
  if (input.status === finalStatus) return "already_final";
  if (input.status === processingStatus) {
    return isRecurringPaymentOperationStale(input) ? "recoverable" : "processing";
  }
  return input.status === claimableStatus ? "claimable" : "invalid";
}

export function decideRecurringPaymentUpdateTransition(input: {
  status: PaymentRecurringPaymentStatus;
  updatedAt: string;
  nowIso: string;
}): RecurringPaymentTransition {
  const { claimableStatuses, processingStatus } = RECURRING_PAYMENT_UPDATE_TRANSITION;
  if (input.status === processingStatus) {
    return isRecurringPaymentOperationStale(input) ? "recoverable" : "processing";
  }
  return claimableStatuses.some((status) => status === input.status) ? "claimable" : "invalid";
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

export function resolveRecurringPaymentCollectionSchedule(input: {
  request: RecurringPaymentScheduleRequest;
  periodStartAt: string;
  periodHours: number;
}): RecurringPaymentScheduleResolution {
  const minimumDueAt = nextRecurringPaymentCollectionDueAt(input.periodStartAt, input.periodHours);
  const requested = input.request.kind === "requested" ? input.request.dueAt : minimumDueAt;
  if (new Date(requested).getTime() < new Date(minimumDueAt).getTime()) {
    if (input.request.kind === "requested" && input.request.clampToMinimum) {
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

export function generateProgramPlanId(): string {
  const bytes = new Uint8Array(8);
  let value = 0n;

  while (value === 0n) {
    crypto.getRandomValues(bytes);
    value = new DataView(bytes.buffer).getBigUint64(0, false);
  }

  return value.toString();
}
