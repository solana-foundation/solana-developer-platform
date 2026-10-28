import { describe, expect, it, onTestFinished } from "vitest";
import { getDb } from "@/db/client";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createSystemPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { app } from "@/index";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import { seedUnreadPrivyWallet } from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import {
  cancelSeededPaymentRequest,
  seedPaymentRequest,
  seedPaymentRequestTransfer,
  setPaymentRequestColumns,
} from "@/test/helpers/payment-requests";
import {
  DEVNET_USDC_MINT,
  installPaymentsRouteTestHooks,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PRODUCTION_PROJECT_ID,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { required } from "@/test/helpers/required";

const PAST = "2020-01-01T00:00:00.000Z";
const AUDIT_FAILURE_CONSTRAINT = "sdp_test_fail_payment_request_audit";

function postCancel(requestId: string) {
  return app.request(
    `/v1/payments/requests/${requestId}/cancel`,
    { method: "POST", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
    env
  );
}

function seedSandboxRequest() {
  return seedPaymentRequest(env, {
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    custodyWalletId: TEST_CUSTODY_WALLET_ID,
    walletId: TEST_WALLET_ID,
    destinationAddress: TEST_SOLANA_ADDRESSES.wallet1,
    token: DEVNET_USDC_MINT,
    amount: "1.5",
    expiresAt: null,
    createdBy: TEST_USER.id,
    createdByApiKeyId: TEST_API_KEY.id,
  });
}

async function stored(request: PaymentRequestRow): Promise<PaymentRequestRow> {
  return required(
    await createSystemPaymentRequestsRepository(env).getPaymentRequestById({
      requestId: request.id,
      organizationId: request.organization_id,
      projectId: request.project_id,
    })
  );
}

function claimWindow(request: PaymentRequestRow, lastValidBlockHeight: string) {
  return setPaymentRequestColumns(env, request.id, {
    sponsored_tx_account: TEST_SOLANA_ADDRESSES.wallet2,
    sponsored_tx_unsigned: "dHhB",
    sponsored_tx_last_valid_block_height: lastValidBlockHeight,
  });
}

async function markPaid(request: PaymentRequestRow): Promise<void> {
  await createSystemPaymentRequestsRepository(env).markPaymentRequest({
    requestId: request.id,
    organizationId: request.organization_id,
    projectId: request.project_id,
    status: "paid",
    fulfilledByTransferId: await seedPaymentRequestTransfer(env, request),
    paidLate: false,
    chainRead: true,
  });
}

const REFUSED_STATES: ReadonlyArray<[string, (request: PaymentRequestRow) => Promise<void>]> = [
  ["paid", markPaid],
  ["stored expired", (request) => setPaymentRequestColumns(env, request.id, { status: "expired" })],
  ["past its expiry", (request) => setPaymentRequestColumns(env, request.id, { expires_at: PAST })],
  [
    "holding a sponsored transaction that can still land",
    (request) => claimWindow(request, "1000"),
  ],
];

describe("POST /v1/payments/requests/:paymentRequestId/cancel", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcResponder();

  it("cancels an open request without reading the chain and answers with its read shape", async () => {
    const request = await seedSandboxRequest();

    const response = await postCancel(request.id);

    expect(response.status).toBe(200);
    const canceled = await stored(request);
    expect(await response.json()).toEqual({
      data: {
        id: request.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        walletId: TEST_WALLET_ID,
        destinationAddress: TEST_SOLANA_ADDRESSES.wallet1,
        token: DEVNET_USDC_MINT,
        amount: "1.5",
        reference: request.reference,
        status: "canceled",
        expiresAt: null,
        fulfilledByTransferId: null,
        paidLate: false,
        lastCheckedAt: null,
        canceledBy: TEST_USER.id,
        canceledAt: required(canceled.canceled_at),
        lifecycle: canceled.lifecycle,
        createdBy: TEST_USER.id,
        createdAt: request.created_at,
        updatedAt: canceled.updated_at,
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
    expect(canceled.lifecycle.map((event) => event.status)).toEqual([
      "awaiting_payment",
      "canceled",
    ]);
    expect(rpc.calls.map((call) => call.method)).not.toContain("getBlockHeight");
  });

  it("answers an already canceled request with its row unchanged", async () => {
    const canceled = await cancelSeededPaymentRequest(
      env,
      await seedSandboxRequest(),
      TEST_USER.id
    );

    const response = await postCancel(canceled.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        status: "canceled",
        canceledAt: canceled.canceled_at,
        updatedAt: canceled.updated_at,
      },
    });
    expect(await stored(canceled)).toEqual(canceled);
  });

  it.each(REFUSED_STATES)(
    "refuses a request %s with 409 and leaves it open",
    async (_state, arrange) => {
      rpc.answer("getBlockHeight", 900);
      const request = await seedSandboxRequest();
      await arrange(request);

      const response = await postCancel(request.id);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "CONFLICT" } });
      expect(await stored(request)).toMatchObject({ canceled_by: null, canceled_at: null });
    }
  );

  it("answers 404 for a request in another project", async () => {
    await seedUnreadPrivyWallet(getDb(env), {
      organizationId: TEST_ORG.id,
      projectId: TEST_PRODUCTION_PROJECT_ID,
      createdBy: TEST_USER.id,
      custodyWalletId: "cwlt_cancel_production",
      walletId: "privy_cancel_production",
      publicKey: TEST_SOLANA_ADDRESSES.wallet3,
    });
    const request = await seedPaymentRequest(env, {
      organizationId: TEST_ORG.id,
      projectId: TEST_PRODUCTION_PROJECT_ID,
      custodyWalletId: "cwlt_cancel_production",
      walletId: "privy_cancel_production",
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet3,
      token: DEVNET_USDC_MINT,
      amount: "1.5",
      expiresAt: null,
      createdBy: TEST_USER.id,
      createdByApiKeyId: null,
    });

    const response = await postCancel(request.id);

    expect(response.status).toBe(404);
    expect((await stored(request)).status).toBe("awaiting_payment");
  });

  it("answers 502 and leaves the request open when the block height cannot be read", async () => {
    rpc.respond("getBlockHeight", () => ({
      error: { code: -32603, message: "RPC unavailable" },
    }));
    const request = await seedSandboxRequest();
    await claimWindow(request, "10");

    const response = await postCancel(request.id);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "SOLANA_RPC_ERROR" } });
    expect(await stored(request)).toMatchObject({
      status: "awaiting_payment",
      canceled_by: null,
      canceled_at: null,
    });
  });

  it("rolls the cancel back when its audit record cannot be written", async () => {
    await getDb(env).execute(
      `ALTER TABLE audit_logs ADD CONSTRAINT ${AUDIT_FAILURE_CONSTRAINT}
         CHECK (resource_type IS DISTINCT FROM 'payment_request') NOT VALID`
    );
    onTestFinished(async () => {
      await getDb(env).execute(
        `ALTER TABLE audit_logs DROP CONSTRAINT ${AUDIT_FAILURE_CONSTRAINT}`
      );
    });
    const request = await seedSandboxRequest();

    const response = await postCancel(request.id);

    expect(response.status).toBe(500);
    expect(await stored(request)).toMatchObject({
      status: "awaiting_payment",
      canceled_by: null,
      canceled_at: null,
    });
  });
});
