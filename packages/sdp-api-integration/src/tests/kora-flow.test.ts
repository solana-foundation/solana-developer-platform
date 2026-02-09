import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  BurnApiResponse,
  FreezeApiResponse,
  MintApiResponse,
  TokenApiResponse,
  UnfreezeApiResponse,
} from "../helpers/api-types";
import {
  KORA_CONFIGURED,
  RUN_INTEGRATION_TESTS,
  SOLANA_CONFIGURED,
  cleanupIntegrationSuite,
  initIntegrationSuite,
  requestWithApiKey,
  resetIntegrationState,
} from "../helpers/integration";

describe.skipIf(!KORA_CONFIGURED || !SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)(
  "Kora Fee Payment (Devnet)",
  () => {
    let apiKeyHash: string;
    let custodyAddress = "";
    const request = requestWithApiKey();

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
    });

    it("deploys and manages a token using Kora fee payer", { timeout: 120000 }, async () => {
      const createRes = await request("/v1/issuance/tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Kora Devnet Token",
          symbol: "KORA",
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
      expect(deployed.data.token.mintAddress).toBeTruthy();

      const mintRes = await request(`/v1/issuance/tokens/${tokenId}/mint`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mint: {
            destination: custodyAddress,
            amount: "2",
          },
        }),
      });

      expect(mintRes.status).toBe(200);
      const minted = (await mintRes.json()) as MintApiResponse;
      expect(minted.data.transaction.status).toBe("confirmed");
      expect(minted.data.transaction.signature).toBeTruthy();

      const tokenAccount = minted.data.tokenAccount;
      expect(tokenAccount).toBeTruthy();

      const freezeRes = await request(`/v1/issuance/tokens/${tokenId}/freeze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ accountAddress: tokenAccount }),
      });

      expect(freezeRes.status).toBe(201);
      const frozen = (await freezeRes.json()) as FreezeApiResponse;
      expect(frozen.data.frozenAccount.accountAddress).toBe(tokenAccount);

      const unfreezeRes = await request(`/v1/issuance/tokens/${tokenId}/unfreeze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ accountAddress: tokenAccount }),
      });

      expect(unfreezeRes.status).toBe(200);
      const unfrozen = (await unfreezeRes.json()) as UnfreezeApiResponse;
      expect(unfrozen.data.frozenAccount.accountAddress).toBe(tokenAccount);

      const burnRes = await request(`/v1/issuance/tokens/${tokenId}/burn`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          burn: {
            source: tokenAccount,
            amount: "1",
          },
        }),
      });

      expect(burnRes.status).toBe(200);
      const burned = (await burnRes.json()) as BurnApiResponse;
      expect(burned.data.transaction.status).toBe("confirmed");
      expect(burned.data.transaction.signature).toBeTruthy();
    });
  }
);
