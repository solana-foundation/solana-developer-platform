import { API_KEY_GRANTABLE_ACTIONS } from "@sdp/types/actions";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupIntegrationSuite,
  createFundedIntegrationWallet,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestAsOrganizationAdmin,
  requestWithApiKey,
  resetIntegrationState,
  SOLANA_CONFIGURED,
} from "#/helpers/integration";

type CreateApiKeyResponse = {
  data: {
    apiKey: {
      id: string;
      key: string;
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

const DESTINATION_A = "6A8j8oy5x8VYKJ9x1L88M3BM3uY7v8nqM6jLi4Y8qfvt";
const DESTINATION_B = "7pL4J6N9d77qiy5iqfJ5z4T1mSx1FSa7o2r1K5vY7P4m";

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Payments Wallet Scope", () => {
  let apiKeyHash: string;
  const adminRequest = requestWithApiKey();
  // Keys are created by a signed-in organization admin, never a key (HOO-2099).
  let keyManager: Awaited<ReturnType<typeof requestAsOrganizationAdmin>>;

  beforeAll(async () => {
    const init = await initIntegrationSuite();
    apiKeyHash = init.apiKeyHash;
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  beforeEach(async () => {
    await resetIntegrationState(apiKeyHash);
    keyManager = await requestAsOrganizationAdmin();
  });

  // HOO-2099: a selected key signs only with the custody wallets it lists,
  // decided at the custody signer; its reads cover the whole project.
  it("signs only with the key's listed wallets, and reads the whole project", {
    timeout: 240000,
  }, async () => {
    const walletA = await createFundedIntegrationWallet({
      label: "Wallet A",
      fundLamports: 12_000_000,
    });
    const walletB = await createFundedIntegrationWallet({
      label: "Wallet B",
      fundLamports: 12_000_000,
    });

    const createKeyRes = await keyManager("/v1/api-keys", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `Wallet scope key ${Date.now()}`,
        grants: [...API_KEY_GRANTABLE_ACTIONS],
        walletScope: "selected",
        walletIds: [walletA.id],
      }),
    });

    expect(createKeyRes.status).toBe(201);
    const createdKey = (await createKeyRes.json()) as CreateApiKeyResponse;
    const scopedRequest = requestWithApiKey(createdKey.data.apiKey.key);
    const transferFrom = (request: typeof scopedRequest, sourceCustodyWalletId: string) =>
      request("/v1/payments/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceCustodyWalletId,
          destination: sourceCustodyWalletId === walletA.id ? DESTINATION_A : DESTINATION_B,
          token: "SOL",
          amount: "0.001",
        }),
      });

    const transferARes = await transferFrom(scopedRequest, walletA.id);
    expect(transferARes.status).toBe(200);
    const transferA = (await transferARes.json()) as TransferApiResponse;
    expect(transferA.data.transfer.signature).not.toBeNull();

    const refusedRes = await transferFrom(scopedRequest, walletB.id);
    expect(refusedRes.status).toBe(403);
    expect(await refusedRes.json()).toMatchObject({
      error: { code: "FORBIDDEN", details: { reason: "wallet_out_of_scope" } },
    });

    const transferBRes = await transferFrom(adminRequest, walletB.id);
    expect(transferBRes.status).toBe(200);
    const transferB = (await transferBRes.json()) as TransferApiResponse;

    const listRes = await scopedRequest("/v1/payments/transfers?page=1&pageSize=20");
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ id: transferA.data.transfer.id }),
        expect.objectContaining({ id: transferB.data.transfer.id }),
      ]),
    });

    const transferBGetRes = await scopedRequest(
      `/v1/payments/transfers/${transferB.data.transfer.id}`
    );
    expect(transferBGetRes.status).toBe(200);

    const walletsRes = await scopedRequest("/v1/wallets?view=summary");
    expect(walletsRes.status).toBe(200);
    expect(await walletsRes.json()).toMatchObject({ data: { wallets: [{ id: walletA.id }] } });
  });
});
