import { describe, expect, it } from "vitest";
import { delayedWithdrawalAmount, planProportionalWithdrawal } from "./earn-mock-positions";

describe("delayedWithdrawalAmount", () => {
  it("keeps the intraday portion out of the pending redemption", () => {
    expect(delayedWithdrawalAmount(100, 0.1)).toBe(90);
    expect(delayedWithdrawalAmount(100, 1)).toBe(0);
  });

  it("clamps malformed fractions to a safe range", () => {
    expect(delayedWithdrawalAmount(100, -1)).toBe(100);
    expect(delayedWithdrawalAmount(100, 2)).toBe(0);
  });
});

describe("planProportionalWithdrawal", () => {
  it("routes by live position balance", () => {
    expect(
      planProportionalWithdrawal(
        [
          { positionId: "a", amount: 25 },
          { positionId: "b", amount: 75 },
        ],
        40
      )
    ).toEqual([
      { positionId: "a", amount: 10 },
      { positionId: "b", amount: 30 },
    ]);
  });

  it("preserves the exact requested total across repeating fractions", () => {
    const plan = planProportionalWithdrawal(
      [
        { positionId: "a", amount: 1 },
        { positionId: "b", amount: 1 },
        { positionId: "c", amount: 1 },
      ],
      1
    );

    expect(plan.reduce((total, leg) => total + leg.amount, 0)).toBe(1);
    expect(plan.at(-1)?.amount).toBeCloseTo(1 / 3);
  });

  it("rejects stale or invalid requests instead of partially withdrawing", () => {
    const positions = [{ positionId: "a", amount: 100.5 }];

    expect(planProportionalWithdrawal(positions, 100.51)).toEqual([]);
    expect(planProportionalWithdrawal(positions, 0)).toEqual([]);
    expect(planProportionalWithdrawal(positions, Number.NaN)).toEqual([]);
  });
});
