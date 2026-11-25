import type { EarnVaultTransactionPlan } from "@sdp/earn/types";
import { describe, expect, it } from "vitest";
import { requireAcceptedPlan, requireAcceptedWithdrawalPlan } from "./strategy-plan";

const tokenMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const shareMint = "So11111111111111111111111111111111111111112";

function plan(overrides: Partial<EarnVaultTransactionPlan> = {}): EarnVaultTransactionPlan {
  return {
    cluster: "devnet",
    instructions: [],
    lookupTables: [],
    assetIdentity: { depositTokenMint: tokenMint, shareMint },
    accepted: { amount: "10", shares: "10" },
    ...overrides,
  };
}

const deposit = { tokenMint, shareMint, amount: "10.000000", minSharesOut: "9.500000" };
const withdrawal = { tokenMint, shareMint, shares: "10.000000", minAmountOut: "9.500000" };

describe("admitted strategy plan identity and amounts", () => {
  it("accepts equivalent decimal values without changing provider precision", () => {
    expect(
      requireAcceptedPlan(plan({ accepted: { amount: "10", minSharesOut: "9.5" } }), deposit)
    ).toEqual({ minSharesOut: "9.5" });
    expect(() =>
      requireAcceptedWithdrawalPlan(
        plan({ accepted: { shares: "10", minAmountOut: "9.5" } }),
        withdrawal
      )
    ).not.toThrow();
  });

  it.each([
    { depositTokenMint: shareMint, shareMint },
    { depositTokenMint: tokenMint, shareMint: tokenMint },
  ])("refuses a substituted deposit or share asset before signing", (assetIdentity) => {
    expect(() => requireAcceptedPlan(plan({ assetIdentity }), deposit)).toThrow(/mint/);
    expect(() => requireAcceptedWithdrawalPlan(plan({ assetIdentity }), withdrawal)).toThrow(
      /mint/
    );
  });

  it.each([undefined, {}, { amount: "9" }, { amount: "11" }])(
    "refuses a missing or changed deposit amount",
    (accepted) => {
      expect(() => requireAcceptedPlan(plan({ accepted }), deposit)).toThrow(/amount/);
    }
  );

  it.each([undefined, {}, { shares: "9" }, { shares: "11" }])(
    "refuses a missing or changed withdrawal share count",
    (accepted) => {
      expect(() => requireAcceptedWithdrawalPlan(plan({ accepted }), withdrawal)).toThrow(/shares/);
    }
  );

  it.each([undefined, "9", "10"])("refuses an omitted or changed deposit floor", (minSharesOut) => {
    expect(() =>
      requireAcceptedPlan(plan({ accepted: { amount: "10", minSharesOut } }), deposit)
    ).toThrow(/minSharesOut/);
  });

  it.each([undefined, "9", "10"])(
    "refuses an omitted or changed withdrawal floor",
    (minAmountOut) => {
      expect(() =>
        requireAcceptedWithdrawalPlan(
          plan({ accepted: { shares: "10", minAmountOut } }),
          withdrawal
        )
      ).toThrow(/minAmountOut/);
    }
  );

  it("refuses a provider-added floor that was never admitted", () => {
    expect(() =>
      requireAcceptedPlan(plan({ accepted: { amount: "10", minSharesOut: "9.5" } }), {
        tokenMint,
        shareMint,
        amount: "10",
      })
    ).toThrow(/floor/);
    expect(() =>
      requireAcceptedWithdrawalPlan(plan({ accepted: { shares: "10", minAmountOut: "9.5" } }), {
        tokenMint,
        shareMint,
        shares: "10",
      })
    ).toThrow(/floor/);
  });
});
