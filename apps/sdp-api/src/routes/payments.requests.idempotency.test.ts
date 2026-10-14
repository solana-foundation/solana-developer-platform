import { describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import {
  DEVNET_USDC_MINT,
  installPaymentsRouteTestHooks,
  TEST_API_KEY,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

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
