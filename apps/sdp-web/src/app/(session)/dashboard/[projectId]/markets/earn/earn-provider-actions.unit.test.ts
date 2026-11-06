import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dashboardFetchModule from "@/lib/dashboard-fetch";
import { prepareEarnVaultAccount } from "./earn-provider-actions";

const dashboardFetch = vi.spyOn(dashboardFetchModule, "dashboardFetch");

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The action row the wire schema answers, in the status the caller names.
 * A preparation's outcome — not_required, finalized, or failed — is what
 * releases or keeps the deposit's idempotency key.
 */
const action = (status: string) => ({
  actionId: "action",
  action: "preparation",
  status,
  provider: "plume",
  providerReference: "vault",
  ownerAddress: "owner",
  feePayer: null,
  parentMovementId: null,
  signature: null,
  deliverySignature: null,
  lastValidBlockHeight: null,
  error: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  transaction: null,
});

function served(...statuses: string[]): void {
  dashboardFetch.mockImplementation(async () => ({
    ok: true as const,
    status: 200,
    data: { data: { action: action(statuses.shift() ?? "finalized") } },
  }));
}

function prepare(): Promise<void> {
  return prepareEarnVaultAccount(
    { strategyId: "strat", custodyWalletId: "wallet" },
    "deposit-key",
    new AbortController().signal
  );
}

describe("prepareEarnVaultAccount", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("releases the deposit key by throwing when setup reaches its terminal refusal", async () => {
    vi.useFakeTimers();
    served("preparing", "failed");
    // Attach the assertion before the timers run: the rejection must never be
    // unhandled while the poll advances.
    const verdict = expect(prepare()).rejects.toMatchObject({
      name: "EarnVaultPreparationFailedError",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await verdict;
  });

  it("resolves when setup finalizes", async () => {
    vi.useFakeTimers();
    served("preparing", "finalized");
    const verdict = expect(prepare()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    await verdict;
  });

  it("resolves immediately when no setup is required", async () => {
    vi.useFakeTimers();
    served("not_required");
    await expect(prepare()).resolves.toBeUndefined();
  });
});
