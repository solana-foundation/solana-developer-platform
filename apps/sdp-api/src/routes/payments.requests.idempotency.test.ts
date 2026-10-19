import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  DEVNET_USDC_MINT,
  installPaymentsRouteTestHooks,
  seedProductionPrivyWallet,
  TEST_API_KEY,
  TEST_PRODUCTION_PROJECT_ID,
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

  it("refuses a counterparty outside the caller's project with 404 and stores nothing under the key", async () => {
    const response = await postPaymentRequest(
      {
        walletId: TEST_WALLET_ID,
        token: DEVNET_USDC_MINT,
        amount: "1",
        counterpartyId: "cp_payment_request_missing",
      },
      "payreq-foreign-counterparty"
    );

    expect(response.status).toBe(404);
    expect(await storedKeyCount("payreq-foreign-counterparty")).toBe(0);
  });

  it("still creates a request for the project's own wallet", async () => {
    const response = await postPaymentRequest(
      { walletId: TEST_WALLET_ID, token: DEVNET_USDC_MINT, amount: "1" },
      "payreq-own-wallet"
    );

    expect(response.status).toBe(201);
    expect(await storedKeyCount("payreq-own-wallet")).toBe(1);
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
      { ownerWalletId: "wal_other_organization" },
      "plan-foreign-owner"
    );
    expect(response.status).toBe(404);
    expect(await storedKeyCount("plan-foreign-owner")).toBe(0);
  });

  it("refuses a puller wallet outside the caller's project with 404 and stores nothing", async () => {
    const response = await postPlan(
      { ownerWalletId: TEST_WALLET_ID, pullerWalletId: "wal_other_organization" },
      "plan-foreign-puller"
    );
    expect(response.status).toBe(404);
    expect(await storedKeyCount("plan-foreign-puller")).toBe(0);
  });
});
