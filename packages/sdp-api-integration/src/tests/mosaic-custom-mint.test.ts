import { type ApiTestEnv, apiTestSupport } from "@sdp/api/test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupIntegrationSuite,
  createMosaicService,
  env,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  resetIntegrationState,
  SOLANA_CONFIGURED,
  TEST_ORG,
  TEST_PROJECT,
} from "../helpers/integration";

const { createOrgSigner } = apiTestSupport;

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Mosaic custom mint", () => {
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

  it("creates a custom mint through the sponsored Mosaic service", { timeout: 60000 }, async () => {
    const signer = await createOrgSigner(env as ApiTestEnv, TEST_ORG.id, TEST_PROJECT.id);
    const mosaic = createMosaicService(env as ApiTestEnv, signer, "sponsored", {
      environment: TEST_PROJECT.environment,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      actor: { type: "project", id: TEST_PROJECT.id },
    });

    const result = await mosaic.createToken({
      template: "custom",
      feePayer: signer,
      metadata: {
        name: "Mosaic Custom Mint",
        symbol: "MCM",
        uri: "https://example.com/mosaic-custom-mint.json",
      },
      decimals: 6,
      mintAuthority: signer,
      freezeAuthority: signer.address,
    });

    expect(result.mint).toBeTruthy();
    expect(result.signature).toBeTruthy();
    expect(result.slot).toBeGreaterThan(0n);

    console.log(`Mosaic custom mint: ${result.mint}`);
    console.log(`Signature: ${result.signature}`);
  });
});
