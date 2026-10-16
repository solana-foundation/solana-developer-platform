import { describe, expect, it } from "vitest";
import type { DashboardData, YieldMovement } from "@/types";
import {
  ACTIVE_MOVEMENT_REFRESH_MS,
  applySubmittedTransfers,
  isMovementAwaitingFinality,
  isPendingMovement,
  isSettledMovement,
  reconcileInFlight,
  reconcileMovementPolling,
  reconcileSubmittedTransfers,
  SETTLEMENT_POLL_TIMEOUT_MS,
  startMovementPolling,
} from "./movements";

describe("movement polling", () => {
  it("checks active Solana movements every second", () => {
    expect(ACTIVE_MOVEMENT_REFRESH_MS).toBe(1_000);
  });

  it("keeps polling while a submitted movement is absent from a stale read", () => {
    const polling = startMovementPolling(undefined, "movement-1", 0);
    const result = reconcileMovementPolling(
      polling,
      [],
      SETTLEMENT_POLL_TIMEOUT_MS - 1
    );

    expect(result.polling?.movementIds).toEqual(["movement-1"]);
    expect(result.timedOutMovementIds).toEqual([]);
  });

  it("stops polling and reports a movement after the settlement deadline", () => {
    const polling = startMovementPolling(undefined, "movement-1", 0);
    const result = reconcileMovementPolling(
      polling,
      [],
      SETTLEMENT_POLL_TIMEOUT_MS
    );

    expect(result.polling).toBeUndefined();
    expect(result.timedOutMovementIds).toEqual(["movement-1"]);
  });

  it("does not start fast polling for historical pending movements", () => {
    const pending = createMovement("submitted");

    const initial = reconcileMovementPolling(undefined, [pending], 0);
    const afterTimeout = reconcileMovementPolling(
      startMovementPolling(undefined, pending.movementId, 0),
      [pending],
      SETTLEMENT_POLL_TIMEOUT_MS
    );
    const later = reconcileMovementPolling(
      afterTimeout.polling,
      [pending],
      SETTLEMENT_POLL_TIMEOUT_MS + 1
    );

    expect(initial).toEqual({
      polling: undefined,
      timedOutMovementIds: [],
    });
    expect(afterTimeout).toEqual({
      polling: undefined,
      timedOutMovementIds: [pending.movementId],
    });
    expect(later).toEqual({
      polling: undefined,
      timedOutMovementIds: [],
    });
  });

  it("stops customer-facing polling as soon as a movement is confirmed", () => {
    const movement = createMovement("confirmed");
    const polling = startMovementPolling(undefined, movement.movementId, 0);
    const result = reconcileMovementPolling(polling, [movement], 1);

    expect(result.polling).toBeUndefined();
    expect(result.timedOutMovementIds).toEqual([]);
  });

  it("times out each movement on its own deadline", () => {
    const first = startMovementPolling(undefined, "old", 0);
    const both = startMovementPolling(first, "new", 60_000);
    const result = reconcileMovementPolling(
      both,
      [],
      SETTLEMENT_POLL_TIMEOUT_MS
    );

    expect(result.polling?.movementIds).toEqual(["new"]);
    expect(result.timedOutMovementIds).toEqual(["old"]);
  });
});

describe("in-flight transfers", () => {
  it("treats confirmed and finalized as settled in the UI", () => {
    expect(isSettledMovement(createMovement("confirmed"))).toBe(true);
    expect(isSettledMovement(createMovement("finalized"))).toBe(true);
    expect(isPendingMovement(createMovement("submitted"))).toBe(true);
    expect(isPendingMovement(createMovement("confirmed"))).toBe(false);
    expect(isMovementAwaitingFinality(createMovement("confirmed"))).toBe(true);
    expect(isMovementAwaitingFinality(createMovement("finalized"))).toBe(false);
  });

  it("folds confirmed transfers and drops failed ones without applying them", () => {
    const inFlight = [
      {
        movementId: "ok",
        direction: "deposit" as const,
        amount: "2",
        expiresAt: SETTLEMENT_POLL_TIMEOUT_MS,
      },
      {
        movementId: "bad",
        direction: "deposit" as const,
        amount: "5",
        expiresAt: SETTLEMENT_POLL_TIMEOUT_MS,
      },
      {
        movementId: "slow",
        direction: "deposit" as const,
        amount: "1",
        expiresAt: SETTLEMENT_POLL_TIMEOUT_MS,
      },
      {
        movementId: "unseen",
        direction: "deposit" as const,
        amount: "3",
        expiresAt: SETTLEMENT_POLL_TIMEOUT_MS,
      },
    ];
    const movements = [
      { ...createMovement("confirmed"), movementId: "ok" },
      { ...createMovement("failed"), movementId: "bad" },
      { ...createMovement("submitted"), movementId: "slow" },
    ];

    const { failed, remaining, settled } = reconcileInFlight(
      inFlight,
      movements
    );

    expect(settled.map((transfer) => transfer.movementId)).toEqual(["ok"]);
    expect(failed.map((transfer) => transfer.movementId)).toEqual(["bad"]);
    expect(remaining.map((transfer) => transfer.movementId)).toEqual([
      "slow",
      "unseen",
    ]);
  });

  it("keeps provider orders and unknown settlement pending at confirmation", () => {
    expect(
      isSettledMovement({
        ...createMovement("confirmed"),
        settlement: "provider_order",
      })
    ).toBe(false);
    expect(
      isSettledMovement({
        ...createMovement("confirmed"),
        settlement: undefined,
      })
    ).toBe(false);
  });
});

