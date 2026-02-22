import { describe, expect, it } from "vitest";
import { CoinbaseCdpSigner } from "../coinbase-cdp-signer.js";

describe("CDP signer", () => {
  it("fails create() when required config is missing", async () => {
    await expect(
      CoinbaseCdpSigner.create({
        apiKeyId: "",
        apiKeySecret: "",
        walletSecret: "",
        walletId: "",
      })
    ).rejects.toThrowError(/Missing required configuration fields/i);
  });
});
