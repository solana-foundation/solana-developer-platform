import type { EarnVaultWithdrawalRequestStatus } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  earnVaultQueuedWithdrawalStatusPresentation,
  isEarnVaultQueuedWithdrawalTerminal,
} from "./earn-vault-queued-withdrawal-presentation";

// The lifecycle states a queued withdrawal can be seen in. Kept explicit so a
// newly added status fails here until its presentation is chosen on purpose.
const ALL_STATUSES = [
  "creating",
  "pending",
  "fulfillable",
  "expiredCancelable",
  "cancelling",
  "fulfilled",
  "cancelled",
  "closedOrUnknown",
  "failed",
] as const satisfies readonly EarnVaultWithdrawalRequestStatus[];

// Type-level exhaustiveness guard: this tuple only stays empty (and therefore
// typechecks as never[]) while every member of the union is listed above. A
// status added to EarnVaultWithdrawalRequestStatus without being added to
// ALL_STATUSES surfaces here as a type error, not a silent skip.
const UNCOVERED_STATUSES: Exclude<
  EarnVaultWithdrawalRequestStatus,
  (typeof ALL_STATUSES)[number]
>[] = [];

describe("queued withdrawal lifecycle presentation", () => {
  it("lists every status in the union", () => {
    expect(UNCOVERED_STATUSES).toEqual([]);
  });

  it("shares terminal truth across every queue surface", () => {
    const terminal = ALL_STATUSES.filter((status) => isEarnVaultQueuedWithdrawalTerminal(status));
    // Only the three outcomes end the request; everything else is in flight
    // or awaiting provider action.
    expect(terminal).toEqual(["fulfilled", "cancelled", "failed"]);
  });

  it("treats exactly the provider-held states as waiting on the provider", () => {
    const awaitingProvider = ALL_STATUSES.filter(
      (status) => earnVaultQueuedWithdrawalStatusPresentation(status).awaitingProvider
    );
    expect(awaitingProvider).toEqual(["pending", "fulfillable"]);
  });

  it("never reports a terminal state as still waiting on the provider", () => {
    for (const status of ALL_STATUSES) {
      const presentation = earnVaultQueuedWithdrawalStatusPresentation(status);
      if (presentation.terminal) {
        expect(presentation.awaitingProvider, status).toBe(false);
      }
    }
  });
});
