import { SOL_MINT } from "@sdp/types";
import { blockhash } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createSystemPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import app from "@/index";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  createFeePaymentAdapterMock,
  createRpcMock,
  getRecentBlockhashMock,
  installPaymentsRouteTestHooks,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

describe("Public payment sponsorship accounting continuity", () => {
  installPaymentsRouteTestHooks();

  beforeEach(() => {
    createRpcMock.mockReturnValue({
      getSignaturesForAddress: () => ({ send: async () => [] }),
      getBlockHeight: () => ({ send: async () => 900n }),
      getFeeForMessage: () => ({ send: async () => ({ value: 5000n }) }),
    } as unknown as ReturnType<typeof import("@sdp/rpc/solana").createRpc>);
  });

  const repository = () => createSystemPaymentRequestsRepository(env);
  const reservations = () =>
    getDb(env).queryMany<{
      id: string;
      actor_type: string;
      actor_id: string;
      status: string;
      attempt: number;
      signed_transaction: string | null;
    }>(
      `SELECT id, actor_type, actor_id, status, attempt, signed_transaction
       FROM sponsorship_budget_reservations
       WHERE organization_id = ? AND project_id = ? ORDER BY id`,
      [TEST_ORG.id, TEST_PROJECT.id]
    );
  const createRequest = () =>
    repository().createPaymentRequest({
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
  const post = (token: string) =>
    app.request(
      `/pay/${token}/tx`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: TEST_SOLANA_ADDRESSES.wallet2 }),
      },
      env
    );

  it("retains the original scoped reservation before returning and replaying sponsored bytes", async () => {
    const getSignaturesForAddress = vi.fn(() => ({ send: async () => [] }));
    const getBlockHeight = vi.fn(() => ({ send: async () => 900n }));
    const getFeeForMessage = vi.fn(() => ({ send: async () => ({ value: 5000n }) }));
    createRpcMock.mockReturnValue({
      getSignaturesForAddress,
      getBlockHeight,
      getFeeForMessage,
    } as unknown as ReturnType<typeof import("@sdp/rpc/solana").createRpc>);
    const request = await createRequest();
    const response = await post(request.public_token);
    expect(response.status).toBe(200);
    const originalBytes = ((await response.json()) as { transaction: string }).transaction;
    const claim = await repository().getSponsoredTransactionClaim(request.id);
    expect(claim).toMatchObject({
      unsignedTransaction: expect.any(String),
      signedTransaction: originalBytes,
    });
    const originalReservations = await reservations();
    expect(originalReservations).toEqual([
      {
        id: expect.stringMatching(/^sbr_[a-f0-9]{64}$/),
        actor_type: "wallet",
        actor_id: TEST_WALLET_ID,
        status: "signed",
        attempt: 1,
        signed_transaction: originalBytes,
      },
    ]);
    expect(claim?.accountingIdentity).toMatchObject({
      reservationId: originalReservations[0].id,
      attempt: 1,
      actor: { type: "wallet", id: TEST_WALLET_ID },
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
    });
    const replay = await post(request.public_token);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { transaction: string }).transaction).toBe(originalBytes);
    expect(await reservations()).toEqual(originalReservations);
    expect(getRecentBlockhashMock).toHaveBeenCalledOnce();
    expect(getFeeForMessage).toHaveBeenCalledOnce();
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(2);
    expect(getBlockHeight).toHaveBeenCalledTimes(2);
    const provider = createFeePaymentAdapterMock.mock.results[0]?.value;
    expect(provider.signAsFeePayer).toHaveBeenCalledOnce();
    expect(provider.getSponsorshipConfiguration).toHaveBeenCalledOnce();
  });

  it.each(["signed", "submitted", "committed"])(
    "continues an unsigned legacy claim from its original %s reservation",
    async (status) => {
      const request = await createRequest();
      const first = await post(request.public_token);
      expect(first.status).toBe(200);
      const bytes = ((await first.json()) as { transaction: string }).transaction;
      await getDb(env).execute(
        "UPDATE sponsorship_budget_reservations SET status = ? WHERE organization_id = ? AND project_id = ?",
        [status, TEST_ORG.id, TEST_PROJECT.id]
      );
      await getDb(env).execute(
        "UPDATE payment_requests SET sponsored_tx_signed = NULL, sponsored_tx_continuity = NULL WHERE id = ?",
        [request.id]
      );
      const original = await reservations();
      const replay = await post(request.public_token);
      expect(replay.status).toBe(200);
      expect(((await replay.json()) as { transaction: string }).transaction).toBe(bytes);
      expect(await reservations()).toEqual(original);
      expect(
        (await repository().getSponsoredTransactionClaim(request.id))?.accountingIdentity
      ).toMatchObject({ reservationId: original[0].id, actor: { id: TEST_WALLET_ID } });
      expect(
        createFeePaymentAdapterMock.mock.results[0]?.value.signAsFeePayer
      ).toHaveBeenCalledOnce();
    }
  );

  it.each(["reserved", "charged_unknown"])(
    "preserves the %s fence through live retries and expired-window replacement",
    async (status) => {
      const request = await createRequest();
      expect((await post(request.public_token)).status).toBe(200);
      await getDb(env).execute(
        "UPDATE sponsorship_budget_reservations SET status = ? WHERE organization_id = ? AND project_id = ?",
        [status, TEST_ORG.id, TEST_PROJECT.id]
      );
      await getDb(env).execute(
        "UPDATE payment_requests SET sponsored_tx_signed = NULL WHERE id = ?",
        [request.id]
      );
      const claim = await repository().getSponsoredTransactionClaim(request.id);
      const original = await reservations();
      expect((await post(request.public_token)).status).toBe(503);
      createRpcMock.mockReturnValue({
        getSignaturesForAddress: () => ({ send: async () => [] }),
        getBlockHeight: () => ({ send: async () => 2000n }),
      } as unknown as ReturnType<typeof import("@sdp/rpc/solana").createRpc>);
      expect((await post(request.public_token)).status).toBe(503);
      expect(await reservations()).toEqual(original);
      expect(await repository().getSponsoredTransactionClaim(request.id)).toEqual(claim);
      expect(
        createFeePaymentAdapterMock.mock.results[0]?.value.signAsFeePayer
      ).toHaveBeenCalledOnce();
      expect(getRecentBlockhashMock).toHaveBeenCalledOnce();
    }
  );

  it("fences a charged-unknown expired window even when signed bytes were checkpointed", async () => {
    const request = await createRequest();
    expect((await post(request.public_token)).status).toBe(200);
    await getDb(env).execute(
      "UPDATE sponsorship_budget_reservations SET status = 'charged_unknown' WHERE organization_id = ? AND project_id = ?",
      [TEST_ORG.id, TEST_PROJECT.id]
    );
    const claim = await repository().getSponsoredTransactionClaim(request.id);
    const original = await reservations();
    createRpcMock.mockReturnValue({
      getSignaturesForAddress: () => ({ send: async () => [] }),
      getBlockHeight: () => ({ send: async () => 2000n }),
    } as unknown as ReturnType<typeof import("@sdp/rpc/solana").createRpc>);
    expect((await post(request.public_token)).status).toBe(503);
    expect(await repository().getSponsoredTransactionClaim(request.id)).toEqual(claim);
    expect(await reservations()).toEqual(original);
    expect(
      createFeePaymentAdapterMock.mock.results[0]?.value.signAsFeePayer
    ).toHaveBeenCalledOnce();
    expect(getRecentBlockhashMock).toHaveBeenCalledOnce();
  });

  it("refuses a pre-admission claim with no reservation until writer retirement authorizes absence", async () => {
    const provider = createFeePaymentAdapterMock.getMockImplementation()?.(env);
    if (!provider?.getSponsorshipConfiguration)
      throw new Error("Missing external provider fixture");
    vi.mocked(provider.getSponsorshipConfiguration).mockRejectedValueOnce(
      new Error("preflight unavailable")
    );
    const request = await createRequest();
    expect((await post(request.public_token)).status).toBe(503);
    const claim = await repository().getSponsoredTransactionClaim(request.id);
    expect(claim).toMatchObject({ signedTransaction: null, accountingIdentity: null });
    expect(await reservations()).toEqual([]);
    expect((await post(request.public_token)).status).toBe(503);
    expect(await repository().getSponsoredTransactionClaim(request.id)).toEqual(claim);
    expect(await reservations()).toEqual([]);
    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
    expect(provider.getSponsorshipConfiguration).toHaveBeenCalledOnce();
  });

  it("refuses competing accounting candidates without choosing another actor", async () => {
    const request = await createRequest();
    expect((await post(request.public_token)).status).toBe(200);
    await getDb(env).execute(
      "UPDATE payment_requests SET sponsored_tx_signed = NULL WHERE id = ?",
      [request.id]
    );
    await getDb(env).execute(
      `INSERT INTO sponsorship_budget_reservations
      (id, network, product_environment, organization_id, project_id, actor_type, actor_id,
       transaction_digest, fee_payer, provider_config_fingerprint, recent_blockhash,
       reserved_lamports, hour_bucket, day_bucket, policy_versions, status)
      SELECT 'sbr_conflicting_request', network, product_environment, organization_id, project_id,
             actor_type, ?, transaction_digest, fee_payer, provider_config_fingerprint,
             recent_blockhash, reserved_lamports, hour_bucket, day_bucket, policy_versions, 'reserved'
      FROM sponsorship_budget_reservations WHERE organization_id = ? AND project_id = ?`,
      [TEST_CUSTODY_WALLET_ID, TEST_ORG.id, TEST_PROJECT.id]
    );
    const original = await reservations();
    const claim = await repository().getSponsoredTransactionClaim(request.id);
    expect((await post(request.public_token)).status).toBe(503);
    expect(await reservations()).toEqual(original);
    expect(await repository().getSponsoredTransactionClaim(request.id)).toEqual(claim);
    expect(
      createFeePaymentAdapterMock.mock.results[0]?.value.signAsFeePayer
    ).toHaveBeenCalledOnce();
  });

  it("replaces a proven expired signed window while retaining its original debit and provider identity", async () => {
    const request = await createRequest();
    expect((await post(request.public_token)).status).toBe(200);
    const original = await reservations();
    createRpcMock.mockReturnValue({
      getSignaturesForAddress: () => ({ send: async () => [] }),
      getBlockHeight: () => ({ send: async () => 2000n }),
      getFeeForMessage: () => ({ send: async () => ({ value: 5000n }) }),
    } as unknown as ReturnType<typeof import("@sdp/rpc/solana").createRpc>);
    getRecentBlockhashMock.mockResolvedValue({
      blockhash: blockhash("1".repeat(32)),
      lastValidBlockHeight: 3000n,
    });
    expect((await post(request.public_token)).status).toBe(200);
    const updated = await reservations();
    expect(updated).toHaveLength(2);
    expect(updated).toContainEqual(original[0]);
    expect(
      (await repository().getSponsoredTransactionClaim(request.id))?.accountingIdentity
        ?.reservationId
    ).not.toBe(original[0].id);
    expect(createFeePaymentAdapterMock).toHaveBeenCalledTimes(2);
    expect(
      await getDb(env).queryOne<{ spent: string }>(
        "SELECT SUM(reserved_lamports)::text AS spent FROM sponsorship_budget_reservations WHERE organization_id = ? AND project_id = ?",
        [TEST_ORG.id, TEST_PROJECT.id]
      )
    ).toEqual({ spent: "10000" });
  });

  it.each(["suspended", "deleted"])(
    "refuses saved bytes after organization %s without rewriting exposure",
    async (status) => {
      const request = await createRequest();
      expect((await post(request.public_token)).status).toBe(200);
      const claim = await repository().getSponsoredTransactionClaim(request.id);
      const original = await reservations();
      await getDb(env).execute("UPDATE organizations SET status = ? WHERE id = ?", [
        status,
        TEST_ORG.id,
      ]);
      expect((await post(request.public_token)).status).toBe(403);
      expect(await repository().getSponsoredTransactionClaim(request.id)).toEqual(claim);
      expect(await reservations()).toEqual(original);
      expect(createFeePaymentAdapterMock).toHaveBeenCalledOnce();
    }
  );

  it("keeps self-hosted claim continuity without inventing SDP reservations and refuses a deployment-mode change", async () => {
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    try {
      const request = await createRequest();
      expect((await post(request.public_token)).status).toBe(200);
      const claim = await repository().getSponsoredTransactionClaim(request.id);
      expect(claim).toMatchObject({ deploymentMode: "self_hosted", accountingIdentity: null });
      expect(await reservations()).toEqual([]);
      expect(createFeePaymentAdapterMock.mock.calls[0]?.[1]).toContain(`wallet:${TEST_WALLET_ID}`);
      env.SDP_DEPLOYMENT_MODE = undefined;
      expect((await post(request.public_token)).status).toBe(200);
      await getDb(env).execute(
        "UPDATE payment_requests SET sponsored_tx_signed = NULL WHERE id = ?",
        [request.id]
      );
      expect((await post(request.public_token)).status).toBe(503);
      expect(await reservations()).toEqual([]);
      expect(createFeePaymentAdapterMock).toHaveBeenCalledOnce();
    } finally {
      env.SDP_DEPLOYMENT_MODE = undefined;
    }
  });
});
