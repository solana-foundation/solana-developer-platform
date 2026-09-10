import type * as solanaRpc from "@sdp/rpc/solana";
import { SOL_MINT } from "@sdp/types";
import { address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import app from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import * as rateLimit from "@/middleware/rate-limit";
import * as sponsorshipService from "@/services/sponsorship.service";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  createFeePaymentAdapterMock,
  createRpcMock,
  getRecentBlockhashMock,
  installPaymentsRouteTestHooks,
  TEST_CUSTODY_WALLET_ID,
  TEST_KORA_FEE_PAYER,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

describe("Public payment request routes", () => {
  installPaymentsRouteTestHooks();

  function createAwaitingPaymentRequest() {
    return createPaymentRequestsRepository(
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
  }

  function postTransaction(publicToken: string) {
    return app.request(
      `/pay/${publicToken}/tx`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: TEST_SOLANA_ADDRESSES.wallet2 }),
      },
      env
    );
  }

  function stubSponsorship() {
    return vi
      .spyOn(sponsorshipService, "createProjectSponsorshipFeePayment")
      .mockImplementation(async () => ({
        providerId: "test",
        getFeePayer: async () => address(TEST_KORA_FEE_PAYER),
        signAsFeePayer: async (transaction: Uint8Array) => transaction,
        signAndSend: () => Promise.reject(new Error("not used")),
        prepareOwnedSubmission: () => Promise.reject(new Error("not used")),
      }));
  }

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

  describe("sponsored transaction window", () => {
    beforeEach(() => {
      createRpcMock.mockReturnValue({
        getSignaturesForAddress: () => ({ send: async () => [] }),
        getBlockHeight: () => ({ send: async () => 900n }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);
    });

    it("signs once per window and replays the stored transaction for the same account", async () => {
      const sponsorship = stubSponsorship();
      const request = await createAwaitingPaymentRequest();

      const first = await postTransaction(request.public_token);
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { transaction: string };

      const second = await postTransaction(request.public_token);
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { transaction: string };

      expect(secondBody.transaction).toBe(firstBody.transaction);
      expect(sponsorship).toHaveBeenCalledTimes(1);
    });

    it("answers a different account with 429 and Retry-After while the claim is live", async () => {
      stubSponsorship();
      const request = await createAwaitingPaymentRequest();
      expect((await postTransaction(request.public_token)).status).toBe(200);

      const other = await app.request(
        `/pay/${request.public_token}/tx`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: TEST_SOLANA_ADDRESSES.wallet3 }),
        },
        env
      );
      expect(other.status).toBe(429);
      expect(Number(other.headers.get("Retry-After"))).toBeGreaterThan(0);
    });

    it("lets a new account claim after the window expires", async () => {
      const sponsorship = stubSponsorship();
      const request = await createAwaitingPaymentRequest();
      expect((await postTransaction(request.public_token)).status).toBe(200);

      createRpcMock.mockReturnValue({
        getSignaturesForAddress: () => ({ send: async () => [] }),
        getBlockHeight: () => ({ send: async () => 2_000n }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);

      const other = await app.request(
        `/pay/${request.public_token}/tx`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: TEST_SOLANA_ADDRESSES.wallet3 }),
        },
        env
      );
      expect(other.status).toBe(200);
      expect(sponsorship).toHaveBeenCalledTimes(2);
    });

    it("keeps the claim when signing fails and signs the stored bytes on retry", async () => {
      const sponsorship = stubSponsorship();
      sponsorship.mockImplementationOnce(async () => ({
        providerId: "test",
        getFeePayer: async () => address(TEST_KORA_FEE_PAYER),
        signAsFeePayer: () => Promise.reject(new Error("signing timed out")),
        signAndSend: () => Promise.reject(new Error("not used")),
        prepareOwnedSubmission: () => Promise.reject(new Error("not used")),
      }));
      const request = await createAwaitingPaymentRequest();

      expect((await postTransaction(request.public_token)).status).toBe(500);
      const retried = await postTransaction(request.public_token);
      expect(retried.status).toBe(200);
      expect(sponsorship).toHaveBeenCalledTimes(2);
    });

    it("does not open a claim for a payload it cannot build a transaction from", async () => {
      const sponsorship = stubSponsorship();
      const request = await createAwaitingPaymentRequest();

      const malformed = await app.request(
        `/pay/${request.public_token}/tx`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: "not-a-solana-address" }),
        },
        env
      );
      expect(malformed.status).toBe(400);
      expect(sponsorship).not.toHaveBeenCalled();

      expect((await postTransaction(request.public_token)).status).toBe(200);
    });
  });
});
