import { FreezeApiResponse, MintApiResponse, UnfreezeApiResponse, TokenApiResponse } from "../helpers/api-types";
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

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Freeze/Unfreeze Operations", () => {
  let apiKeyHash: string;
  let custodyAddress = "";
  let deployedTokenId = "";
  let tokenAccount = "";
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
        name: "Freeze Test Token",
        symbol: "FREEZE",
        decimals: 9,
        isMintable: true,
        isFreezable: true,
      }),
    });

    const created = (await createRes.json()) as TokenApiResponse;
    deployedTokenId = created.data.token.id;

    await request(`/v1/issuance/tokens/${deployedTokenId}/deploy`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
    });

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

    const minted = (await mintRes.json()) as MintApiResponse;
    tokenAccount = minted.data.tokenAccount;
  }, 90000);

  it(
    "freezes a token account",
    { timeout: 60000 },
    async () => {
      const freezeRes = await request(`/v1/issuance/tokens/${deployedTokenId}/freeze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
        },
        body: JSON.stringify({
          accountAddress: tokenAccount,
          reason: "Integration test freeze",
        }),
      });

      expect(freezeRes.status).toBe(201);
      const frozen = (await freezeRes.json()) as FreezeApiResponse;

      expect(frozen.data.frozenAccount.id).toMatch(/^frz_/);
      expect(frozen.data.frozenAccount.accountAddress).toBe(tokenAccount);
      expect(frozen.data.frozenAccount.reason).toBe("Integration test freeze");
    }
  );

  it(
    "unfreezes a frozen account",
    { timeout: 90000 },
    async () => {
      await request(`/v1/issuance/tokens/${deployedTokenId}/freeze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
        },
        body: JSON.stringify({
          accountAddress: tokenAccount,
        }),
      });

      const unfreezeRes = await request(`/v1/issuance/tokens/${deployedTokenId}/unfreeze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
        },
        body: JSON.stringify({
          accountAddress: tokenAccount,
        }),
      });

      expect(unfreezeRes.status).toBe(200);
      const unfrozen = (await unfreezeRes.json()) as UnfreezeApiResponse;

      expect(unfrozen.data.frozenAccount.unfrozenAt).toBeTruthy();
    }
  );
});
