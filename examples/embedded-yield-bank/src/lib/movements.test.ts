import { describe, expect, it } from "vitest";
import type { DashboardData, YieldMovement } from "@/types";
import {
  ACTIVE_MOVEMENT_REFRESH_MS,
  applyInFlight,
  foldSettledTransfers,
  isMovementAwaitingFinality,
  isPendingMovement,
  isSettledMovement,
  partitionSettledTransfersBySnapshot,
  reconcileInFlight,
  reconcileMovementPolling,
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

  it("shows the balances a pending transfer will produce and keeps the total", () => {
    const base = dashboard({ checking: "19", savings: "1", total: "20" });
    const live = dashboard({
      checking: "19",
      savings: "3",
      total: "22",
      movements: [{ ...createMovement("submitted"), tokenAmount: "2" }],
    });

    const view = applyInFlight(base, live, [
      {
        movementId: "movement-1",
        direction: "deposit",
        amount: "2",
        expiresAt: SETTLEMENT_POLL_TIMEOUT_MS,
      },
    ]);

    expect(view.checking.balance).toBe("17");
    expect(view.savings.balance).toBe("3");
    expect(view.savings.withdrawable).toBe("3");
    expect(view.total).toBe("20");
  });

  it("fills a pending withdrawal's amount from the request until it settles", () => {
    const base = dashboard({ checking: "17", savings: "3", total: "20" });
    const pending: YieldMovement = {
      ...createMovement("submitted"),
      direction: "withdrawal",
      tokenAmount: null,
    };
    const live = dashboard({
      checking: "17",
      savings: "3",
      total: "20",
      movements: [pending],
    });

    const view = applyInFlight(base, live, [
      {
        movementId: "movement-1",
        direction: "withdrawal",
        amount: "1.5",
        expiresAt: SETTLEMENT_POLL_TIMEOUT_MS,
      },
    ]);

    expect(view.checking.balance).toBe("18.5");
    expect(view.savings.balance).toBe("1.5");
    expect(view.movements[0]?.tokenAmount).toBe("1.5");
  });

  it("folds a settled transfer into the base so the rest projects from fresh footing", () => {
    const base = dashboard({ checking: "19", savings: "1", total: "20" });
    const first = {
      movementId: "m1",
      direction: "deposit" as const,
      amount: "2",
      expiresAt: SETTLEMENT_POLL_TIMEOUT_MS,
    };
    const second = {
      movementId: "m2",
      direction: "deposit" as const,
      amount: "3",
      expiresAt: SETTLEMENT_POLL_TIMEOUT_MS,
    };

    const folded = foldSettledTransfers(base, [first]);
    expect(folded.checking.balance).toBe("17");
    expect(folded.savings.balance).toBe("3");

    const live = dashboard({ checking: "17", savings: "3", total: "20" });
    const view = applyInFlight(folded, live, [second]);
    expect(view.checking.balance).toBe("14");
    expect(view.savings.balance).toBe("6");
    expect(view.total).toBe("20");
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
    const base = dashboard({ checking: "19", savings: "1", total: "20" });
    expect(foldSettledTransfers(base, settled).checking.balance).toBe("17");
  });

  it("returns live data untouched once nothing is in flight", () => {
    const live = dashboard({ checking: "17", savings: "3", total: "20" });
    expect(applyInFlight(live, live, [])).toBe(live);
  });

  it("keeps a confirmed deposit projected until both balances reflect it", () => {
    const base = dashboard({ checking: "19", savings: "1", total: "20" });
    const transfer = {
      movementId: "movement-1",
      direction: "deposit" as const,
      amount: "2",
      expiresAt: SETTLEMENT_POLL_TIMEOUT_MS,
    };

    expect(
      partitionSettledTransfersBySnapshot(
        base,
        dashboard({ checking: "17", savings: "1", total: "18" }),
        [transfer]
      )
    ).toEqual({ reflected: [], waiting: [transfer] });
    expect(
      partitionSettledTransfersBySnapshot(
        base,
        dashboard({ checking: "17", savings: "2", total: "19" }),
        [transfer]
      )
    ).toEqual({ reflected: [], waiting: [transfer] });
    expect(
      partitionSettledTransfersBySnapshot(
        base,
        dashboard({ checking: "17", savings: "3", total: "20" }),
        [transfer]
      )
    ).toEqual({ reflected: [transfer], waiting: [] });
  });

  it("hands a confirmed withdrawal back after both live balances move", () => {
    const base = dashboard({ checking: "17", savings: "3", total: "20" });
    const transfer = {
      movementId: "movement-1",
      direction: "withdrawal" as const,
      amount: "1",
      expiresAt: SETTLEMENT_POLL_TIMEOUT_MS,
    };

    expect(
      partitionSettledTransfersBySnapshot(
        base,
        dashboard({ checking: "17.5", savings: "2.5", total: "20" }),
        [transfer]
      )
    ).toEqual({ reflected: [], waiting: [transfer] });
    expect(
      partitionSettledTransfersBySnapshot(
        base,
        dashboard({ checking: "18", savings: "2", total: "20" }),
        [transfer]
      )
    ).toEqual({ reflected: [transfer], waiting: [] });
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
      balance: input.savings,
      withdrawable: input.savings,
      earned: "0",
    },
    total: input.total,
    movements: input.movements ?? [],
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
