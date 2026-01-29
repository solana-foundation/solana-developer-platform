import type { Env } from "@sdp/api/types/env";
import { describe, expect, it } from "vitest";
import {
  RUN_INTEGRATION_TESTS,
  SOLANA_CONFIGURED,
  Token2022Service,
  createSigner,
  env,
} from "../helpers/integration";

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Token2022Service Direct", () => {
  it("creates mint using service directly", { timeout: 60000 }, async () => {
    const token2022 = new Token2022Service(env as Env);
    const signer = await createSigner(env as Env);

    const result = await token2022.createMint({
      decimals: 6,
      mintAuthority: signer.address,
      freezeAuthority: signer.address,
    });

    expect(result.mint).toBeTruthy();
    expect(result.signature).toBeTruthy();
    expect(result.slot).toBeGreaterThan(0n);

    console.log(`Direct service mint: ${result.mint}`);
    console.log(`Signature: ${result.signature}`);
  });
});
