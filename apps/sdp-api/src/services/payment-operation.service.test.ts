import { WELL_KNOWN_TOKENS } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { normalizePaymentToken } from "@/services/payment-operation.service";

describe("normalizePaymentToken", () => {
  it.each([
    ["mainnet-beta", WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address],
    ["devnet", WELL_KNOWN_TOKENS.USDC.mints.devnet.address],
  ] as const)("resolves USDC to its %s mint", (cluster, mint) => {
    expect(normalizePaymentToken("USDC", cluster)).toBe(mint);
  });

  it("refuses a well-known symbol the cluster has no mint for", () => {
    expect(() => normalizePaymentToken("USDT", "devnet")).toThrow(
      "USDT is not available on devnet"
    );
  });
});
