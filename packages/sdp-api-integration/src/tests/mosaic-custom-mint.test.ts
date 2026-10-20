import { type ApiTestEnv, apiTestSupport } from "@sdp/api/test-support";
import { resolveDefaultCluster } from "@sdp/rpc/config";
import { runInClusterScope } from "@sdp/rpc/scope";
import { SDP_ENVIRONMENT_BY_CLUSTER } from "@sdp/types/well-known-tokens";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  asOrganizationAdmin,
  cleanupIntegrationSuite,
  createMosaicService,
  type IntegrationCustodyWallet,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  resetIntegrationState,
  SOLANA_CONFIGURED,
  TEST_ORG,
  TEST_PROJECT,
} from "#/helpers/integration";
import { env } from "#env-impl";

const { createOrgSignerForCustodyWallet } = apiTestSupport;

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Mosaic custom mint", () => {
  let apiKeyHash: string;
  let custodyWallet: IntegrationCustodyWallet;

  beforeAll(async () => {
    const init = await initIntegrationSuite();
    apiKeyHash = init.apiKeyHash;
  });

  beforeEach(async () => {
    ({ custodyWallet } = await resetIntegrationState(apiKeyHash));
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  it("creates a custom mint through the sponsored Mosaic service", { timeout: 60000 }, async () => {
    const signer = await createOrgSignerForCustodyWallet(
      env as ApiTestEnv,
      TEST_ORG.id,
      TEST_PROJECT.id,
      custodyWallet.id,
      "issuance.authority"
    );
    const result = await runInClusterScope(
      {
        projectId: TEST_PROJECT.id,
        environment: SDP_ENVIRONMENT_BY_CLUSTER[resolveDefaultCluster(env)],
      },
      () => {
        const mosaic = createMosaicService(env as ApiTestEnv, signer, {
          mode: "sponsored",
          scope: {
            organizationId: TEST_ORG.id,
            projectId: TEST_PROJECT.id,
            actor: { type: "project", id: TEST_PROJECT.id },
          },
          movement: "issuance.authority",
        });
        return asOrganizationAdmin(() =>
          mosaic.createToken({
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
          })
        );
      }
    );

    expect(result.mint).toBeTruthy();
    expect(result.signature).toBeTruthy();
    expect(result.slot).toBeGreaterThan(0n);

    console.log(`Mosaic custom mint: ${result.mint}`);
    console.log(`Signature: ${result.signature}`);
  });
});
