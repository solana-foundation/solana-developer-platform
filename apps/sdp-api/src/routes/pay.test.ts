import { SOL_MINT } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import app from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  createFeePaymentAdapterMock,
  getRecentBlockhashMock,
  installPaymentsRouteTestHooks,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

describe("Public payment request routes", () => {
  installPaymentsRouteTestHooks();

  it("keeps an unresolved legacy request readable but refuses to build its transaction", async () => {
    const request = await createPaymentRequestsRepository(
      env,
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
    ).createPaymentRequest({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      counterpartyId: null,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet1,
      token: SOL_MINT,
      amount: "1.5",
      expiresAt: null,
      createdBy: TEST_USER.id,
    });
    await getDb(env)
      .prepare("UPDATE payment_requests SET custody_wallet_id = NULL WHERE id = ?")
      .bind(request.id)
      .run();

    const detailResponse = await app.request(`/pay/${request.public_token}`, {}, env);

    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      status: "awaiting_payment",
      solanaPayUrl: null,
    });

    const transactionResponse = await app.request(
      `/pay/${request.public_token}/tx`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: TEST_SOLANA_ADDRESSES.wallet2 }),
      },
      env
    );

    expect(transactionResponse.status).toBe(409);
    await expect(transactionResponse.json()).resolves.toMatchObject({
      error: { code: "CONFLICT" },
    });
    expect(createFeePaymentAdapterMock).not.toHaveBeenCalled();
    expect(getRecentBlockhashMock).not.toHaveBeenCalled();
  });
});
