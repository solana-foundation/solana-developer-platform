import { describe, expect, it } from "vitest";
import type { DashboardData, YieldMovement } from "@/types";
import {
  applyInFlight,
  reconcileMovementPolling,
  SETTLEMENT_POLL_TIMEOUT_MS,
  startMovementPolling,
} from "./movements";

describe("movement polling", () => {
  it("keeps polling while a submitted movement is absent from a stale read", () => {
    const polling = startMovementPolling(undefined, "movement-1", 0);
    const result = reconcileMovementPolling(
      polling,
      [],
      SETTLEMENT_POLL_TIMEOUT_MS - 1
    );

    expect(result.polling?.movementIds).toEqual(["movement-1"]);
    expect(result.timedOut).toBe(false);
  });

  it("stops polling and reports a movement after the settlement deadline", () => {
    const polling = startMovementPolling(undefined, "movement-1", 0);
    const result = reconcileMovementPolling(
      polling,
      [],
      SETTLEMENT_POLL_TIMEOUT_MS
    );

    expect(result.polling).toBeUndefined();
    expect(result.timedOut).toBe(true);
  });

  it("stops tracking a submitted movement after it becomes terminal", () => {
    const movement = createMovement("finalized");
    const polling = startMovementPolling(undefined, movement.movementId, 0);
    const result = reconcileMovementPolling(polling, [movement], 1);

    expect(result.polling).toBeUndefined();
    expect(result.timedOut).toBe(false);
  });
});

describe("in-flight transfers", () => {
  it("shows the balances a pending transfer will produce and keeps the total", () => {
    const base = dashboard({ checking: "19", savings: "1", total: "20" });
    const live = dashboard({
      checking: "19",
      savings: "3",
      total: "22",
      movements: [{ ...createMovement("submitted"), tokenAmount: "2" }],
    });

    const view = applyInFlight(base, live, [
      { movementId: "movement-1", direction: "deposit", amount: "2" },
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
      { movementId: "movement-1", direction: "withdrawal", amount: "1.5" },
    ]);

    expect(view.checking.balance).toBe("18.5");
    expect(view.savings.balance).toBe("1.5");
    expect(view.movements[0]?.tokenAmount).toBe("1.5");
  });

  it("returns live data untouched once nothing is in flight", () => {
    const live = dashboard({ checking: "17", savings: "3", total: "20" });
    expect(applyInFlight(live, live, [])).toBe(live);
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