describe("submitted transfer activity", () => {
  const withdrawal: YieldMovement = {
    ...createMovement("submitted"),
    direction: "withdrawal",
    tokenAmount: null,
  };
  const submitted = [{ movement: withdrawal, requestedTokenAmount: "1.5" }];

  it("adds the submit response immediately when the dashboard read is stale", () => {
    const live = dashboard({ checking: "17", savings: "3", total: "20" });

    const view = applySubmittedTransfers(live, submitted);

    expect(view.movements).toEqual([
      { ...withdrawal, requestedTokenAmount: "1.5" },
    ]);
  });

  it("uses the live status without losing the requested withdrawal amount", () => {
    const confirmed = {
      ...withdrawal,
      status: "confirmed" as const,
      signature: "confirmed-signature",
    };
    const live = dashboard({
      checking: "18.5",
      savings: "1.5",
      total: "20",
      movements: [confirmed],
    });

    const view = applySubmittedTransfers(live, submitted);

    expect(view.movements).toHaveLength(1);
    expect(view.movements[0]).toMatchObject({
      status: "confirmed",
      signature: "confirmed-signature",
      tokenAmount: null,
      requestedTokenAmount: "1.5",
    });
  });

  it("prefers the exact API payout once it is available", () => {
    const finalized = {
      ...withdrawal,
      status: "finalized" as const,
      tokenAmount: "1.49",
    };
    const live = dashboard({
      checking: "18.49",
      savings: "1.5",
      total: "19.99",
      movements: [finalized],
    });

    const view = applySubmittedTransfers(live, submitted);

    expect(view.movements).toHaveLength(1);
    expect(view.movements[0]?.tokenAmount).toBe("1.49");
  });

  it("sorts optimistic and live activity together by creation time", () => {
    const olderSubmission = {
      movement: {
        ...withdrawal,
        createdAt: "2026-09-17T00:00:00.000Z",
      },
      requestedTokenAmount: "1.5",
    };
    const newerLive = {
      ...createMovement("confirmed"),
      movementId: "movement-2",
      createdAt: "2026-09-17T00:00:01.000Z",
    };
    const live = dashboard({
      checking: "17",
      savings: "3",
      total: "20",
      movements: [newerLive],
    });

    const view = applySubmittedTransfers(live, [olderSubmission]);

    expect(view.movements.map((movement) => movement.movementId)).toEqual([
      "movement-2",
      "movement-1",
    ]);
  });

  it("never presents a failed withdrawal as money moved", () => {
    const failed = { ...withdrawal, status: "failed" as const };
    const optimistic = applySubmittedTransfers(
      dashboard({ checking: "17", savings: "3", total: "20" }),
      [{ movement: failed, requestedTokenAmount: "1.5" }]
    );
    const live = applySubmittedTransfers(
      dashboard({
        checking: "17",
        savings: "3",
        total: "20",
        movements: [failed],
      }),
      submitted
    );

    expect(optimistic.movements[0]?.tokenAmount).toBeNull();
    expect(live.movements[0]?.tokenAmount).toBeNull();
  });

  it("prunes overlays after an exact amount or failure reaches the live ledger", () => {
    const pending = { movement: withdrawal, requestedTokenAmount: "1.5" };
    const exact = {
      movement: { ...withdrawal, movementId: "exact" },
      requestedTokenAmount: "2",
    };
    const failed = {
      movement: { ...withdrawal, movementId: "failed" },
      requestedTokenAmount: "3",
    };
    const localFailure = {
      movement: {
        ...withdrawal,
        movementId: "local-failure",
        status: "failed" as const,
      },
      requestedTokenAmount: "4",
    };
    const current = [pending, exact, failed, localFailure];
    const live = [
      { ...withdrawal, movementId: "exact", tokenAmount: "1.99" },
      { ...withdrawal, movementId: "failed", status: "failed" as const },
      { ...withdrawal, status: "confirmed" as const },
    ];

    const remaining = reconcileSubmittedTransfers(current, live);

    expect(remaining).toEqual([pending]);
  });
});

function dashboard(input: {
  checking: string;
  savings: string;
  total: string;
  movements?: YieldMovement[];
}): DashboardData {
  return {
    wallet: {
      address: "owner",
      cluster: "devnet",
      feesPaidBy: "northstar",
    },
    token: { mint: "usdc-mint", symbol: "USDC" },
    checking: { balance: input.checking },
    savings: {
      strategy: {
        id: "strategy",
        provider: "kamino",
        providerReference: "vault",
        name: "Kamino Vault USDC",
        sourceKind: "defi",
        depositMints: ["usdc-mint"],
        liquidityTerm: "instant",
        status: "active",
        hostCluster: "devnet",
        fundable: true,
        depositSlippage: null,
        withdrawalSlippage: null,
      },
      position: null,
      withdrawalOptions: null,
      balance: input.savings,
      withdrawable: input.savings,
      earned: "0",
    },
    total: input.total,
    movements: input.movements ?? [],
    withdrawalRequests: [],
    connection: {
      apiLabel: "Local SDP",
      checkedAt: "2026-09-17T00:00:00.000Z",
    },
  };
}

function createMovement(status: YieldMovement["status"]): YieldMovement {
  return {
    movementId: "movement-1",
    positionId: "position-1",
    provider: "kamino",
    providerReference: "vault",
    direction: "deposit",
    status,
    settlement: "atomic",
    signature: "signature",
    amount: "25",
    denomination: "usdc-mint",
    tokenMint: "usdc-mint",
    tokenAmount: "25",
    failureReason: null,
    createdAt: "2026-09-17T00:00:00.000Z",
    settledAt: status === "finalized" ? "2026-09-17T00:00:01.000Z" : null,
  };
}
