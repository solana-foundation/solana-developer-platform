import { MintApiResponse, MintPrepareApiResponse, TokenApiResponse } from "../helpers/api-types";
import {
  RUN_INTEGRATION_TESTS,
  SOLANA_CONFIGURED,
  TEST_PROJECT_API_KEY,
  app,
  env,
  cleanupIntegrationSuite,
  initIntegrationSuite,
  resetIntegrationState,
} from "../helpers/integration";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Mint Operations", () => {
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
        name: "Mint Test Token",
        symbol: "MINT",
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
  }, 60000);

  it(
    "mints tokens to destination (execute mode)",
    { timeout: 60000 },
    async () => {
      const mintRes = await request(`/v1/issuance/tokens/${deployedTokenId}/mint`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
        },
        body: JSON.stringify({
          mint: {
            destination: custodyAddress,
            amount: "1000000000",
          },
        }),
      });

      expect(mintRes.status).toBe(200);
      const minted = (await mintRes.json()) as MintApiResponse;

      expect(minted.data.transaction.status).toBe("confirmed");
      expect(minted.data.transaction.signature).toBeTruthy();
      expect(minted.data.tokenAccount).toBeTruthy();

      console.log(`Mint signature: ${minted.data.transaction.signature}`);

      const tokenRes = await request(`/v1/issuance/tokens/${deployedTokenId}`, {
        headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
      });

      const token = (await tokenRes.json()) as TokenApiResponse;
      expect(token.data.token.totalSupply).toBe("1000000000");
    }
  );

  it(
    "prepares mint transaction (prepare mode)",
    { timeout: 30000 },
    async () => {
      const prepareRes = await request(`/v1/issuance/tokens/${deployedTokenId}/mint/prepare`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
        },
        body: JSON.stringify({
          mint: {
            destination: custodyAddress,
            amount: "500000000",
          },
          options: { simulate: true },
        }),
      });

      expect(prepareRes.status).toBe(200);
      const prepared = (await prepareRes.json()) as MintPrepareApiResponse;

      expect(prepared.data.preparedTransaction.serialized).toBeTruthy();
      expect(prepared.data.preparedTransaction.blockhash).toBeTruthy();
      expect(prepared.data.tokenAccount).toBeTruthy();
      expect(prepared.data.simulation).toBeDefined();
    }
  );
});
