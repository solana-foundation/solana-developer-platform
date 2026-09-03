/**
 * The policy candidate a DvP action is judged on.
 *
 * These tests are about ONE number: the amount an approver is shown. Settle and
 * cancel move whole legs, so the leg's target is the right figure. Funding does
 * not — it tops SDP's leg up to its target — and showing the target there both
 * refuses valid top-ups that sit inside an amount limit and asks a human to
 * approve money that is never going to move.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DvpTradeRow } from "@/db/repositories";
import { env } from "@/test/helpers/env";

const getAuth = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAuth,
}));
vi.mock("@/services/policy/enforcement.service", () => ({
  walletOperationActorFromAuth: () => ({ kind: "api_key", id: "ak_1" }),
}));

const { buildDvpTradeActionPolicyCandidate } = await import("./policy");

const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function trade(overrides: Partial<DvpTradeRow> = {}): DvpTradeRow {
  return {
    id: "dvp_policy_test",
    organizationId: "org_x",
    projectId: "prj_x",
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    settlementAuthority: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
    userA: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    userB: "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg",
    mintA: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    mintB: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
    nonce: "42",
    tokenProgramA: T22,
    tokenProgramB: T22,
    amountA: "1000",
    amountB: "2000",
    expiryTimestamp: "1900000000",
    earliestSettlementTimestamp: null,
    userASettlementDestination: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    userBSettlementDestination: "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg",
    refString: null,
    escrowA: "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU",
    escrowB: "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y",
    sdpSide: "a",
    sdpWalletId: "cwlt_leg",
    status: "created",
    observedAt: null,
    sdpLegFundingSignature: null,
    idempotencyKey: null,
    idempotencyFingerprint: null,
    createSignature: null,
    createLastValidBlockHeight: null,
    escrowAAmount: null,
    escrowBAmount: null,
    escrowAFrozen: null,
    escrowBFrozen: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

const context = { env } as never;
const settlement = {
  custodyWalletId: "cwlt_settle",
  address: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
};

describe("buildDvpTradeActionPolicyCandidate", () => {
  beforeEach(() => {
    getAuth.mockReturnValue({ organizationId: "org_x", apiKeyId: "ak_1" });
  });

  describe("funding a partly funded leg", () => {
    // The case that reached the approvals queue with the wrong figure: the leg
    // targets 1000 and already holds 400, funding will move 600, and 1000 is
    // what a human was being asked to approve.
    it("carries the shortfall, not the leg's target", () => {
      const { candidate } = buildDvpTradeActionPolicyCandidate(
        context,
        trade(),
        settlement,
        "fund",
        600n
      );

      expect(candidate.amount).toBe("600");
    });

    it("puts the shortfall on the evaluated leg too, not just the candidate", () => {
      const { legs } = buildDvpTradeActionPolicyCandidate(
        context,
        trade(),
        settlement,
        "fund",
        600n
      );

      expect(legs).toHaveLength(1);
      expect(legs[0]?.amount).toBe("600");
    });

    it("overrides the side SDP holds when that is leg B", () => {
      const { candidate } = buildDvpTradeActionPolicyCandidate(
        context,
        trade({ sdpSide: "b" }),
        settlement,
        "fund",
        1500n
      );

      expect(candidate.asset).toBe(trade().mintB);
      expect(candidate.amount).toBe("1500");
    });
  });

  // Whole-leg actions are unchanged: the target IS what moves.
  describe("settle and cancel", () => {
    it.each(["settle", "cancel"] as const)("evaluates %s at the leg's full target", (action) => {
      const { candidate, legs } = buildDvpTradeActionPolicyCandidate(
        context,
        trade(),
        settlement,
        action
      );

      expect(candidate.amount).toBe("1000");
      expect(legs.map((leg) => leg.amount)).toEqual(["1000", "2000"]);
    });
  });

  // A funding top-up moves ONE leg, so the counterparty's leg is not part of
  // the operation and must not be evaluated as though it were.
  it("evaluates only SDP's leg when funding", () => {
    const { legs } = buildDvpTradeActionPolicyCandidate(context, trade(), settlement, "fund", 600n);

    expect(legs).toHaveLength(1);
    expect(legs[0]?.asset).toBe(trade().mintA);
  });

  it("sends a funding leg's tokens to the escrow, not to a settlement destination", () => {
    const { candidate } = buildDvpTradeActionPolicyCandidate(
      context,
      trade(),
      settlement,
      "fund",
      600n
    );

    expect(candidate.destination).toBe(trade().escrowA);
  });
});
