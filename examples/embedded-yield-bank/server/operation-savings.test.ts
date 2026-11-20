import { describe, expect, it } from "vitest";
import type { EarnOperation } from "../src/lib/core-operation";
import {
  operationsForSavingsStrategy,
  summarizeSavingsOperations,
} from "./operation-savings";

const mint = "usdc";
function operation(
  kind: "earn.deposit" | "earn.withdraw",
  overrides: Partial<EarnOperation> = {}
): EarnOperation {
  return {
    id: kind,
    kind,
    status: "completed",
    intent:
      kind === "earn.deposit"
        ? {
            kind,
            strategyId: "strategy",
            source: { ownerAddress: "owner" },
            amount: { mint, value: "100" },
          }
        : {
            kind,
            positionId: "position",
            amount: { kind: "token", mint, value: "105" },
          },
    actionId: "action",
    version: 1,
    nextAction: null,
    terms: {
      expiresAt: null,
      estimate: null,
      minimum: null,
      fees: null,
      options: [],
    },
    resourceRef: { kind: "earn.movement", id: kind },
    result: {
      positionId: "position",
      strategyId: "strategy",
      signature: "signature",
      settledAmount: { mint, value: "105" },
      settlementOutcome: "delivered",
    },
    canCancel: false,
    cancelRequestedAt: null,
    error: null,
    createdAt: "2026-11-18T12:00:00Z",
    updatedAt: "2026-11-18T12:00:00Z",
    ...overrides,
  };
}

describe("operation savings adapter", () => {
  it("preserves realized earnings after a full exit", () => {
    expect(
      summarizeSavingsOperations(
        { amount: "105" },
        null,
        [operation("earn.deposit"), operation("earn.withdraw")],
        mint
      )
    ).toMatchObject({ balance: "0", earned: "5", total: "105" });
  });
  it("does not treat recovered shares as an earnings payout or an unknown cash flow", () => {
    const recovered = operation("earn.withdraw", {
      result: {
        positionId: "position",
        signature: "recovery",
        strategyId: "strategy",
        settledAmount: { mint: "shares", value: "3" },
        settlementOutcome: "recovered",
      },
    });
    expect(
      summarizeSavingsOperations(
        { amount: "105" },
        null,
        [operation("earn.deposit"), operation("earn.withdraw"), recovered],
        mint
      )
    ).toMatchObject({ earned: "5", total: "105" });
  });

  it("keeps closed-position withdrawals scoped by their recorded strategy", () => {
    const exit = operation("earn.withdraw");
    expect(operationsForSavingsStrategy([exit], "strategy", [])).toEqual([
      exit,
    ]);
    expect(operationsForSavingsStrategy([exit], "other", [])).toEqual([]);
  });
  it("withholds queued assets until settlement is verified", () => {
    expect(
      summarizeSavingsOperations(
        { amount: "0" },
        null,
        [
          operation("earn.deposit"),
          operation("earn.withdraw", {
            status: "settling",
            resourceRef: { kind: "earn.withdrawal_request", id: "request" },
          }),
        ],
        mint
      )
    ).toMatchObject({
      balance: undefined,
      earned: undefined,
      total: undefined,
    });
  });
  it("withholds an unvalued completed payout", () => {
    const withdrawal = operation("earn.withdraw");
    expect(
      summarizeSavingsOperations(
        { amount: "105" },
        null,
        [
          operation("earn.deposit"),
          {
            ...withdrawal,
            result: {
              ...withdrawal.result,
              positionId: "position",
              signature: "signature",
              settledAmount: null,
            },
          },
        ],
        mint
      ).earned
    ).toBeUndefined();
  });
  it("withholds earnings when acquisition history is unknown", () => {
    expect(
      summarizeSavingsOperations(
        { amount: "105" },
        null,
        [operation("earn.withdraw")],
        mint
      ).earned
    ).toBeUndefined();
  });
  it("does not count failed or cancelled exits as payouts", () => {
    expect(
      summarizeSavingsOperations(
        { amount: "0" },
        null,
        [
          operation("earn.withdraw", { status: "failed" }),
          operation("earn.withdraw", { status: "cancelled" }),
        ],
        mint
      ).earned
    ).toBe("0");
  });
  it("withholds a payout in another token", () => {
    const withdrawal = operation("earn.withdraw");
    expect(
      summarizeSavingsOperations(
        { amount: "105" },
        null,
        [
          operation("earn.deposit"),
          {
            ...withdrawal,
            result: {
              ...withdrawal.result,
              positionId: "position",
              signature: "signature",
              settledAmount: { mint: "other", value: "105" },
            },
          },
        ],
        mint
      ).earned
    ).toBeUndefined();
  });
});
