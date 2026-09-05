import { describe, expect, it } from "vitest";
import type { RingsHealth } from "./helius-rings.data";
import {
  formatAssetAmount,
  formatBaseUnits,
  healthAlerts,
  healthReason,
  parseDecimalToBaseUnits,
  shortenShieldedAddress,
} from "./helius-rings.utils";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/**
 * A shielded amount is a uint64 count of base units, so each expectation below
 * is a value a float would have changed.
 */
describe("formatBaseUnits", () => {
  it("renders the whole uint64 range exactly", () => {
    // 2^64 - 1. A float rounds this to 18446744073709552000.
    expect(formatBaseUnits("18446744073709551615", 9)).toBe("18446744073.709551615");
    expect(formatBaseUnits("18446744073709551615", 0)).toBe("18446744073709551615");
    expect(formatBaseUnits("18446744073709551615", 6)).toBe("18446744073709.551615");
  });

  it("keeps digits a float would have dropped just past 2^53", () => {
    // Number("9007199254740993") is 9007199254740992.
    expect(formatBaseUnits("9007199254740993", 0)).toBe("9007199254740993");
    expect(formatBaseUnits("9007199254740993", 6)).toBe("9007199254.740993");
  });

  it("renders zero as zero at any scale, and never as an empty fraction", () => {
    expect(formatBaseUnits("0", 0)).toBe("0");
    expect(formatBaseUnits("0", 9)).toBe("0");
    expect(formatBaseUnits("000", 6)).toBe("0");
  });

  it("places the point for amounts below one unit", () => {
    expect(formatBaseUnits("1", 9)).toBe("0.000000001");
    expect(formatBaseUnits("1", 6)).toBe("0.000001");
    expect(formatBaseUnits("1000000", 9)).toBe("0.001");
    expect(formatBaseUnits("123", 6)).toBe("0.000123");
  });

  it("drops trailing zeroes in the fraction without leaving a stray point", () => {
    expect(formatBaseUnits("1500000", 6)).toBe("1.5");
    expect(formatBaseUnits("1000000", 6)).toBe("1");
    expect(formatBaseUnits("1200000000", 9)).toBe("1.2");
    expect(formatBaseUnits("100", 2)).toBe("1");
    // Leading zeroes on the way in are not significant either.
    expect(formatBaseUnits("0001500000", 6)).toBe("1.5");
  });

  it("refuses anything that is not an unsigned integer of base units", () => {
    for (const amount of ["", " ", "-1", "1.5", "1e9", "0x10", " 12", "12 ", "abc", "+1"]) {
      expect(formatBaseUnits(amount, 6)).toBeNull();
    }
  });

  it("refuses a scale that is not a mint's decimals", () => {
    expect(formatBaseUnits("1000000", -1)).toBeNull();
    expect(formatBaseUnits("1000000", 1.5)).toBeNull();
    // Above a u8: padding to it would allocate against a value no mint has.
    expect(formatBaseUnits("1000000", 256)).toBeNull();
    expect(formatBaseUnits("1000000", Number.NaN)).toBeNull();
  });
});

describe("parseDecimalToBaseUnits", () => {
  it("scales integer amounts by the mint's decimals", () => {
    expect(parseDecimalToBaseUnits("1", 9)).toBe("1000000000");
    expect(parseDecimalToBaseUnits("0", 9)).toBe("0");
    expect(parseDecimalToBaseUnits("42", 6)).toBe("42000000");
  });

  it("preserves the fraction exactly up to the mint's precision", () => {
    expect(parseDecimalToBaseUnits("1.01", 9)).toBe("1010000000");
    expect(parseDecimalToBaseUnits("0.000000001", 9)).toBe("1");
    expect(parseDecimalToBaseUnits("1.5", 6)).toBe("1500000");
  });

  it("refuses more precision than the mint carries", () => {
    // Truncating silently would send a smaller amount than the operator typed.
    expect(parseDecimalToBaseUnits("1.0000000001", 9)).toBeNull();
    expect(parseDecimalToBaseUnits("0.0000001", 6)).toBeNull();
  });

  it("refuses shapes that are not a decimal number", () => {
    for (const s of ["", ".", ".5", "1.", "-1", "1e9", "0x1", "1,5", " 1", "1 ", "abc"]) {
      expect(parseDecimalToBaseUnits(s, 9)).toBeNull();
    }
  });
});

describe("formatAssetAmount", () => {
  it("renders the amount at the mint's scale, suffixed with the symbol", () => {
    expect(formatAssetAmount("1010000000", SOL_MINT)).toBe("1.01 SOL");
    expect(formatAssetAmount("1", SOL_MINT)).toBe("0.000000001 SOL");
    expect(formatAssetAmount("1500000", USDC_MINT)).toBe("1.5 USDC");
  });

  it("falls back to raw digits for an unknown mint", () => {
    expect(formatAssetAmount("123", "unknown-mint")).toBe("123");
  });

  it("reads a missing amount as an em dash", () => {
    expect(formatAssetAmount(null, SOL_MINT)).toBe("—");
    expect(formatAssetAmount("", SOL_MINT)).toBe("—");
  });
});

function health(overrides: Partial<RingsHealth> = {}): RingsHealth {
  return { rpc: "green", prover: "green", photon: "green", ...overrides };
}

describe("healthReason", () => {
  it("reads the API's <component>.reason key", () => {
    const observed = health({
      rpc: "red",
      detail: { "rpc.reason": "Helius Rings setup is required" },
    });

    expect(healthReason(observed, "rpc")).toBe("Helius Rings setup is required");
    expect(healthReason(observed, "photon")).toBeNull();
    expect(healthReason(null, "rpc")).toBeNull();
  });
});

describe("healthAlerts", () => {
  it("collapses one shared reason into a single entry naming every component", () => {
    const reason = "Helius Rings setup is required";

    expect(
      healthAlerts(
        health({
          rpc: "red",
          prover: "red",
          photon: "red",
          detail: {
            "rpc.reason": reason,
            "prover.reason": reason,
            "photon.reason": reason,
          },
        })
      )
    ).toEqual([{ components: ["rpc", "prover", "photon"], reason }]);
  });

  it("keeps distinct reasons apart, in component order", () => {
    expect(
      healthAlerts(
        health({
          rpc: "amber",
          photon: "red",
          detail: { "rpc.reason": "slow", "photon.reason": "unreachable" },
        })
      )
    ).toEqual([
      { components: ["rpc"], reason: "slow" },
      { components: ["photon"], reason: "unreachable" },
    ]);
  });

  it("reports nothing for a green component or for a red one with no reason", () => {
    expect(
      healthAlerts(health({ detail: { "rpc.reason": "stale note on a healthy probe" } }))
    ).toEqual([]);
    expect(healthAlerts(health({ rpc: "red" }))).toEqual([]);
    expect(healthAlerts(null)).toEqual([]);
  });
});

describe("shortenShieldedAddress", () => {
  it("keeps a short value whole", () => {
    expect(shortenShieldedAddress("rings1short")).toBe("rings1short");
  });

  it("takes the middle out of a long commitment", () => {
    const address =
      "3L2B7qgNjaed296FQZu58Ztf3EchddJSS8JEoQXuMDiZ9Uxueyfbd8ooVwchddHBSNgAFXRAJVNKNRvRBtZoB6Lxo";

    expect(shortenShieldedAddress(address)).toBe("3L2B7q…6Lxo");
    expect(shortenShieldedAddress(address)).not.toContain(address.slice(6, -4));
  });
});
