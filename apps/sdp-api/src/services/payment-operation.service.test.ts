import { WELL_KNOWN_TOKENS } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { normalizePaymentToken } from "@/services/payment-operation.service";

describe("normalizePaymentToken", () => {
  it("maps USDC to the mint of the cluster it is given", () => {
    expect(normalizePaymentToken("USDC", "mainnet-beta")).toBe(
      WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address
    );
    expect(normalizePaymentToken("USDC", "devnet")).toBe(
      WELL_KNOWN_TOKENS.USDC.mints.devnet.address
    );
  });

  it("refuses a symbol with no mint on the given cluster with a 400", () => {
    expect(() => normalizePaymentToken("USDT", "devnet")).toThrow(
      expect.objectContaining({
        code: "BAD_REQUEST",
        statusCode: 400,
        message: "USDT is not available on devnet",
      })
    );
  });
});
