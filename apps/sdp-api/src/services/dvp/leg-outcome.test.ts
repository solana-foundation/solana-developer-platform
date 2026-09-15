import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { DvpTradeRow } from "@/db/repositories";
import { deriveDvpLegOutcome } from "./leg-outcome";

const ADDRESS = address("11111111111111111111111111111111");

/** Builds a complete persisted trade for outcome derivation tests. */
function trade(overrides: Partial<DvpTradeRow>): DvpTradeRow {
  return {
    id: "dvp_outcome",
    organizationId: "org_test",
    projectId: "prj_test",
    swapDvp: ADDRESS,
    settlementAuthority: ADDRESS,
    userA: ADDRESS,
    userB: ADDRESS,
    mintA: ADDRESS,
    mintB: ADDRESS,
    nonce: "1",
    tokenProgramA: ADDRESS,
    tokenProgramB: ADDRESS,
    decimalsA: 6,
    decimalsB: 6,
    symbolA: "A",
    symbolB: "B",
    nameA: "Asset A",
    nameB: "Asset B",
    closeSignature: null,
    closeResolutionAttempts: 0,
    closeResolutionAfter: null,
    closedAt: null,
    amountA: "100",
    amountB: "200",
    expiryTimestamp: "1900000000",
    earliestSettlementTimestamp: null,
    userASettlementDestination: ADDRESS,
    userBSettlementDestination: ADDRESS,
    refString: null,
    escrowA: ADDRESS,
    escrowB: ADDRESS,
    counterpartyAccountIdA: null,
    counterpartyAccountIdB: null,
    status: "created",
    observedAt: null,
    idempotencyKey: null,
    idempotencyFingerprint: null,
    createSignature: null,
    createLastValidBlockHeight: null,
    escrowAAmount: null,
    escrowBAmount: null,
    escrowAPeakAmount: null,
    escrowBPeakAmount: null,
    escrowAFrozen: null,
    escrowBFrozen: null,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

const CLOSED_AND_OBSERVED = {
  closedAt: "2026-09-10T00:01:00.000Z",
  observedAt: "2026-09-10T00:01:00.000Z",
} as const satisfies Partial<DvpTradeRow>;

const CLOSED_UNOBSERVED = {
  closedAt: "2026-09-10T00:01:00.000Z",
  observedAt: "2026-09-10T00:00:00.000Z",
} as const satisfies Partial<DvpTradeRow>;

describe("deriveDvpLegOutcome", () => {
  it.each([
    ["awaiting", trade({ escrowAAmount: "0", escrowAPeakAmount: "0" })],
    ["partial", trade({ escrowAAmount: "50", escrowAPeakAmount: "50" })],
    ["funded", trade({ escrowAAmount: "100", escrowAPeakAmount: "100" })],
    ["overfunded", trade({ escrowAAmount: "101", escrowAPeakAmount: "101" })],
    ["frozen", trade({ escrowAAmount: "100", escrowAFrozen: true })],
    ["reclaimed", trade({ escrowAAmount: "25", escrowAPeakAmount: "100" })],
    ["expired", trade({ status: "expired", escrowAAmount: "25", escrowAPeakAmount: "25" })],
    ["delivered", trade({ status: "settled" })],
    ["refunded", trade({ status: "rejected" })],
    [
      "recoverable",
      trade({ ...CLOSED_AND_OBSERVED, status: "closed_unknown", escrowAAmount: "1" }),
    ],
    ["closed", trade({ status: "create_failed", escrowAAmount: "0" })],
  ] as const)("derives %s", (outcome, row) => {
    expect(deriveDvpLegOutcome(row, "a")).toBe(outcome);
  });

  // Settle, Cancel and Reject close the escrow, so a balance under any closed
  // trade is a deposit that arrived afterwards. Naming the leg delivered or
  // refunded would hide funds only RecoverDvp can move.
  it.each([
    ["settled", trade({ ...CLOSED_AND_OBSERVED, status: "settled", escrowAAmount: "1" })],
    ["cancelled", trade({ ...CLOSED_AND_OBSERVED, status: "cancelled", escrowAAmount: "1" })],
    ["rejected", trade({ ...CLOSED_AND_OBSERVED, status: "rejected", escrowAAmount: "1" })],
  ] as const)("reports a late deposit under a %s trade as recoverable", (_status, row) => {
    expect(deriveDvpLegOutcome(row, "a")).toBe("recoverable");
  });

  // recordClose moves the status before the post-close reading lands, so the
  // balances still on the row were read while the trade was open.
  it.each([
    [
      "settled",
      "delivered",
      trade({ ...CLOSED_UNOBSERVED, status: "settled", escrowAAmount: "100" }),
    ],
    [
      "cancelled",
      "refunded",
      trade({ ...CLOSED_UNOBSERVED, status: "cancelled", escrowAAmount: "100" }),
    ],
  ] as const)("reads a pre-close balance under a %s trade as %s", (_status, outcome, row) => {
    expect(deriveDvpLegOutcome(row, "a")).toBe(outcome);
  });
});
