import { cryptoRailMint } from "@sdp/types/payment-rails";
import { RAMP_PROVIDERS } from "@sdp/types/provider-access";
import { describe, expect, it } from "vitest";
import { offersSandboxSettlement, offrampPairs, onrampPairs } from "./ramps";

describe("ramp pairs", () => {
  it("offers no on-ramp pair on a rail the sandbox cluster has no mint for", () => {
    const rails = onrampPairs("sandbox", RAMP_PROVIDERS).map((pair) => pair.assetRail);

    expect(rails).toContain("usdc.solana");
    expect(rails).not.toContain("usdt.solana");
  });

  it("offers off-ramp pairs only on rails the sandbox cluster has a mint for", () => {
    for (const pair of offrampPairs("sandbox", RAMP_PROVIDERS)) {
      expect(cryptoRailMint(pair.assetRail, "devnet")).toBeDefined();
    }
  });
});

describe("offersSandboxSettlement", () => {
  it("offers a sandbox Hercle deposit the flags enable", () => {
    expect(offersSandboxSettlement("hercle", "sandbox", ["moonpay", "hercle"])).toBe(true);
  });

  it("never offers a production deposit, whose money is real", () => {
    expect(offersSandboxSettlement("hercle", "production", ["hercle"])).toBe(false);
  });

  it.each(["moonpay", "stripe"] as const)(
    "offers nothing for %s, which the API does not settle on request",
    (provider) => {
      expect(offersSandboxSettlement(provider, "sandbox", [provider])).toBe(false);
    }
  );

  it("offers nothing for a provider the release channel or its flag leaves out", () => {
    expect(offersSandboxSettlement("hercle", "sandbox", ["moonpay", "stripe"])).toBe(false);
  });
});
