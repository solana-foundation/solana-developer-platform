import type { EarnVaultWithdrawalRequestStatus } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  earnVaultQueuedWithdrawalStatusPresentation,
  isEarnVaultQueuedWithdrawalTerminal,
} from "./earn-vault-queued-withdrawal-presentation";

// The lifecycle states a queued withdrawal can be seen in. Kept explicit so a
// newly added status fails here until its presentation is chosen on purpose.
const ALL_STATUSES: EarnVaultWithdrawalRequestStatus[] = [
  "creating",
  "pending",
  "fulfillable",
  "expiredCancelable",
  "cancelling",
  "fulfilled",
  "cancelled",
  "closedOrUnknown",
  "failed",
];

describe("queued withdrawal lifecycle presentation", () => {
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
