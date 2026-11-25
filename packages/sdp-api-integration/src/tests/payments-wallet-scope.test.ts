import { API_KEY_GRANTABLE_ACTIONS } from "@sdp/types/actions";
import { PAYMENT_TRANSFER_STATUSES } from "@sdp/types/payments";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
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

const createApiKeyResponseSchema = z.object({
  data: z.object({ apiKey: z.object({ id: z.string(), key: z.string() }) }),
});

const transferResponseSchema = z.object({
  data: z.object({
    transfer: z.object({
      id: z.string(),
      status: z.enum(PAYMENT_TRANSFER_STATUSES),
      signature: z.string().nullable(),
    }),
  }),
});

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

  // HOO-2099: a selected key signs only with the custody wallets it lists; its
  // transfer reads cover the whole project, its wallet list only those wallets.
  it("signs only with the key's listed wallets, reads every project transfer, and lists only its wallets", {
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
    const createdKey = createApiKeyResponseSchema.parse(await createKeyRes.json());
    const scopedRequest = requestWithApiKey(createdKey.data.apiKey.key);
    const transferFrom = (request: typeof scopedRequest, sourceCustodyWalletId: string) =>
      request("/v1/payments/transfers/execute", {
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
    const transferA = transferResponseSchema.parse(await transferARes.json());
    expect(transferA.data.transfer.signature).not.toBeNull();

    const refusedRes = await transferFrom(scopedRequest, walletB.id);
    expect(refusedRes.status).toBe(403);
    expect(await refusedRes.json()).toMatchObject({
      error: { code: "FORBIDDEN", details: { reason: "wallet_out_of_scope" } },
    });

    const transferBRes = await transferFrom(adminRequest, walletB.id);
    expect(transferBRes.status).toBe(200);
    const transferB = transferResponseSchema.parse(await transferBRes.json());

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
    expect(await transferBGetRes.json()).toMatchObject({
      data: { transfer: { id: transferB.data.transfer.id } },
    });

    const walletsRes = await scopedRequest("/v1/wallets?view=summary");
    expect(walletsRes.status).toBe(200);
    expect(await walletsRes.json()).toMatchObject({ data: { wallets: [{ id: walletA.id }] } });
  });
});
