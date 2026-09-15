import { describe, expect, it } from "vitest";
import {
  conservativeExitNetBaseUnits,
  deriveKaminoDepositQuote,
  deriveKaminoWithdrawQuote,
  detectDepositCapClamp,
  exitInstructionCount,
  type KaminoDepositEstimate,
  type KaminoExitPlanObservation,
} from "./quotes";

/** A vault priced 1:1 (one share base unit per token base unit) with 1.5 units of cap. */
function estimate(overrides: Partial<KaminoDepositEstimate> = {}): KaminoDepositEstimate {
  return {
    sharesOutBaseUnits: 800_000n,
    shareDecimals: 6,
    tokensForSharesBaseUnits: 800_000n,
    depositCapBaseUnits: 1_500_000n,
    netAumBaseUnits: 1_000_000n,
    sharesIssuedBaseUnits: 1_000_000n,
    ...overrides,
  };
}

describe("detectDepositCapClamp", () => {
  it("never reports a clamp on an uncapped vault", () => {
    expect(detectDepositCapClamp(estimate({ depositCapBaseUnits: 0n }))).toBe(false);
  });

  it("reports a first deposit above the whole cap, clamped 1:1", () => {
    expect(
      detectDepositCapClamp(
        estimate({
          sharesIssuedBaseUnits: 0n,
          tokensForSharesBaseUnits: 2_000_000n,
          sharesOutBaseUnits: 1_500_000n,
        })
      )
    ).toBe(true);
    expect(
      detectDepositCapClamp(
        estimate({
          sharesIssuedBaseUnits: 0n,
          tokensForSharesBaseUnits: 1_000_000n,
          sharesOutBaseUnits: 1_000_000n,
        })
      )
    ).toBe(false);
  });

  it("leaves a deposit within the remaining cap alone", () => {
    // 1.5 cap less 1.0 AUM leaves 0.5; 0.4 fits.
    expect(
      detectDepositCapClamp(
        estimate({ tokensForSharesBaseUnits: 400_000n, sharesOutBaseUnits: 400_000n })
      )
    ).toBe(false);
  });

  /** Filling the remaining cap exactly is a full acceptance, not a clamp. */
  it("does not report an exact fill of the remaining cap", () => {
    expect(
      detectDepositCapClamp(
        estimate({ tokensForSharesBaseUnits: 500_000n, sharesOutBaseUnits: 500_000n })
      )
    ).toBe(false);
  });

  it("reports a clamp when the SDK's estimate matches the clamped prediction", () => {
    // 0.8 requested against 0.5 remaining: the SDK prices 0.5.
    expect(detectDepositCapClamp(estimate({ sharesOutBaseUnits: 500_000n }))).toBe(true);
  });

  /**
   * The replica of the SDK's AUM can drift by a lamport (it vests rewards
   * against wall-clock time). A mismatch must withhold the issue, never invent it.
   */
  it("withholds the issue when the estimate matches neither prediction", () => {
    expect(detectDepositCapClamp(estimate({ sharesOutBaseUnits: 499_999n }))).toBe(false);
  });

  it("reports a full vault, where the estimate is zero", () => {
    expect(
      detectDepositCapClamp(estimate({ netAumBaseUnits: 1_500_000n, sharesOutBaseUnits: 0n }))
    ).toBe(true);
  });
});

describe("deriveKaminoDepositQuote", () => {
  it("formats the estimate at share decimals with no issues on a clean quote", () => {
    expect(deriveKaminoDepositQuote(estimate())).toEqual({
      sharesOut: "0.8",
      shareDecimals: 6,
      issues: [],
    });
  });

  it("reports both the clamp and the empty mint on a full vault", () => {
    const quote = deriveKaminoDepositQuote(
      estimate({ netAumBaseUnits: 1_500_000n, sharesOutBaseUnits: 0n })
    );
    expect(quote.sharesOut).toBe("0");
    expect(quote.issues.map((issue) => issue.code)).toEqual([
      "DEPOSIT_CAP_EXCEEDED",
      "ZERO_SHARES_OUT",
    ]);
  });

  it("reports an amount the crank funds consume as minting nothing", () => {
    const quote = deriveKaminoDepositQuote(
      estimate({ tokensForSharesBaseUnits: -5n, sharesOutBaseUnits: 0n })
    );
    expect(quote.issues.map((issue) => issue.code)).toEqual(["ZERO_SHARES_OUT"]);
  });
});

function observation(
  overrides: Partial<KaminoExitPlanObservation> = {}
): KaminoExitPlanObservation {
  return {
    netBaseUnits: 1_000_000n,
    flatPenaltyBaseUnits: 10n,
    reserveCount: 0,
    remainingBaseUnits: 0n,
    minimumWithdrawalBaseUnits: 0n,
    assetDecimals: 6,
    ...overrides,
  };
}

describe("conservativeExitNetBaseUnits", () => {
  it("emits one instruction for an exit the idle liquidity covers", () => {
    expect(exitInstructionCount(0)).toBe(1);
    expect(exitInstructionCount(1)).toBe(1);
    expect(exitInstructionCount(3)).toBe(3);
  });

  it("leaves a single-instruction exit at the SDK's net", () => {
    expect(conservativeExitNetBaseUnits(observation())).toBe(1_000_000n);
    expect(conservativeExitNetBaseUnits(observation({ reserveCount: 1 }))).toBe(1_000_000n);
  });

  /** (N - 1) x flat for the per-instruction floor, plus (N - 1) for per-instruction rounding. */
  it("subtracts the per-instruction penalty bound for a split exit", () => {
    expect(conservativeExitNetBaseUnits(observation({ reserveCount: 3 }))).toBe(
      1_000_000n - 2n * 11n
    );
  });

  it("floors at zero rather than going negative", () => {
    expect(conservativeExitNetBaseUnits(observation({ netBaseUnits: 15n, reserveCount: 3 }))).toBe(
      0n
    );
  });
});

describe("deriveKaminoWithdrawQuote", () => {
  it("formats the conservative net at token decimals with no issues on a clean quote", () => {
    expect(deriveKaminoWithdrawQuote(observation({ reserveCount: 2 }))).toEqual({
      assetsOut: "0.999989",
      assetDecimals: 6,
      issues: [],
    });
  });

  it("names how much of the exit the vault and reserves can cover when liquidity is short", () => {
    const quote = deriveKaminoWithdrawQuote(observation({ remainingBaseUnits: 250_000n }));
    expect(quote.issues).toEqual([
      {
        code: "INSUFFICIENT_WITHDRAWAL_LIQUIDITY",
        message: expect.stringContaining("can cover 0.75 of the 1 this exit needs"),
      },
    ]);
  });

  it("reports an exit the penalties consume", () => {
    const quote = deriveKaminoWithdrawQuote(observation({ netBaseUnits: 0n }));
    expect(quote.assetsOut).toBe("0");
    expect(quote.issues.map((issue) => issue.code)).toEqual(["ZERO_ASSETS_OUT"]);
  });

  it("reports a net at or below the vault's minimum withdrawal", () => {
    const quote = deriveKaminoWithdrawQuote(
      observation({ netBaseUnits: 5_000n, minimumWithdrawalBaseUnits: 5_000n })
    );
    expect(quote.issues).toEqual([
      {
        code: "BELOW_MINIMUM_WITHDRAWAL",
        message: expect.stringContaining("minimum withdrawal of 0.005"),
      },
    ]);
    expect(
      deriveKaminoWithdrawQuote(
        observation({ netBaseUnits: 5_001n, minimumWithdrawalBaseUnits: 5_000n })
      ).issues
    ).toEqual([]);
  });
});
