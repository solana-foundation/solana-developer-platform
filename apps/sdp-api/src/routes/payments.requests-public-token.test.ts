import type { Action } from "@sdp/types/actions";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { app } from "@/index";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { env } from "@/test/helpers/env";
import {
  seedPaymentRequest,
  seedPaymentRequestTransfer,
  setPaymentRequestColumns,
} from "@/test/helpers/payment-requests";
import {
  DEVNET_USDC_MINT,
  installPaymentsRouteTestHooks,
  seedProjectPrivyWallet,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PRODUCTION_PROJECT_ID,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

/**
 * APE-849: a payment request's public token is the bearer credential of its
 * `/pay/:token` link. Reads never disclose it; only create and the
 * `payment_requests.manage` link read return it.
 */
const READ_KEY = { id: "key_request_reader", raw: "sk_test_request_reader", prefix: "sk_test_rqr" };
const MANAGE_KEY = {
  id: "key_request_manager",
  raw: "sk_test_request_manager",
  prefix: "sk_test_rqm",
};

async function seedKey(key: typeof READ_KEY, grants: Action[]): Promise<void> {
  await seedProjectApiKey(getDb(env), env, {
    key,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    createdBy: TEST_USER.id,
    grants,
  });
}

async function get(path: string, key: typeof READ_KEY): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${key.raw}` } }, env);
}

const readResponseSchema = z.object({ data: z.record(z.string(), z.unknown()) });

describe("payment request public tokens", () => {
  let request: PaymentRequestRow;
  let otherProjectRequest: PaymentRequestRow;

  installPaymentsRouteTestHooks();

  beforeEach(async () => {
    await seedKey(READ_KEY, ["payment_requests.read"]);
    await seedKey(MANAGE_KEY, ["payment_requests.manage"]);

    request = await seedPaymentRequest(env, {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet1,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      expiresAt: null,
      createdBy: TEST_USER.id,
    });
    const productionWalletId = await seedProjectPrivyWallet({
      organizationId: TEST_ORG.id,
      projectId: TEST_PRODUCTION_PROJECT_ID,
      createdBy: TEST_USER.id,
      custodyWalletId: "cwlt_request_token_production",
      publicKey: TEST_SOLANA_ADDRESSES.wallet3,
    });
    otherProjectRequest = await seedPaymentRequest(env, {
      organizationId: TEST_ORG.id,
      projectId: TEST_PRODUCTION_PROJECT_ID,
      custodyWalletId: "cwlt_request_token_production",
      walletId: productionWalletId,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet3,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      expiresAt: null,
      createdBy: TEST_USER.id,
    });
  });

  it.each([
    ["payment_requests.read", READ_KEY],
    ["payment_requests.manage", MANAGE_KEY],
  ] as const)(
    "lists only the project's requests, never with the token, even to a key holding %s",
    async (_grant, key) => {
      const res = await get("/v1/payments/requests?status=awaiting_payment", key);

      expect(res.status).toBe(200);
      const body = z
        .object({ data: z.object({ paymentRequests: z.array(z.record(z.string(), z.unknown())) }) })
        .parse(await res.json());
      expect(body.data.paymentRequests.map((row) => row.id)).toEqual([request.id]);
      expect(body.data.paymentRequests[0]).not.toHaveProperty("publicToken");
      expect(JSON.stringify(body)).not.toContain(request.public_token);
    }
  );

  it("reads a request in its record shape, without the token", async () => {
    const res = await get(`/v1/payments/requests/${request.id}`, MANAGE_KEY);

    expect(res.status).toBe(200);
    expect(readResponseSchema.parse(await res.json()).data).toEqual({
      id: request.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      walletId: TEST_WALLET_ID,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet1,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      reference: request.reference,
      status: "awaiting_payment",
      expiresAt: null,
      fulfilledByTransferId: null,
      paidLate: false,
      lastCheckedAt: null,
      canceledByApiKeyId: null,
      canceledByUserId: null,
      canceledAt: null,
      lifecycle: request.lifecycle,
      createdBy: TEST_USER.id,
      createdAt: request.created_at,
      updatedAt: request.updated_at,
    });
  });

  it("answers 404 for a request in another project", async () => {
    const res = await get(`/v1/payments/requests/${otherProjectRequest.id}`, MANAGE_KEY);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("refuses the link to a key without payment_requests.manage, naming the action", async () => {
    const res = await get(`/v1/payments/requests/${request.id}/link`, READ_KEY);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { code: "INSUFFICIENT_PERMISSIONS", details: { action: "payment_requests.manage" } },
    });
  });

  it("returns the link token with payment_requests.manage", async () => {
    const res = await get(`/v1/payments/requests/${request.id}/link`, MANAGE_KEY);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { id: request.id, publicToken: request.public_token },
      meta: expect.anything(),
    });
  });

  it("refuses create to a key that can only read", async () => {
    const res = await app.request(
      "/v1/payments/requests",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${READ_KEY.raw}`, "Content-Type": "application/json" },
        body: JSON.stringify({ walletId: TEST_WALLET_ID, token: DEVNET_USDC_MINT, amount: "1.00" }),
      },
      env
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { code: "INSUFFICIENT_PERMISSIONS", details: { action: "payment_requests.manage" } },
    });
  });

  it("reports lastCheckedAt from the last verified check, not the last attempt", async () => {
    await setPaymentRequestColumns(env, request.id, {
      last_checked_at: "2026-10-23T10:05:00.000Z",
      last_verified_at: "2026-10-23T10:00:00.000Z",
    });

    const res = await get(`/v1/payments/requests/${request.id}`, MANAGE_KEY);

    expect(res.status).toBe(200);
    expect(readResponseSchema.parse(await res.json()).data).toMatchObject({
      lastCheckedAt: "2026-10-23T10:00:00.000Z",
    });
  });

  it("returns paidLate true for a request settled late", async () => {
    await setPaymentRequestColumns(env, request.id, {
      status: "paid",
      paid_late: "true",
      fulfilled_by_transfer_id: await seedPaymentRequestTransfer(env, request),
    });

    const res = await get(`/v1/payments/requests/${request.id}`, MANAGE_KEY);

    expect(res.status).toBe(200);
    expect(readResponseSchema.parse(await res.json()).data).toMatchObject({
      status: "paid",
      paidLate: true,
    });
  });
});
