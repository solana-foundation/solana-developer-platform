import { createOrgSigner } from "@sdp/api/services/solana";
import type { Env } from "@sdp/api/types/env";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupIntegrationSuite,
  createToken2022Service,
  env,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  resetIntegrationState,
  SOLANA_CONFIGURED,
  TEST_ORG,
  TEST_PROJECT,
} from "../helpers/integration";

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Token2022Service Direct", () => {
  let apiKeyHash: string;

  beforeAll(async () => {
    const init = await initIntegrationSuite();
    apiKeyHash = init.apiKeyHash;
  });

  beforeEach(async () => {
    await resetIntegrationState(apiKeyHash);
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  it("creates mint using service directly", { timeout: 60000 }, async () => {
    const signer = await createOrgSigner(env as Env, TEST_ORG.id, TEST_PROJECT.id);
    const token2022 = createToken2022Service(env as Env, signer);

    const result = await token2022.createMint({
      metadata: {
        name: "Token2022 Direct",
        symbol: "T2022",
        uri: "https://example.com/token2022.json",
      },
      decimals: 6,
      mintAuthority: signer,
      freezeAuthority: signer.address,
    });

    expect(result.mint).toBeTruthy();
    expect(result.signature).toBeTruthy();
    expect(result.slot).toBeGreaterThan(0n);

    console.log(`Direct service mint: ${result.mint}`);
    console.log(`Signature: ${result.signature}`);
  });
});
