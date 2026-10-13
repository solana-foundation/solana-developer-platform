import { describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  getAccountInfoMock,
  getSplTokenBalancesMock,
  installPaymentsRouteTestHooks,
  seedCachedKey,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import {
  seedConnectionOwnedDuplicateProviderWallet,
  seedCustodyWalletFixture,
} from "@/test/helpers/payments-transfers";

const readBalances = (walletId: string) =>
  app.request(
    `/v1/payments/wallets/${walletId}/balances`,
    { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
    env
  );

describe("Payments wallet balance identity", () => {
  installPaymentsRouteTestHooks();

  it("reads the exact SDP wallet without exposing its provider wallet reference", async () => {
    const response = await app.request(
      `/v1/payments/wallets/${TEST_CUSTODY_WALLET_ID}/balances`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      data: {
        walletBalances: {
          custodyWalletId: TEST_CUSTODY_WALLET_ID,
          balances: expect.arrayContaining([
            expect.objectContaining({ token: "SOL", amount: "4200000000", uiAmount: "4.2" }),
          ]),
        },
      },
    });
    expect(body.data.walletBalances).not.toHaveProperty("walletId");
    expect(getAccountInfoMock).toHaveBeenCalledTimes(1);
    expect(getSplTokenBalancesMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a provider wallet reference before reading balances", async () => {
    const response = await readBalances(TEST_WALLET_ID);
    expect(response.status).toBe(404);
    expect(getAccountInfoMock).not.toHaveBeenCalled();
    expect(getSplTokenBalancesMock).not.toHaveBeenCalled();
  });

  it("uses the exact selected-key binding and rejects a wallet without read permission", async () => {
    await seedConnectionOwnedDuplicateProviderWallet();
    await seedCachedKey({
      walletScope: "selected",
      walletBindings: [
        {
          custodyWalletId: TEST_CUSTODY_WALLET_ID,
          walletId: TEST_WALLET_ID,
          permissions: ["wallets:read"],
        },
      ],
    });
    const exact = await readBalances(TEST_CUSTODY_WALLET_ID);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({
      data: { walletBalances: { custodyWalletId: TEST_CUSTODY_WALLET_ID } },
    });
    const forbidden = await readBalances("cwlt_payments_duplicate_test");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      error: { code: "FORBIDDEN", details: { reason: "api_key_wallet_access_denied" } },
    });
    await seedCachedKey({
      walletScope: "selected",
      walletBindings: [
        {
          custodyWalletId: TEST_CUSTODY_WALLET_ID,
          walletId: TEST_WALLET_ID,
          permissions: ["payments:write"],
        },
      ],
    });
    expect((await readBalances(TEST_CUSTODY_WALLET_ID)).status).toBe(403);
    expect(getAccountInfoMock).toHaveBeenCalledTimes(1);
    expect(getSplTokenBalancesMock).toHaveBeenCalledTimes(1);
  });

  it("reads distinct Config and Connection exact IDs while rejecting their ambiguous Provider ID", async () => {
    await seedConnectionOwnedDuplicateProviderWallet();
    for (const [id, address] of [
      [TEST_CUSTODY_WALLET_ID, TEST_SOLANA_ADDRESSES.wallet1],
      ["cwlt_payments_duplicate_test", TEST_SOLANA_ADDRESSES.wallet3],
    ]) {
      const response = await readBalances(id);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { walletBalances: { custodyWalletId: id, address } },
      });
    }
    expect((await readBalances(TEST_WALLET_ID)).status).toBe(404);
    expect(getAccountInfoMock).toHaveBeenCalledTimes(2);
    expect(getSplTokenBalancesMock).toHaveBeenCalledTimes(2);
  });

  it("reads only the exact wallet when its ID is another wallet's provider reference", async () => {
    await seedCustodyWalletFixture({
      id: "cwlt_balance_collision",
      walletId: TEST_CUSTODY_WALLET_ID,
      publicKey: TEST_SOLANA_ADDRESSES.wallet2,
      label: "Namespace collision",
    });
    const response = await readBalances(TEST_CUSTODY_WALLET_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        walletBalances: {
          custodyWalletId: TEST_CUSTODY_WALLET_ID,
          address: TEST_SOLANA_ADDRESSES.wallet1,
        },
      },
    });
    expect(getAccountInfoMock).toHaveBeenCalledTimes(1);
    expect(getSplTokenBalancesMock).toHaveBeenCalledTimes(1);
  });

  it("does not reinterpret an inactive exact ID as another wallet's Provider ID", async () => {
    await seedCustodyWalletFixture({
      id: "cwlt_balance_collision",
      walletId: TEST_CUSTODY_WALLET_ID,
      publicKey: TEST_SOLANA_ADDRESSES.wallet2,
      label: "Namespace collision",
    });
    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind(TEST_CUSTODY_WALLET_ID)
      .run();
    expect((await readBalances(TEST_CUSTODY_WALLET_ID)).status).toBe(404);
    expect(getAccountInfoMock).not.toHaveBeenCalled();
    expect(getSplTokenBalancesMock).not.toHaveBeenCalled();
  });

  it("does not reinterpret an unknown internal namespace selector as a Provider ID", async () => {
    await seedCustodyWalletFixture({
      id: "cwlt_balance_unknown_alias",
      walletId: "cwlt_missing",
      publicKey: TEST_SOLANA_ADDRESSES.wallet2,
      label: "Unknown alias",
    });
    expect((await readBalances("cwlt_missing")).status).toBe(404);
    expect(getAccountInfoMock).not.toHaveBeenCalled();
    expect(getSplTokenBalancesMock).not.toHaveBeenCalled();
  });
});
