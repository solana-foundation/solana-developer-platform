import { TEST_PROJECT } from "@sdp/api-test/fixtures/tokens";
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

type WalletListResponse = {
  data: {
    wallets: Array<{
      walletId: string;
      publicKey: string;
      provider?: string;
    }>;
  };
};

type CreateApiKeyResponse = {
  data: {
    apiKey: {
      id: string;
      key: string;
      name: string;
    };
  };
};

type TransferApiResponse = {
  data: {
    transfer: {
      id: string;
      status: string;
      signature: string | null;
    };
  };
};

// biome-ignore lint/security/noSecrets: Test Solana address, not a secret.
const DESTINATION_WALLET = "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ";

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("API Key Integration Flow", () => {
  let apiKeyHash: string;
  let custodyAddress = "";
  const adminRequest = requestWithApiKey();

  beforeAll(async () => {
    const init = await initIntegrationSuite();
    apiKeyHash = init.apiKeyHash;
    custodyAddress = init.custodyAddress;
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  beforeEach(async () => {
    const state = await resetIntegrationState(apiKeyHash);
    custodyAddress = state.custodyAddress;
  });

  it("onboarded actor creates a key and uses it to issue, mint, and transfer", {
    timeout: 240000,
  }, async () => {
    // biome-ignore lint/security/noSecrets: Internal API route test path, not a secret.
    const walletsRes = await adminRequest("/v1/wallets?includeAllProviders=true");
    expect(walletsRes.status).toBe(200);
    const walletsBody = (await walletsRes.json()) as WalletListResponse;

    const sourceWallet =
      walletsBody.data.wallets.find((wallet) => wallet.publicKey === custodyAddress) ??
      walletsBody.data.wallets[0];

    if (!sourceWallet) {
      throw new Error("Expected at least one active custody wallet for integration flow");
    }

    const createKeyRes = await adminRequest(`/v1/projects/${TEST_PROJECT.id}/api-keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `PRO-966 key ${Date.now()}`,
        permissions: [
          "tokens:read",
          "tokens:write",
          "payments:read",
          "payments:write",
          "wallets:read",
        ],
        walletScope: "selected",
        signingWalletId: sourceWallet.walletId,
      }),
    });

    expect(createKeyRes.status).toBe(201);
    const createdKey = (await createKeyRes.json()) as CreateApiKeyResponse;
    const scopedRequest = requestWithApiKey(createdKey.data.apiKey.key);

    const createTokenRes = await scopedRequest("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "API Key Flow Token",
        symbol: "AKFT",
        decimals: 6,
        isMintable: true,
      }),
    });

    expect(createTokenRes.status).toBe(201);
    const createdToken = (await createTokenRes.json()) as TokenApiResponse;
    const tokenId = createdToken.data.token.id;

    const deployRes = await scopedRequest(`/v1/issuance/tokens/${tokenId}/deploy`, {
      method: "POST",
    });

    expect(deployRes.status).toBe(200);
    const deployedToken = (await deployRes.json()) as TokenApiResponse;
    const mintAddress = deployedToken.data.token.mintAddress;

    if (!mintAddress) {
      throw new Error("Expected deployed token to include mintAddress");
    }

    const mintRes = await scopedRequest(`/v1/issuance/tokens/${tokenId}/mint`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mint: {
          destination: sourceWallet.publicKey,
          amount: "5",
        },
      }),
    });

    expect(mintRes.status).toBe(200);
    const minted = (await mintRes.json()) as MintApiResponse;
    expect(minted.data.transaction.status).toBe("confirmed");
    expect(minted.data.transaction.signature).toBeTruthy();

    const transferRes = await scopedRequest("/v1/payments/transfers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: sourceWallet.walletId,
        destination: DESTINATION_WALLET,
        token: mintAddress,
        amount: "1",
      }),
    });

    const transferPayload = await transferRes.text();
    if (transferRes.status !== 200) {
      throw new Error(`Expected transfer success, got ${transferRes.status}: ${transferPayload}`);
    }

    const transfer = JSON.parse(transferPayload) as TransferApiResponse;
    expect(transfer.data.transfer.status).toBe("confirmed");
    expect(transfer.data.transfer.signature).toBeTruthy();
  });
});
