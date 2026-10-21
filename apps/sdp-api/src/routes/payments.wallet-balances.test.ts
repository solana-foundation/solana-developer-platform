import { beforeEach, describe, expect, it } from "vitest";
import { app } from "@/index";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  installClusterRpcResponder,
  systemAccountInfoResult,
  tokenAccountsByOwnerResult,
} from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { seedConnectionOwnedDuplicateProviderWallet } from "@/test/helpers/payments-transfers";

const readBalances = (walletId: string) =>
  app.request(
    `/v1/payments/wallets/${walletId}/balances`,
    { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
    env
  );

describe("Payments wallet balance identity", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcResponder();

  beforeEach(() => {
    rpc.answer("getAccountInfo", systemAccountInfoResult(1, 4_200_000_000));
    rpc.answer("getTokenAccountsByOwner", tokenAccountsByOwnerResult(1, []));
  });

  it("reads the exact SDP wallet and returns its internal ID", async () => {
    const response = await readBalances(TEST_CUSTODY_WALLET_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        walletBalances: {
          custodyWalletId: TEST_CUSTODY_WALLET_ID,
          walletId: TEST_WALLET_ID,
        },
      },
    });
  });

  it("rejects a provider wallet reference", async () => {
    const response = await readBalances(TEST_WALLET_ID);
    expect(response.status).toBe(404);
    expect(rpc.calls).toEqual([]);
  });

  it("reads Config and Connection wallets with the same provider reference by their own IDs", async () => {
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
    expect((await readBalances(TEST_WALLET_ID)).status).toBe(404);
  });
});
