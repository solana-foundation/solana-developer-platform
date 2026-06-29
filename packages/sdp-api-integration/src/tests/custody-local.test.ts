import { getDb } from "@sdp/api/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TokenApiResponse } from "../helpers/api-types";
import {
  cleanupIntegrationSuite,
  env,
  INTEGRATION_CUSTODY_PROVIDER,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  request as rawRequest,
  requestWithApiKey,
  resetIntegrationState,
  SOLANA_CONFIGURED,
} from "../helpers/integration";

const describeIfIntegrationConfigured = describe.skipIf(
  !SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS
);

describeIfIntegrationConfigured("Custody Access and Default Signing", () => {
  let apiKeyHash: string;
  const request = requestWithApiKey();

  beforeAll(async () => {
    const init = await initIntegrationSuite();
    apiKeyHash = init.apiKeyHash;
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  beforeEach(async () => {
    await resetIntegrationState(apiKeyHash);
  });

  it("uses the configured default signer for deployments", { timeout: 120000 }, async () => {
    const configRes = await request("/v1/wallets/config");

    expect(configRes.status).toBe(200);
    const configBody = (await configRes.json()) as {
      data: { config: { id: string; provider: string; publicKey: string } };
    };

    const { id: configId, provider, publicKey } = configBody.data.config;
    expect(provider).toBe(INTEGRATION_CUSTODY_PROVIDER);
    expect(publicKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

    const configRow = await getDb(env)
      .prepare("SELECT config_encrypted FROM custody_configs WHERE id = ?")
      .bind(configId)
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
    });

    expect(deployRes.status).toBe(200);
    const deployed = (await deployRes.json()) as TokenApiResponse;
    expect(deployed.data.token.mintAuthority).toBe(publicKey);
  });

  it("requires auth for custody endpoints", async () => {
    const configRes = await rawRequest("/v1/wallets/config");
    expect(configRes.status).toBe(401);

    const initRes = await rawRequest("/v1/wallets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: INTEGRATION_CUSTODY_PROVIDER }),
    });
    expect(initRes.status).toBe(401);
  });
});
