import {
  HELIUS_RINGS_LIVE_OPERATION_STATUSES,
  HELIUS_RINGS_OPERATION_STATUSES,
  HELIUS_RINGS_RETIRED_OPERATION_STATUSES,
  isLiveHeliusRingsOperationStatus,
} from "@sdp/types";
import { describe, expect, it } from "vitest";

describe("Helius Rings operation statuses", () => {
  it("splits the stored vocabulary into live and retired, in lifecycle order", () => {
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
    expect(HELIUS_RINGS_RETIRED_OPERATION_STATUSES).toEqual(["approval_required"]);
    // The concat length only matches when every status is filed exactly once:
    // a status listed as both live and retired would push the union past the
    // vocabulary length.
    expect([
      ...HELIUS_RINGS_LIVE_OPERATION_STATUSES,
      ...HELIUS_RINGS_RETIRED_OPERATION_STATUSES,
    ]).toHaveLength(new Set(HELIUS_RINGS_OPERATION_STATUSES).size);
  });

  it("does not treat a retired or unknown status as live", () => {
    expect(isLiveHeliusRingsOperationStatus("completed")).toBe(true);
    expect(isLiveHeliusRingsOperationStatus("approval_required")).toBe(false);
    expect(isLiveHeliusRingsOperationStatus("something_new")).toBe(false);
  });
});
