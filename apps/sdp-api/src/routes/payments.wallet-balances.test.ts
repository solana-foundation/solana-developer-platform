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

  it("reads the exact SDP wallet and returns both compatible identities", async () => {
    const response = await app.request(
      `/v1/payments/wallets/${TEST_CUSTODY_WALLET_ID}/balances`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        walletBalances: {
          custodyWalletId: TEST_CUSTODY_WALLET_ID,
          walletId: TEST_WALLET_ID,
          balances: expect.arrayContaining([
            expect.objectContaining({ token: "SOL", amount: "4200000000", uiAmount: "4.2" }),
          ]),
        },
      },
    });
    expect(getAccountInfoMock).toHaveBeenCalledTimes(1);
    expect(getSplTokenBalancesMock).toHaveBeenCalledTimes(1);
  });

  it("keeps an unambiguous Provider ID compatible and returns its exact identity", async () => {
    const response = await readBalances(TEST_WALLET_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        walletBalances: { custodyWalletId: TEST_CUSTODY_WALLET_ID, walletId: TEST_WALLET_ID },
      },
    });
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
    expect((await readBalances("cwlt_payments_duplicate_test")).status).toBe(403);
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
        data: { walletBalances: { custodyWalletId: id, walletId: TEST_WALLET_ID, address } },
      });
    }
    expect((await readBalances(TEST_WALLET_ID)).status).toBe(409);
    expect(getAccountInfoMock).toHaveBeenCalledTimes(2);
    expect(getSplTokenBalancesMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a Provider ID collides with an active exact wallet ID", async () => {
    await seedCustodyWalletFixture({
      id: "cwlt_balance_collision",
      walletId: TEST_CUSTODY_WALLET_ID,
      publicKey: TEST_SOLANA_ADDRESSES.wallet2,
      label: "Namespace collision",
    });
    expect((await readBalances(TEST_CUSTODY_WALLET_ID)).status).toBe(409);
    expect(getAccountInfoMock).not.toHaveBeenCalled();
    expect(getSplTokenBalancesMock).not.toHaveBeenCalled();
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
