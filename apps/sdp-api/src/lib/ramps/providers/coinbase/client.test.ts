import { SdpPaymentsError } from "@sdp/payments";
import { CoinbaseRampClient } from "@sdp/payments/ramps/providers/coinbase/client";
import { describe, expect, it } from "vitest";

describe("CoinbaseRampClient", () => {
  it("fails loudly at the unwired JIT seam when quote identity fields are absent", async () => {
    const request = new CoinbaseRampClient().createOnrampQuote(
      { env: {}, mode: "sandbox" },
      {
        cryptoToken: "USDC",
        fiatCurrency: "USD",
        fiatAmount: "100",
        destinationWalletAddress: "wallet_123",
        externalCustomerId: "counterparty_123",
      }
    );

    await expect(request).rejects.toThrowError(SdpPaymentsError);
    await expect(request).rejects.toThrowError(
      "Coinbase onramp requires identity fields that are no longer stored; JIT collection is not wired yet"
    );
  });
});
