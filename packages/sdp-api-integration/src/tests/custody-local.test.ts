import { apiTestSupport } from "@sdp/api/test-support";
import type { CustodyConfigsResponse } from "@sdp/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TokenApiResponse } from "../helpers/api-types";
import {
  cleanupIntegrationSuite,
  env,
  INTEGRATION_CUSTODY_PROVIDER,
  type IntegrationCustodyWallet,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  request as rawRequest,
  requestWithApiKey,
  resetIntegrationState,
  SOLANA_CONFIGURED,
} from "../helpers/integration";

const { getDb } = apiTestSupport;

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
    const configsBody = (await configsRes.json()) as { data: CustodyConfigsResponse };
    const providerConfigs = configsBody.data.configs.filter(
      (config) => config.provider === INTEGRATION_CUSTODY_PROVIDER
    );
    expect(providerConfigs).toHaveLength(1);
    expect(custodyWallet.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

    const configRow = await getDb(env)
      .prepare("SELECT config_encrypted FROM custody_configs WHERE id = ?")
      .bind(providerConfigs[0].id)
      .first<{ config_encrypted: string }>();

    expect(configRow?.config_encrypted).toBeTruthy();
    expect(() => JSON.parse(configRow?.config_encrypted ?? "")).toThrow();

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
    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;

    const deployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signingCustodyWalletId: custodyWallet.id }),
    });

    expect(deployRes.status).toBe(200);
    const deployed = (await deployRes.json()) as TokenApiResponse;
    expect(deployed.data.token.mintAuthority).toBe(custodyWallet.address);
  });

  it("requires auth for custody endpoints", async () => {
    const configsRes = await rawRequest("/v1/wallets/configs");
    expect(configsRes.status).toBe(401);

    const initRes = await rawRequest("/v1/wallets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: INTEGRATION_CUSTODY_PROVIDER }),
    });
    expect(initRes.status).toBe(401);
  });
});
