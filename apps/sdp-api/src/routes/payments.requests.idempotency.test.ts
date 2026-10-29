import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  DEVNET_USDC_MINT,
  installPaymentsRouteTestHooks,
  seedProductionPrivyWallet,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_PRODUCTION_PROJECT_ID,
  TEST_PROJECT,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { required } from "@/test/helpers/required";

function postPaymentRequest(body: Record<string, unknown>, idempotencyKey: string) {
  return app.request(
    "/v1/payments/requests",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
    env
  );
}

async function storedKeyCount(idempotencyKey: string): Promise<number> {
  const row = await getDb(env)
    .prepare("SELECT COUNT(*)::integer AS count FROM idempotency_keys WHERE idempotency_key = ?")
    .bind(idempotencyKey)
    .first<{ count: number }>();
  if (row === null) throw new Error("COUNT(*) returned no row");
  return row.count;
}

describe("Payments routes — payment request access before the key", () => {
  installPaymentsRouteTestHooks();

  it("refuses a wallet outside the caller's project with 404 and stores nothing under the key", async () => {
    const response = await postPaymentRequest(
      { walletId: "wal_other_organization", token: DEVNET_USDC_MINT, amount: "1" },
      "payreq-foreign-wallet"
    );

    expect(response.status).toBe(404);
    expect(await storedKeyCount("payreq-foreign-wallet")).toBe(0);
  });

  it("still creates a request for the project's own wallet", async () => {
    const response = await postPaymentRequest(
      { walletId: TEST_WALLET_ID, token: DEVNET_USDC_MINT, amount: "1" },
      "payreq-own-wallet"
    );

    expect(response.status).toBe(201);
    expect(await storedKeyCount("payreq-own-wallet")).toBe(1);
  });

  it("replays a retry that only re-spells the amount (APE SOLA9-734)", async () => {
    const first = await postPaymentRequest(
      { walletId: TEST_WALLET_ID, token: DEVNET_USDC_MINT, amount: "1" },
      "payreq-respelled"
    );
    const retry = await postPaymentRequest(
      { walletId: TEST_WALLET_ID, token: DEVNET_USDC_MINT, amount: "1.00" },
      "payreq-respelled"
    );

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    const createdSchema = z.object({ data: z.object({ id: z.string() }) });
    const created = createdSchema.parse(await first.json());
    const replayed = createdSchema.parse(await retry.json());
    expect(replayed.data.id).toBe(created.data.id);
  });
});

describe("Payments routes — payment request token cluster", () => {
  installPaymentsRouteTestHooks();

  it("refuses the devnet USDC mint on a Production project and stores no request", async () => {
    await seedProductionPrivyWallet({
      custodyWalletId: "cwlt_payment_request_production",
      publicKey: TEST_SOLANA_ADDRESSES.wallet3,
    });
    const productionWallet = required(
      await getDb(env)
        .prepare("SELECT wallet_id FROM custody_wallets WHERE id = ?")
        .bind("cwlt_payment_request_production")
        .first<{ wallet_id: string }>()
    );

    const response = await postPaymentRequest(
      { walletId: productionWallet.wallet_id, token: DEVNET_USDC_MINT, amount: "1" },
      "payreq-devnet-mint-on-production"
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: `USDC mint ${DEVNET_USDC_MINT} is not available on mainnet-beta`,
      },
    });
    const stored = await getDb(env)
      .prepare("SELECT COUNT(*)::integer AS count FROM payment_requests WHERE project_id = ?")
      .bind(TEST_PRODUCTION_PROJECT_ID)
      .first<{ count: number }>();
    expect(stored).toEqual({ count: 0 });
  });

  it.each(["1.0000001", "18446744073709.551616"])(
    "refuses invalid USDC amount %s and stores no request",
    async (amount) => {
      const response = await postPaymentRequest(
        { walletId: TEST_WALLET_ID, token: DEVNET_USDC_MINT, amount },
        "payreq-too-precise-amount"
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
      const stored = await getDb(env)
        .prepare("SELECT COUNT(*)::integer AS count FROM payment_requests WHERE project_id = ?")
        .bind(TEST_PROJECT.id)
        .first<{ count: number }>();
      expect(stored).toEqual({ count: 0 });
    }
  );
});

describe("Payments routes — subscription plan wallets before the key", () => {
  installPaymentsRouteTestHooks();

  function postPlan(body: Record<string, unknown>, idempotencyKey: string) {
    return app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ token: DEVNET_USDC_MINT, amount: "1", periodHours: 24, ...body }),
      },
      env
    );
  }

  it("refuses an owner wallet outside the caller's project with 404 and stores nothing", async () => {
    const response = await postPlan(
      { ownerCustodyWalletId: "cwlt_other_organization" },
      "plan-foreign-owner"
    );
    expect(response.status).toBe(404);
    expect(await storedKeyCount("plan-foreign-owner")).toBe(0);
  });

  it("refuses a puller wallet outside the caller's project with 404 and stores nothing", async () => {
    const response = await postPlan(
      {
        ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        pullerCustodyWalletId: "cwlt_other_organization",
      },
      "plan-foreign-puller"
    );
    expect(response.status).toBe(404);
    expect(await storedKeyCount("plan-foreign-puller")).toBe(0);
  });

  it("replays a retry that only re-spells the amount (APE SOLA9-759)", async () => {
    const first = await postPlan(
      { ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID, amount: "25" },
      "plan-respelled"
    );
    const retry = await postPlan(
      { ownerCustodyWalletId: TEST_CUSTODY_WALLET_ID, amount: "25.0" },
      "plan-respelled"
    );

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(await first.clone().json());
  });
});

describe("Payments routes — SOL payment requests below the rent minimum (HOO-2375)", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcStub();

  it("refuses a SOL request below the minimum to a wallet with no account, storing nothing", async () => {
    rpc.answer("getMultipleAccounts", { context: { slot: 1 }, value: [null] });
    const response = await postPaymentRequest(
      { walletId: TEST_WALLET_ID, token: SOL_MINT, amount: "0.0001" },
      "payreq-sol-below-rent"
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "AMOUNT_BELOW_RENT_MINIMUM", details: { recipientIndexes: [0] } },
    });
    expect(await storedKeyCount("payreq-sol-below-rent")).toBe(0);
  });

  it("creates a SOL request at or above the minimum without reading the wallet", async () => {
    const response = await postPaymentRequest(
      { walletId: TEST_WALLET_ID, token: SOL_MINT, amount: "0.001" },
      "payreq-sol-above-rent"
    );

    expect(response.status).toBe(201);
    expect(rpc.calls.filter((call) => call.method === "getMultipleAccounts")).toHaveLength(0);
  });
});
