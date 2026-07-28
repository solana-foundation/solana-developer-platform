import { WELL_KNOWN_TOKENS } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { formatTokenAmount, resolveTransferTokenLabel } from "./payments-overview.utils";

const UNCATALOGUED_MINT = "BmA22WnK8p5Ai5mkzJhk64DCxMiUiii69tgSmUGMWPSh";

// Intl groups with a no-break space in French; match both forms it may emit.
const normalizeSpaces = (value: string) => value.replace(/[\xa0\u202f]/g, " ");

describe("resolveTransferTokenLabel", () => {
  it("resolves a well-known mint to its symbol", () => {
    expect(resolveTransferTokenLabel(WELL_KNOWN_TOKENS.USDC.mints.devnet.address)).toBe("USDC");
    expect(resolveTransferTokenLabel(WELL_KNOWN_TOKENS.USDT.mints["mainnet-beta"].address)).toBe(
      "USDT"
    );
  });

  it("shortens a mint it cannot name", () => {
    expect(resolveTransferTokenLabel(UNCATALOGUED_MINT)).toBe("BmA22W…WPSh");
  });

  it("prefers a caller-supplied symbol over shortening", () => {
    expect(resolveTransferTokenLabel(UNCATALOGUED_MINT, { [UNCATALOGUED_MINT]: "ATD" })).toBe(
      "ATD"
    );
  });

  it("ignores a supplied symbol that is just the mint repeated", () => {
    // The balances payload echoes the mint when it has no symbol for a token;
    // treating that as a name would defeat the shortened-address fallback.
    expect(
      resolveTransferTokenLabel(UNCATALOGUED_MINT, { [UNCATALOGUED_MINT]: UNCATALOGUED_MINT })
    ).toBe("BmA22W…WPSh");
  });

  it("keeps the catalogue authoritative for well-known mints", () => {
    const usdc = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;

    expect(resolveTransferTokenLabel(usdc, { [usdc]: usdc })).toBe("USDC");
  });

  it("returns undefined for a missing or blank token", () => {
    expect(resolveTransferTokenLabel(null)).toBeUndefined();
    expect(resolveTransferTokenLabel(undefined)).toBeUndefined();
    expect(resolveTransferTokenLabel("   ")).toBeUndefined();
  });

  it("leaves a short non-mint ticker alone", () => {
    expect(resolveTransferTokenLabel("SOL")).toBe("SOL");
  });
});

describe("formatTokenAmount", () => {
  it("groups English amounts with commas and a dot decimal", () => {
    expect(formatTokenAmount("1234567.89", "en")).toBe("1,234,567.89");
  });

  it("groups French amounts with spaces and a comma decimal", () => {
    expect(normalizeSpaces(formatTokenAmount("1234567.89", "fr"))).toBe("1 234 567,89");
  });

  it("keeps every input digit on high-precision amounts", () => {
    expect(formatTokenAmount("123456789.123456789", "en")).toBe("123,456,789.123456789");
  });

  it("preserves the sign on fractional negative amounts", () => {
    expect(formatTokenAmount("-0.5", "en")).toBe("-0.5");
  });

  it("returns non-numeric input unchanged", () => {
    expect(formatTokenAmount("not-a-number", "fr")).toBe("not-a-number");
  });
});
