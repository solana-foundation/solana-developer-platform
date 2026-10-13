import { runInClusterScope } from "@sdp/rpc/scope";
import { WELL_KNOWN_TOKENS } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { normalizePaymentToken } from "@/services/payment-operation.service";

describe("normalizePaymentToken", () => {
  it("maps USDC to the mint of the open scope's cluster", () => {
    expect(
      runInClusterScope({ projectId: null, environment: "production" }, () =>
        normalizePaymentToken("USDC")
      )
    ).toBe(WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address);
    expect(
      runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
        normalizePaymentToken("USDC")
      )
    ).toBe(WELL_KNOWN_TOKENS.USDC.mints.devnet.address);
  });

  it("refuses a symbol with no mint on the open scope's cluster with a 400", () => {
    expect(() =>
      runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
        normalizePaymentToken("USDT")
      )
    ).toThrow(
      expect.objectContaining({
        code: "BAD_REQUEST",
        statusCode: 400,
        message: "USDT is not available on devnet",
      })
    );
  });
});
