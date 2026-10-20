import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
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
  const rpc = installClusterRpcResponder();

  beforeEach(() => {
    rpc.answer("getAccountInfo", systemAccountInfoResult(1, 4_200_000_000));
    rpc.answer("getTokenAccountsByOwner", tokenAccountsByOwnerResult(1, []));
  });

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
            expect.objectContaining({
              token: WELL_KNOWN_TOKENS.SOL.symbol,
              amount: "4200000000",
              uiAmount: "4.2",
            }),
          ]),
        },
      },
    });
    expect(rpc.calls.filter((call) => call.method === "getAccountInfo")).toHaveLength(1);
    expect(rpc.calls.filter((call) => call.method === "getTokenAccountsByOwner")).toHaveLength(2);
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

  it("checks the resolved internal ID against the selected signing-wallet list", async () => {
    await seedConnectionOwnedDuplicateProviderWallet();
    await seedCachedKey({
      walletScope: "selected",
      walletIds: [TEST_CUSTODY_WALLET_ID],
    });
    const exact = await readBalances(TEST_CUSTODY_WALLET_ID);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({
      data: { walletBalances: { custodyWalletId: TEST_CUSTODY_WALLET_ID } },
    });
    expect((await readBalances("cwlt_payments_duplicate_test")).status).toBe(404);
    expect((await readBalances(TEST_WALLET_ID)).status).toBe(409);
    expect(rpc.calls.filter((call) => call.method === "getAccountInfo")).toHaveLength(1);
    expect(rpc.calls.filter((call) => call.method === "getTokenAccountsByOwner")).toHaveLength(2);
  });

  it("refuses balance reads for an empty selected list or a missing action", async () => {
    await seedCachedKey({ walletScope: "selected", walletIds: [] });
    expect((await readBalances(TEST_CUSTODY_WALLET_ID)).status).toBe(404);
    expect((await readBalances(TEST_WALLET_ID)).status).toBe(404);

    await seedCachedKey({ grants: ["transfers.execute"] });
    expect((await readBalances(TEST_CUSTODY_WALLET_ID)).status).toBe(403);
    await seedCachedKey({ grants: [] });
    expect((await readBalances(TEST_CUSTODY_WALLET_ID)).status).toBe(403);
    expect(rpc.calls).toEqual([]);
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
    expect(rpc.calls.filter((call) => call.method === "getAccountInfo")).toHaveLength(2);
    expect(rpc.calls.filter((call) => call.method === "getTokenAccountsByOwner")).toHaveLength(4);
  });

  it("fails closed when a Provider ID collides with an active exact wallet ID", async () => {
    await seedCustodyWalletFixture({
      id: "cwlt_balance_collision",
      walletId: TEST_CUSTODY_WALLET_ID,
      publicKey: TEST_SOLANA_ADDRESSES.wallet2,
      label: "Namespace collision",
    });
    expect((await readBalances(TEST_CUSTODY_WALLET_ID)).status).toBe(409);
    expect(rpc.calls).toEqual([]);
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
    expect(rpc.calls).toEqual([]);
  });

  it("does not reinterpret an unknown internal namespace selector as a Provider ID", async () => {
    await seedCustodyWalletFixture({
      id: "cwlt_balance_unknown_alias",
      walletId: "cwlt_missing",
      publicKey: TEST_SOLANA_ADDRESSES.wallet2,
      label: "Unknown alias",
    });
    expect((await readBalances("cwlt_missing")).status).toBe(404);
    expect(rpc.calls).toEqual([]);
  });
});
