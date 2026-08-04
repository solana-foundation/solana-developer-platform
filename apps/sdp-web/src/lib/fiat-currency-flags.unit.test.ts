import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp-support";
import { fiatCurrencyFlagEmoji, regionFlagEmoji } from "@sdp/types/payment-rails";
import { describe, expect, it } from "vitest";

// The helpers live in @sdp/types, which carries no test runner of its own. They
// are exercised here because the dashboard is what renders their output — the
// currency comboboxes in the issuance draft wizard and the ramps pair selector.

/** Decodes a flag emoji back to the region whose letters it was built from. */
function regionOf(flag: string): string {
  return [...flag]
    .map((ch) => String.fromCharCode((ch.codePointAt(0) ?? 0) - 0x1f1e6 + 65))
    .join("");
}

describe("regionFlagEmoji", () => {
  it("builds the regional-indicator pair for a region that has a flag", () => {
    expect(regionFlagEmoji("US")).toBe("🇺🇸");
    expect(regionFlagEmoji("MX")).toBe("🇲🇽");
    expect(regionFlagEmoji("EU")).toBe("🇪🇺");
  });

  it("accepts lowercase input", () => {
    expect(regionFlagEmoji("gb")).toBe(regionFlagEmoji("GB"));
  });

  it("returns null for codes Unicode defines no flag sequence for", () => {
    // "AN" is the trap: ISO 3166-1 withdrew it, but CLDR aliases it onto its
    // successor region ("Curaçao"), so any name-based test would let it emit
    // 🇦🇳 — a pair no font draws.
    expect(regionFlagEmoji("AN")).toBeNull();
    expect(regionFlagEmoji("XA")).toBeNull();
    expect(regionFlagEmoji("ZZ")).toBeNull();
    expect(regionFlagEmoji("QM")).toBeNull();
    expect(regionFlagEmoji("")).toBeNull();
    expect(regionFlagEmoji("USA")).toBeNull();
  });
});

describe("fiatCurrencyFlagEmoji", () => {
  it("flags currencies by their issuing region", () => {
    expect(fiatCurrencyFlagEmoji("AMD")).toBe("🇦🇲");
    expect(fiatCurrencyFlagEmoji("AOA")).toBe("🇦🇴");
    expect(fiatCurrencyFlagEmoji("EUR")).toBe("🇪🇺");
  });

  it("returns null for the supranational currencies, which have no flag", () => {
    // Shared currencies get an X-prefixed code, so there is no issuing region to
    // read a flag from. They stay in the picker — the CFA francs alone are legal
    // tender in fourteen countries — and render as a bare code.
    for (const supranational of ["XAF", "XCD", "XOF", "XPF"] as const) {
      expect(fiatCurrencyFlagEmoji(supranational)).toBeNull();
    }
  });

  it("never emits a flag for a region that is not a live ISO 3166-1 code", () => {
    // Independent of the allowlist: CLDR canonicalisation rewrites a withdrawn
    // code to its successor, so region === canonical(region) only holds for
    // codes still in use — the ones vendors ship flags for.
    for (const currency of RAMP_FIAT_CURRENCIES) {
      const flag = fiatCurrencyFlagEmoji(currency);
      if (flag === null) {
        continue;
      }
      const region = regionOf(flag);
      expect(region, `${currency} flag region`).toBe(currency.slice(0, 2));
      expect(new Intl.Locale(`und-${region}`).region, `${currency} region`).toBe(region);
    }
  });
});
