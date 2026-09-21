import { describe, expect, it } from "vitest";
import {
  earnVaultQueuedWithdrawalStatusPresentation,
  isEarnVaultQueuedWithdrawalTerminal,
} from "./earn-vault-queued-withdrawal-presentation";

describe("queued withdrawal lifecycle presentation", () => {
  it("shares terminal truth across every queue surface", () => {
    expect(isEarnVaultQueuedWithdrawalTerminal("fulfilled")).toBe(true);
    expect(isEarnVaultQueuedWithdrawalTerminal("cancelled")).toBe(true);
    expect(isEarnVaultQueuedWithdrawalTerminal("failed")).toBe(true);
    expect(isEarnVaultQueuedWithdrawalTerminal("closedOrUnknown")).toBe(false);
  });

  it("treats both pre-deadline states as waiting on the provider", () => {
    expect(earnVaultQueuedWithdrawalStatusPresentation("pending").awaitingProvider).toBe(true);
    expect(earnVaultQueuedWithdrawalStatusPresentation("fulfillable").awaitingProvider).toBe(true);
    expect(earnVaultQueuedWithdrawalStatusPresentation("expiredCancelable").awaitingProvider).toBe(
      false
    );
  });
});
