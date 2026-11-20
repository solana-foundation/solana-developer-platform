import { apiTestSupport } from "@sdp/api/test-support";
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  cleanupIntegrationSuite,
  INTEGRATION_CUSTODY_PROVIDER,
  type IntegrationCustodyWallet,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestWithApiKey,
  resetIntegrationState,
  SOLANA_CONFIGURED,
} from "#/helpers/integration";
import { env } from "#env-impl";

const { getDb } = apiTestSupport;

const configsResponseSchema = z.object({
  data: z.object({ configs: z.array(z.object({ id: z.string(), provider: z.string() })) }),
});
const createdTokenResponseSchema = z.object({
  data: z.object({ token: z.object({ id: z.string() }) }),
});
const deployedTokenResponseSchema = z.object({
  data: z.object({ token: z.object({ mintAuthority: z.string() }) }),
});

const describeIfIntegrationConfigured = describe.skipIf(
  !SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS
);

describeIfIntegrationConfigured("Custody Access and Explicit Signing", () => {
  let apiKeyHash: string;
  let custodyWallet: IntegrationCustodyWallet;
  const request = requestWithApiKey();

  beforeAll(async () => {
    const init = await initIntegrationSuite();
    apiKeyHash = init.apiKeyHash;
    custodyWallet = init.custodyWallet;
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  beforeEach(async () => {
    const state = await resetIntegrationState(apiKeyHash);
    custodyWallet = state.custodyWallet;
  });

  it("deploys with the named custody wallet", { timeout: 120000 }, async () => {
    const configsRes = await request("/v1/wallets/configs");

    expect(configsRes.status).toBe(200);
    const configsBody = configsResponseSchema.parse(await configsRes.json());
    const providerConfigs = configsBody.data.configs.filter(
      (config) => config.provider === INTEGRATION_CUSTODY_PROVIDER
    );
    expect(providerConfigs).toHaveLength(1);
    const [providerConfig] = providerConfigs;
    assert(providerConfig, "the integration provider's config must be listed");

    const configRow = await getDb(env)
      .prepare("SELECT config_encrypted FROM custody_configs WHERE id = ?")
      .bind(providerConfig.id)
      .first<{ config_encrypted: string }>();
    assert(configRow, "the listed config must have a row");

    // Stored encrypted, never as the plaintext provider config.
    expect(() => JSON.parse(configRow.config_encrypted)).toThrow();

    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Custody Token",
        symbol: "CUST",
        signingCustodyWalletId: custodyWallet.id,
        decimals: 6,
        isMintable: true,
        isFreezable: true,
      }),
    });

    expect(createRes.status).toBe(201);
    const created = createdTokenResponseSchema.parse(await createRes.json());
    const tokenId = created.data.token.id;

    const deployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signingCustodyWalletId: custodyWallet.id }),
    });

    expect(deployRes.status).toBe(200);
    const deployed = deployedTokenResponseSchema.parse(await deployRes.json());
    expect(deployed.data.token.mintAuthority).toBe(custodyWallet.address);
  });
});
