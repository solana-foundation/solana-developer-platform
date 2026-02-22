import { createSignableMessage } from "@solana/signers";
import { config } from "dotenv";
import { describe, expect, it } from "vitest";
import { CoinbaseCdpSigner } from "../coinbase-cdp-signer.js";
import { getConfig, hasRequiredEnvVars } from "./setup.js";

config();

describe("CDP signer integration", () => {
  it.skipIf(!hasRequiredEnvVars())("signs messages with real API", async () => {
    const signer = await CoinbaseCdpSigner.create(getConfig());
    const [signatureDictionary] = await signer.signMessages([
      createSignableMessage("sdp-cdp-smoke-test"),
    ]);
    expect(Object.keys(signatureDictionary)).toContain(signer.address);
    expect(await signer.isAvailable()).toBe(true);
  });

  it.skip("signs transactions with real API (covered in downstream SDP integration tests)", () => {
    expect(true).toBe(true);
  });
});
