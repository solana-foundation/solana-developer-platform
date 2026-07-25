import { WELL_KNOWN_TOKENS } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { resolveTransferTokenLabel } from "./payments-overview.utils";

const UNCATALOGUED_MINT = "BmA22WnK8p5Ai5mkzJhk64DCxMiUiii69tgSmUGMWPSh";

describe("resolveTransferTokenLabel", () => {
  it("resolves a well-known mint to its symbol", () => {
    expect(resolveTransferTokenLabel(WELL_KNOWN_TOKENS.USDC.mints.devnet)).toBe("USDC");
    expect(resolveTransferTokenLabel(WELL_KNOWN_TOKENS.USDT.mints["mainnet-beta"])).toBe("USDT");
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
    const usdc = WELL_KNOWN_TOKENS.USDC.mints.devnet;

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
