import {
  HELIUS_RINGS_LIVE_OPERATION_STATUSES,
  HELIUS_RINGS_OPERATION_STATUSES,
  HELIUS_RINGS_RETIRED_OPERATION_STATUSES,
  isLiveHeliusRingsOperationStatus,
} from "@sdp/types/helius-rings";
import { describe, expect, it } from "vitest";

describe("Helius Rings operation statuses", () => {
  it("splits the stored vocabulary into live and retired, in lifecycle order", () => {
    expect([
      ...HELIUS_RINGS_LIVE_OPERATION_STATUSES,
      ...HELIUS_RINGS_RETIRED_OPERATION_STATUSES,
    ]).toHaveLength(HELIUS_RINGS_OPERATION_STATUSES.length);
    expect(HELIUS_RINGS_LIVE_OPERATION_STATUSES).toEqual([
      "draft",
      "preparing",
      "proving",
      "ready_to_sign",
      "submitted",
      "indexing",
      "completed",
      "failed",
      "voided",
    ]);
  });

  it("does not treat a retired or unknown status as live", () => {
    expect(isLiveHeliusRingsOperationStatus("completed")).toBe(true);
    expect(isLiveHeliusRingsOperationStatus("approval_required")).toBe(false);
    expect(isLiveHeliusRingsOperationStatus("something_new")).toBe(false);
  });
});
