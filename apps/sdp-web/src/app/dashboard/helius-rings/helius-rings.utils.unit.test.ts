import { describe, expect, it } from "vitest";
import type { RingsHealth } from "./helius-rings.data";
import {
  formatBaseUnits,
  healthAlerts,
  healthReason,
  readShieldedAmount,
  shortenShieldedAddress,
} from "./helius-rings.utils";

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

describe("readShieldedAmount", () => {
  it("renders at the mint's scale when the API reported one", () => {
    expect(readShieldedAmount("1500000", 6)).toEqual({ scale: "exact", text: "1.5" });
    expect(readShieldedAmount("18446744073709551615", 9)).toEqual({
      scale: "exact",
      text: "18446744073.709551615",
    });
  });

  it("keeps a real zero scale apart from an unknown one", () => {
    // Identical digits, different claims: only the first says this mint has no
    // fraction. Collapsing them makes 1.50 USDC read as 1500000 whole tokens.
    expect(readShieldedAmount("1500000", 0)).toEqual({ scale: "exact", text: "1500000" });
    expect(readShieldedAmount("1500000", null)).toEqual({ scale: "baseUnits", text: "1500000" });
  });

  it("carries an unknown scale's digits through exactly", () => {
    expect(readShieldedAmount("18446744073709551615", null)).toEqual({
      scale: "baseUnits",
      text: "18446744073709551615",
    });
  });

  it("renders nothing for an amount that is not a count of base units", () => {
    expect(readShieldedAmount("1.5", null)).toEqual({ scale: "unrenderable" });
    expect(readShieldedAmount("-1", 6)).toEqual({ scale: "unrenderable" });
    expect(readShieldedAmount("1000000", 256)).toEqual({ scale: "unrenderable" });
  });
});

function health(overrides: Partial<RingsHealth> = {}): RingsHealth {
  return { rpc: "green", prover: "green", photon: "green", gateway: "green", ...overrides };
}

describe("healthReason", () => {
  it("reads the API's <component>.reason key", () => {
    const observed = health({
      rpc: "red",
      detail: { "rpc.reason": "HELIUS_RINGS_RPC_URL is not configured" },
    });

    expect(healthReason(observed, "rpc")).toBe("HELIUS_RINGS_RPC_URL is not configured");
    expect(healthReason(observed, "photon")).toBeNull();
    expect(healthReason(null, "rpc")).toBeNull();
  });
});

describe("healthAlerts", () => {
  it("collapses one shared reason into a single entry naming every component", () => {
    const reason = 'Rings adapter "ts" is selected but HELIUS_RINGS_RPC_URL is not configured';

    expect(
      healthAlerts(
        health({
          rpc: "red",
          prover: "red",
          photon: "red",
          gateway: "red",
          detail: {
            "rpc.reason": reason,
            "prover.reason": reason,
            "photon.reason": reason,
            "gateway.reason": reason,
          },
        })
      )
    ).toEqual([{ components: ["rpc", "prover", "photon", "gateway"], reason }]);
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
    expect(healthAlerts(health({ gateway: "red" }))).toEqual([]);
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
