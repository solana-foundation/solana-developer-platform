import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BurnApiResponse, TokenApiResponse } from "../helpers/api-types";
import {
  RUN_INTEGRATION_TESTS,
  SOLANA_CONFIGURED,
  TEST_PROJECT_API_KEY,
  app,
  cleanupIntegrationSuite,
  env,
  initIntegrationSuite,
  resetIntegrationState,
} from "../helpers/integration";

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Burn Operations", () => {
  let apiKeyHash: string;
  let custodyAddress = "";
  let deployedTokenId = "";
  const request = (url: string, init?: RequestInit) => app.request(url, init, env);

  beforeAll(async () => {
    const init = await initIntegrationSuite();
    apiKeyHash = init.apiKeyHash;
    custodyAddress = init.custodyAddress;
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  beforeEach(async () => {
    await resetIntegrationState(apiKeyHash);

    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
      },
      body: JSON.stringify({
        name: "Burn Test Token",
        symbol: "BURN",
        decimals: 9,
        isMintable: true,
      }),
    });

    const created = (await createRes.json()) as TokenApiResponse;
    deployedTokenId = created.data.token.id;

    await request(`/v1/issuance/tokens/${deployedTokenId}/deploy`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
    });

    await request(`/v1/issuance/tokens/${deployedTokenId}/mint`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
      },
      body: JSON.stringify({
        mint: {
          destination: custodyAddress,
          amount: "5000000000",
        },
      }),
    });
  }, 90000);

  it("burns tokens from account", { timeout: 60000 }, async () => {
    const burnRes = await request(`/v1/issuance/tokens/${deployedTokenId}/burn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
      },
      body: JSON.stringify({
        burn: {
          source: custodyAddress,
          amount: "1000000000",
        },
      }),
    });

    expect(burnRes.status).toBe(200);
    const burned = (await burnRes.json()) as BurnApiResponse;

    expect(burned.data.transaction.status).toBe("confirmed");
    expect(burned.data.transaction.signature).toBeTruthy();

    console.log(`Burn signature: ${burned.data.transaction.signature}`);

    const tokenRes = await request(`/v1/issuance/tokens/${deployedTokenId}`, {
      headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
    });

    const token = (await tokenRes.json()) as TokenApiResponse;
    expect(token.data.token.totalSupply).toBe("4000000000");
  });
});
