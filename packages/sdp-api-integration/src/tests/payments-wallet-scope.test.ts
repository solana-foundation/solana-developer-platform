import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupIntegrationSuite,
  createFundedPrivyWallet,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestWithApiKey,
  resetIntegrationState,
  SOLANA_CONFIGURED,
} from "../helpers/integration";

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

  it("limits transfer list/get access to the API key wallet bindings", {
    timeout: 240000,
  }, async () => {
    const walletA = await createFundedPrivyWallet({
      label: "Wallet A",
      fundLamports: 12_000_000,
    });
    const walletB = await createFundedPrivyWallet({
      label: "Wallet B",
      fundLamports: 12_000_000,
    });

    const createKeyRes = await adminRequest("/v1/api-keys", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `Wallet scope key ${Date.now()}`,
        role: "api_admin",
        environment: "sandbox",
        walletScope: "selected",
        signingWalletId: walletA.walletId,
        signingWalletIds: [walletA.walletId],
      }),
    });

    expect(createKeyRes.status).toBe(201);
    const createdKey = (await createKeyRes.json()) as CreateApiKeyResponse;
    const scopedRequest = requestWithApiKey(createdKey.data.apiKey.key);

    const transferARes = await adminRequest("/v1/payments/transfers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: walletA.walletId,
        destination: DESTINATION_A,
        token: "SOL",
        amount: "0.01",
      }),
    });
    expect(transferARes.status).toBe(200);
    const transferA = (await transferARes.json()) as TransferApiResponse;

    const transferBRes = await adminRequest("/v1/payments/transfers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: walletB.walletId,
        destination: DESTINATION_B,
        token: "SOL",
        amount: "0.01",
      }),
    });
    expect(transferBRes.status).toBe(200);
    const transferB = (await transferBRes.json()) as TransferApiResponse;

    const listRes = await scopedRequest("/v1/payments/transfers?page=1&pageSize=20");
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      data: Array<{ id: string }>;
    };
    expect(listed.data.some((transfer) => transfer.id === transferA.data.transfer.id)).toBe(true);
    expect(listed.data.some((transfer) => transfer.id === transferB.data.transfer.id)).toBe(false);

    const walletAListRes = await scopedRequest(
      `/v1/payments/transfers?wallet=${encodeURIComponent(walletA.walletId)}`
    );
    expect(walletAListRes.status).toBe(200);

    const walletBListRes = await scopedRequest(
      `/v1/payments/transfers?wallet=${encodeURIComponent(walletB.walletId)}`
    );
    expect(walletBListRes.status).toBe(403);
    const walletBListBody = (await walletBListRes.json()) as { error: { code: string } };
    expect(walletBListBody.error.code).toBe("FORBIDDEN");

    const transferAGetRes = await scopedRequest(
      `/v1/payments/transfers/${transferA.data.transfer.id}`
    );
    expect(transferAGetRes.status).toBe(200);

    const transferBGetRes = await scopedRequest(
      `/v1/payments/transfers/${transferB.data.transfer.id}`
    );
    expect(transferBGetRes.status).toBe(403);
    const transferBGetBody = (await transferBGetRes.json()) as { error: { code: string } };
    expect(transferBGetBody.error.code).toBe("FORBIDDEN");
  });
});
