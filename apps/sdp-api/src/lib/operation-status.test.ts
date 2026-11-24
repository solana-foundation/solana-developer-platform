import {
  isRedemptionReleaseOperatorRecoveryStatus,
  OPERATION_STATUSES,
  type OperationStatus,
  operationTransitionRequiresResourceReference,
} from "@sdp/types/operations";
import { expect, it } from "vitest";

// A completed release is a read-only replay; failed and unsubmitted work cannot be reopened.
const operatorRecoveryEligibility = {
  prepared: false,
  queued: false,
  awaiting_signature: false,
  submitted: false,
  settling: true,
  completed: true,
  failed: false,
  cancelled: false,
} as const satisfies Record<OperationStatus, boolean>;

it.each(OPERATION_STATUSES)("operator release recovery eligibility for %s", (status) => {
  expect(isRedemptionReleaseOperatorRecoveryStatus(status)).toBe(
    operatorRecoveryEligibility[status]
  );
});

// Execution transitions require evidence for completion/cancellation, not for a failed start.
const authoritativeResourceRequired = {
  prepared: false,
  queued: false,
  awaiting_signature: false,
  submitted: false,
  settling: false,
  completed: true,
  failed: false,
  cancelled: true,
} as const satisfies Record<OperationStatus, boolean>;

it.each(OPERATION_STATUSES)("execution transition resource requirement for %s", (status) => {
  expect(operationTransitionRequiresResourceReference(status)).toBe(
    authoritativeResourceRequired[status]
  );
});
