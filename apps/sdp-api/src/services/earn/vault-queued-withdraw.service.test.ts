import { describe, expect, it } from "vitest";
import { assertQueuePlan } from "./vault-queued-withdraw.service";

const position = {
  id: "earn_position_test",
  provider: "veda",
  vaultAddress: "8VfVedaQueueVault111111111111111111111111111",
  tokenMint: "9VfVedaQueueToken111111111111111111111111111",
  shareMint: "AVfVedaQueueShare111111111111111111111111111",
  ownerAddress: "7YfVedaQueueOwner111111111111111111111111111",
};

function plan(overrides: Record<string, unknown> = {}) {
  return {
    cluster: "devnet",
    instructions: [],
    signers: [],
    assetIdentity: {
      depositTokenMint: position.tokenMint,
      shareMint: position.shareMint,
    },
    requestAddress: "QueueRequestAddress11111111111111111111",
    expectedRequest: {
      assetMint: position.tokenMint,
      shares: "10",
      // Builder truth may legitimately drift from the earlier UI quote as
      // share price and chain time advance between RPC calls.
      assets: "9.8",
      discountBps: 25,
      maturityTimestamp: "1700000061",
      deadlineTimestamp: "1700000121",
      ...overrides,
    },
  } as never;
}

describe("queued withdrawal builder intent validation", () => {
  it("accepts dynamic quote and clock drift while preserving stable caller intent", () => {
    expect(() =>
      assertQueuePlan(plan(), position, {
        shares: "10",
        discountBps: 25,
        deadlineSeconds: 60,
      })
    ).not.toThrow();
  });

  it("compares shares numerically, not as decimal strings", () => {
    expect(() =>
      assertQueuePlan(plan({ shares: "10.000000" }), position, {
        shares: "10",
        discountBps: 25,
        deadlineSeconds: 60,
      })
    ).not.toThrow();
  });

  it("rejects plan shares that drift from the caller's requested quantity", () => {
    // The provider's quote is not consulted at all: even if an adapter
    // drifted the quote and plan together, the built quantity must still
    // match what the caller asked for.
    expect(() =>
      assertQueuePlan(plan({ shares: "11" }), position, {
        shares: "10",
        discountBps: 25,
        deadlineSeconds: 60,
      })
    ).toThrow(/stable queue intent/i);
  });

  it("rejects changes to shares, discount, or deadline duration", () => {
    expect(() =>
      assertQueuePlan(plan({ discountBps: 26 }), position, {
        shares: "10",
        discountBps: 25,
        deadlineSeconds: 60,
      })
    ).toThrow(/stable queue intent/i);
    expect(() =>
      assertQueuePlan(plan({ deadlineTimestamp: "1700000122" }), position, {
        shares: "10",
        discountBps: 25,
        deadlineSeconds: 60,
      })
    ).toThrow(/stable queue intent/i);
  });
});
