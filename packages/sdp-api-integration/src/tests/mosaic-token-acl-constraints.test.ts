import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MintApiResponse, TokenApiResponse } from "../helpers/api-types";
import {
  cleanupIntegrationSuite,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestWithApiKey,
  resetIntegrationState,
  SOLANA_CONFIGURED,
} from "../helpers/integration";

const TEST_WALLET = "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ";

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)(
  "Mosaic Token ACL constraints",
  () => {
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

    it("rejects freeze for non-freezable token", { timeout: 90000 }, async () => {
      const createRes = await request("/v1/issuance/tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Non-Freezable Token",
          symbol: "NFT",
          decimals: 6,
          template: "custom",
          isMintable: true,
          isFreezable: false,
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
      expect(deployed.data.token.freezeAuthority).toBeNull();

      const mintRes = await request(`/v1/issuance/tokens/${tokenId}/mint`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mint: {
            destination: TEST_WALLET,
            amount: "1",
          },
        }),
      });
      expect(mintRes.status).toBe(200);

      const mintResult = (await mintRes.json()) as MintApiResponse;
      expect(mintResult.data.tokenAccount).toBeTruthy();

      const freezeRes = await request(`/v1/issuance/tokens/${tokenId}/freeze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          accountAddress: mintResult.data.tokenAccount,
          reason: "Should fail",
        }),
      });

      expect(freezeRes.status).toBe(400);
      const error = (await freezeRes.json()) as { error: { code: string; message: string } };
      expect(error.error.message).toContain("freeze");
    });
  }
);
