import { TEST_PROJECT } from "@sdp/api-test/fixtures/tokens";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupIntegrationSuite,
  createFundedIntegrationWallet,
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

type RotateApiKeyResponse = {
  data: {
    apiKey: {
      id: string;
      key: string;
      name: string;
    };
    previousKey: {
      id: string;
      rotationDeadline: string;
    };
  };
};

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("API Key Rotation Lifecycle", () => {
  let apiKeyHash: string;
  const adminRequest = requestWithApiKey();

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

  it("rotates a selected-wallet key, preserves old-key access until revoke, then rejects it", {
    timeout: 240000,
  }, async () => {
    const wallet = await createFundedIntegrationWallet({
      label: "Rotation Wallet",
      fundLamports: 5_000_000,
    });

    const createKeyRes = await adminRequest(`/v1/projects/${TEST_PROJECT.id}/api-keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `Rotation key ${Date.now()}`,
        role: "api_admin",
        permissions: ["*"],
        walletScope: "selected",
        signingWalletId: wallet.walletId,
        signingWalletIds: [wallet.walletId],
      }),
    });

    expect(createKeyRes.status).toBe(201);
    const created = (await createKeyRes.json()) as CreateApiKeyResponse;
    const originalKey = created.data.apiKey;
    const originalKeyRequest = requestWithApiKey(originalKey.key);

    const originalWalletsRes = await originalKeyRequest("/v1/wallets?includeAllProviders=true");
    expect(originalWalletsRes.status).toBe(200);
    const originalWallets = (await originalWalletsRes.json()) as WalletListResponse;
    expect(originalWallets.data.wallets.some((entry) => entry.walletId === wallet.walletId)).toBe(
      true
    );

    const rotateRes = await adminRequest(`/v1/api-keys/${originalKey.id}/rotate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        gracePeriodHours: 24,
      }),
    });

    expect(rotateRes.status).toBe(201);
    const rotation = (await rotateRes.json()) as RotateApiKeyResponse;
    expect(rotation.data.previousKey.id).toBe(originalKey.id);
    expect(rotation.data.previousKey.rotationDeadline).toBeTruthy();

    const rotatedKeyRequest = requestWithApiKey(rotation.data.apiKey.key);
    const rotatedWalletsRes = await rotatedKeyRequest("/v1/wallets?includeAllProviders=true");
    expect(rotatedWalletsRes.status).toBe(200);

    const preRevokeOldKeyRes = await originalKeyRequest("/v1/wallets?includeAllProviders=true");
    expect(preRevokeOldKeyRes.status).toBe(200);

    const revokeRes = await adminRequest(`/v1/api-keys/${originalKey.id}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        confirmation: originalKey.name,
      }),
    });

    expect(revokeRes.status).toBe(200);

    const postRevokeOldKeyRes = await originalKeyRequest("/v1/wallets?includeAllProviders=true");
    expect(postRevokeOldKeyRes.status).toBe(401);
    const revokedBody = (await postRevokeOldKeyRes.json()) as { error: { code: string } };
    expect(revokedBody.error.code).toBe("REVOKED_API_KEY");
  });
});
