import {
  isRedemptionReleaseOperatorRecoveryStatus,
  OPERATION_STATUSES,
  type OperationStatus,
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
