import type * as feePaymentAdapters from "@sdp/fee-payment";
import { SOL_MINT } from "@sdp/types";
import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { generatePaymentTransferId } from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { createTenantScope } from "@/lib/tenant-scope";
import { AuditService } from "@/services/audit.service";
import { rampTransferTokenMint } from "@/services/payment-operation.service";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcStub, tokenAccountsByOwnerResult } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  createFeePaymentAdapterMock,
  createOrgSignerForCustodyWalletMock,
  DEVNET_USDC_MINT,
  enableMainnetSponsorship,
  installPaymentsRouteTestHooks,
  MAINNET_USDC_MINT,
  seedProductionPrivyWallet,
  sendTransactionMock,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PRODUCTION_PROJECT_ID,
  TEST_PROJECT,
  TEST_SPONSORSHIP_PROVIDER_CONFIG,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import {
  countTransferRows,
  listTransferRows,
  postRawTransfer,
  postTransfer,
  readErrorResponse,
  readTransferResponse,
  readTransferRow,
} from "@/test/helpers/payments-transfers";
import { required } from "@/test/helpers/required";
import { fullySignTestTransaction, TEST_MOCK_FEE_PAYER } from "@/test/helpers/sponsor-signing";

describe("Payments routes — on-chain transfers", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcStub();

  function answerSourceUsdcTokenAccount(mint: string) {
    rpc.answer(
      "getTokenAccountsByOwner",
      tokenAccountsByOwnerResult(1, [
        {
          pubkey: TEST_SOLANA_ADDRESSES.wallet3,
          mint,
          amount: "1000000000",
          decimals: 6,
          uiAmountString: "1000",
        },
      ])
    );
  }

  it("rejects the retired privateTransfer field at the request boundary", async () => {
    const res = await postRawTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
        privateTransfer: {},
      },
      {}
    );

    expect(res.status).toBe(400);
    const body = await readErrorResponse(res);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).not.toHaveBeenCalled();
    expect(await countTransferRows()).toBe(0);
  });

  it("blocks create transfer with zero amount before creating a transfer record", async () => {
    const res = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0",
      },
      {}
    );

    expect(res.status).toBe(400);
    const body = await readErrorResponse(res);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Invalid request body");
    expect(body.error.message).toContain("Amount must be greater than zero");

    expect(await countTransferRows()).toBe(0);
  });

  it("executes a SOL transfer and returns a confirmed transfer record", async () => {
    const res = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
      },
      {}
    );

    expect(res.status).toBe(200);
    const body = await readTransferResponse(res);
    expect(body.data.transfer.status).toBe("confirmed");
    expect(body.data.transfer.id).toMatch(/^xfr_/);
    expect(body.data.transfer.signature).toBeTruthy();

    const row = await readTransferRow(body.data.transfer.id);
    expect(row.status).toBe("confirmed");
    expect(row.signature).toBeTruthy();
  });

  it("appends a tamper-evident audit intent and outcome for an executed transfer", async () => {
    const res = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
      },
      {}
    );
    expect(res.status).toBe(200);
    const body = await readTransferResponse(res);

    const outcome = await getDb(env)
      .prepare(
        `SELECT metadata, status FROM audit_logs
         WHERE action = 'transfer' AND resource_type = 'payment_transfer' AND resource_id = ?`
      )
      .bind(body.data.transfer.id)
      .first<{ metadata: string; status: string }>();
    expect(outcome?.status).toBe("success");
    const outcomeMetadata = JSON.parse(outcome?.metadata ?? "{}") as Record<string, unknown>;
    expect(outcomeMetadata).toMatchObject({
      auditPhase: "outcome",
      signature: body.data.transfer.signature,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      tokenMint: SOL_MINT,
      amount: "1",
    });
    expect(outcomeMetadata.sourceAddress).toBeTruthy();
    expect(outcomeMetadata.slot).toBeTruthy();

    const intent = await getDb(env)
      .prepare(
        `SELECT resource_id, metadata FROM audit_logs
         WHERE action = 'maintenance' AND resource_type = 'audit_ledger'
           AND metadata::jsonb -> 'target' ->> 'resourceId' = ?`
      )
      .bind(body.data.transfer.id)
      .first<{ resource_id: string; metadata: string }>();
    expect(intent).toBeTruthy();
    expect(outcomeMetadata.auditIntentId).toBe(intent?.resource_id);
    const intentTarget = (
      JSON.parse(intent?.metadata ?? "{}") as {
        target?: { metadata?: Record<string, unknown> };
      }
    ).target?.metadata;
    expect(intentTarget).toMatchObject({
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      tokenMint: SOL_MINT,
      amount: "1",
    });
  });

  it("settles the transfer as failed when audit-ledger admission is refused", async () => {
    const beginSpy = vi
      .spyOn(AuditService.prototype, "beginCritical")
      .mockRejectedValueOnce(new Error("audit ledger unavailable"));

    try {
      const res = await postTransfer(
        {
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "SOL",
          amount: "1",
        },
        {}
      );
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(sendTransactionMock).not.toHaveBeenCalled();

      // The processing row must not survive as a replayable success: a ledger
      // refusal settles it failed instead of stranding it.
      const transfers = await listTransferRows();
      expect(transfers).toHaveLength(1);
      expect(transfers[0]?.status).toBe("failed");
      expect(transfers[0]?.error).toContain("Audit ledger admission failed");
    } finally {
      beginSpy.mockRestore();
    }
  });

  it("appends a failure outcome when transfer execution is refused before submission", async () => {
    createOrgSignerForCustodyWalletMock.mockRejectedValueOnce(new Error("signer unavailable"));

    const res = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
      },
      {}
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(sendTransactionMock).not.toHaveBeenCalled();

    const outcome = await getDb(env)
      .prepare(
        `SELECT status, metadata FROM audit_logs
         WHERE action = 'transfer' AND resource_type = 'payment_transfer'
         ORDER BY ledger_sequence DESC LIMIT 1`
      )
      .first<{ status: string; metadata: string }>();
    expect(outcome?.status).toBe("failure");
    expect(JSON.parse(outcome?.metadata ?? "{}").auditPhase).toBe("outcome");
  });

  it("uses the existing off-ramp row for its on-chain deposit", async () => {
    const transferId = generatePaymentTransferId();
    const repository = createPostgresPaymentsRepository(
      getDb(env),
      createTenantScope({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      })
    );
    await repository.createTransfer({
      id: transferId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      counterpartyId: null,
      sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
      destinationAddress: null,
      token: SOL_MINT,
      amount: "1",
      memo: null,
      type: "offramp",
      direction: "outbound",
      status: "awaiting_payment",
      provider: "moonpay",
      providerReference: "moonpay-ramp-deposit",
      deliveryMode: "hosted",
      fiatCurrency: "USD",
      fiatAmount: "100",
      providerData: {
        cryptoDeposit: {
          destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
          amount: "1.0",
        },
      },
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: TEST_API_KEY.id,
      idempotencyKey: null,
      idempotencyFingerprint: null,
    });

    const requestBody = JSON.stringify({
      transferId,
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "1",
    });
    const res = await postTransfer(JSON.parse(requestBody), {});

    const responseText = await res.text();
    expect(res.status, responseText).toBe(200);
    const body = await readTransferResponse(new Response(responseText));
    expect(body.data.transfer).toMatchObject({
      id: transferId,
      status: "settling",
    });
    expect(body.data.transfer.signature).toBeTruthy();

    const rows = await listTransferRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: transferId,
      custody_wallet_id: TEST_CUSTODY_WALLET_ID,
      status: "settling",
      destination_address: TEST_SOLANA_ADDRESSES.wallet2,
    });
    expect(rows[0]?.signature).toBeTruthy();
    expect(rows[0]?.signed_transaction).toBeTruthy();

    // A second request to fund the same deposit (a retry after a crash, or
    // another key) is answered from the funded row and sends nothing again
    // (HOO-1918), instead of a 409 the client could never get past.
    const sendsBefore = sendTransactionMock.mock.calls.length;
    const duplicate = await postTransfer(JSON.parse(requestBody), {});
    expect(duplicate.status).toBe(200);
    const duplicateBody = await readTransferResponse(duplicate);
    expect(duplicateBody.data.transfer.id).toBe(body.data.transfer.id);
    expect(duplicateBody.data.transfer.signature).toBe(body.data.transfer.signature);
    expect(sendTransactionMock.mock.calls.length).toBe(sendsBefore);
    expect(await countTransferRows()).toBe(1);
  });

  it("funds a Production off-ramp with the mainnet USDC mint its quote recorded", async () => {
    const productionSigner = await generateKeyPairSigner();
    createOrgSignerForCustodyWalletMock.mockResolvedValue(productionSigner);
    await seedProductionPrivyWallet({
      custodyWalletId: "cwlt_payments_production",
      publicKey: productionSigner.address,
    });
    await enableMainnetSponsorship();
    answerSourceUsdcTokenAccount(MAINNET_USDC_MINT);
    const productionWallet = required(
      await getDb(env)
        .prepare("SELECT wallet_id FROM custody_wallets WHERE id = ?")
        .bind("cwlt_payments_production")
        .first<{ wallet_id: string }>()
    );
    const transferId = generatePaymentTransferId();
    await createPostgresPaymentsRepository(
      getDb(env),
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PRODUCTION_PROJECT_ID })
    ).createTransfer({
      id: transferId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PRODUCTION_PROJECT_ID,
      custodyWalletId: "cwlt_payments_production",
      walletId: productionWallet.wallet_id,
      counterpartyId: null,
      sourceAddress: productionSigner.address,
      destinationAddress: null,
      token: rampTransferTokenMint("usdc.solana", "mainnet-beta"),
      amount: "1",
      memo: null,
      type: "offramp",
      direction: "outbound",
      status: "awaiting_payment",
      provider: "moonpay",
      providerReference: "moonpay-production-deposit",
      deliveryMode: "hosted",
      fiatCurrency: "USD",
      fiatAmount: "100",
      providerData: {
        cryptoDeposit: {
          destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
          amount: "1.0",
        },
      },
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: TEST_API_KEY.id,
      idempotencyKey: null,
      idempotencyFingerprint: null,
    });
    const quoted = await getDb(env)
      .prepare("SELECT token FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{ token: string }>();
    expect(quoted).toEqual({ token: MAINNET_USDC_MINT });

    const res = await postTransfer(
      {
        transferId,
        sourceCustodyWalletId: "cwlt_payments_production",
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "USDC",
        amount: "1",
      },
      {}
    );

    const responseText = await res.text();
    expect(res.status, responseText).toBe(200);
    expect((await readTransferResponse(new Response(responseText))).data.transfer).toMatchObject({
      id: transferId,
      status: "settling",
    });
  });

  // Jina (#2334): past the key's record, the deposit row answered the same key
  // with a changed memo, because recovery compared only the on-chain fields.
  it("compares a funded deposit's retry by the fingerprint its key recorded", async () => {
    const transferId = generatePaymentTransferId();
    const repository = createPostgresPaymentsRepository(
      getDb(env),
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
    );
    await repository.createTransfer({
      id: transferId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      counterpartyId: null,
      sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
      destinationAddress: null,
      token: SOL_MINT,
      amount: "1",
      memo: null,
      type: "offramp",
      direction: "outbound",
      status: "awaiting_payment",
      provider: "moonpay",
      providerReference: "moonpay-ramp-deposit-fingerprint",
      deliveryMode: "hosted",
      fiatCurrency: "USD",
      fiatAmount: "100",
      providerData: {
        cryptoDeposit: { destinationAddress: TEST_SOLANA_ADDRESSES.wallet2, amount: "1.0" },
      },
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: TEST_API_KEY.id,
      idempotencyKey: null,
      idempotencyFingerprint: null,
    });
    const idempotencyKey = crypto.randomUUID();
    const request = {
      transferId,
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "1",
      memo: "first",
    };
    const funded = await postTransfer(request, { idempotencyKey });
    expect(funded.status, await funded.clone().text()).toBe(200);
    // The shared record expires; the deposit row is what answers now.
    await getDb(env)
      .prepare(
        "UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE idempotency_key = ?"
      )
      .bind(idempotencyKey)
      .run();
    const sendsBefore = sendTransactionMock.mock.calls.length;

    const changed = await postTransfer({ ...request, memo: "changed" }, { idempotencyKey });
    expect(changed.status).toBe(422);
    expect(((await changed.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_KEY_REUSED"
    );

    const same = await postTransfer(request, { idempotencyKey });
    expect(same.status).toBe(200);
    expect(same.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await readTransferResponse(same)).data.transfer.id).toBe(transferId);
    expect(sendTransactionMock.mock.calls.length).toBe(sendsBefore);
  });

  it("refuses to fund an off-ramp deposit at a provider outside the release channel", async () => {
    const transferId = generatePaymentTransferId();
    const repository = createPostgresPaymentsRepository(
      getDb(env),
      createTenantScope({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      })
    );
    await repository.createTransfer({
      id: transferId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      counterpartyId: null,
      sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
      destinationAddress: null,
      token: SOL_MINT,
      amount: "1",
      memo: null,
      type: "offramp",
      direction: "outbound",
      status: "awaiting_payment",
      provider: "moonpay",
      providerReference: "moonpay-excluded-deposit",
      deliveryMode: "hosted",
      fiatCurrency: "USD",
      fiatAmount: "100",
      providerData: {
        cryptoDeposit: { destinationAddress: TEST_SOLANA_ADDRESSES.wallet2, amount: "1.0" },
      },
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: TEST_API_KEY.id,
      idempotencyKey: null,
      idempotencyFingerprint: null,
    });

    // Every ramp provider is `experimental` today, so `stable` leaves MoonPay out.
    const res = await postTransfer(
      {
        transferId,
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
      },
      { releaseChannel: "stable" }
    );

    expect(res.status).toBe(403);
    const rows = await listTransferRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: transferId, status: "awaiting_payment" });
    expect(rows[0]?.signature).toBeFalsy();
  });

  it("persists a signed outbox for an SPL transfer", async () => {
    answerSourceUsdcTokenAccount(DEVNET_USDC_MINT);

    const res = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: DEVNET_USDC_MINT,
        amount: "1",
      },
      {}
    );

    expect(res.status).toBe(200);
    const body = await readTransferResponse(res);
    expect(body.data.transfer.status).toBe("confirmed");
    expect(body.data.transfer.signature).toBeTruthy();
  });

  it("builds a Production project's USDC transfer on mainnet-beta with the mainnet mint", async () => {
    const productionSigner = await generateKeyPairSigner();
    createOrgSignerForCustodyWalletMock.mockResolvedValue(productionSigner);
    await seedProductionPrivyWallet({
      custodyWalletId: "cwlt_payments_production",
      publicKey: productionSigner.address,
    });
    await enableMainnetSponsorship();
    answerSourceUsdcTokenAccount(MAINNET_USDC_MINT);

    const res = await postTransfer(
      {
        sourceCustodyWalletId: "cwlt_payments_production",
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "USDC",
        amount: "1",
      },
      {}
    );

    expect(res.status).toBe(200);
    expect(rpc.calls).toContainEqual({
      cluster: "mainnet-beta",
      method: "getTokenAccountsByOwner",
    });
    expect(rpc.calls.filter((call) => call.cluster === "devnet")).toEqual([]);
    const stored = await getDb(env)
      .prepare("SELECT project_id, token FROM payment_transfers WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .all<{ project_id: string; token: string }>();
    expect(stored.results).toEqual([
      { project_id: TEST_PRODUCTION_PROJECT_ID, token: MAINNET_USDC_MINT },
    ]);
  });

  it("marks the transfer as failed when execution throws and returns 502", async () => {
    createFeePaymentAdapterMock.mockReturnValueOnce({
      providerId: "mock",
      getFeePayer: vi.fn().mockRejectedValue(new Error("RPC connection refused")),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue({
        ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
        signerAddress: TEST_MOCK_FEE_PAYER,
      }),
      signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
      signAndSend: vi.fn(),
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

    const res = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
      },
      {}
    );

    expect(res.status).toBe(502);
    const body = await readErrorResponse(res);
    expect(body.error.code).toBe("SOLANA_RPC_ERROR");

    const transfers = await listTransferRows();
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.status).toBe("failed");
    expect(transfers[0]?.error).toBeTruthy();
  });

  it("returns 400 ACCOUNT_FROZEN when the source SPL token account is frozen", async () => {
    answerSourceUsdcTokenAccount(DEVNET_USDC_MINT);
    sendTransactionMock.mockRejectedValueOnce(
      new Error(
        "Failed to send transaction: RPC Error -32000: Invalid transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x11"
      )
    );
    createFeePaymentAdapterMock.mockReturnValueOnce({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_MOCK_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue({
        ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
        signerAddress: TEST_MOCK_FEE_PAYER,
      }),
      signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
      signAndSend: vi.fn(),
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

    const res = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: DEVNET_USDC_MINT,
        amount: "1",
      },
      {}
    );

    expect(res.status).toBe(400);
    const body = await readErrorResponse(res);
    expect(body.error.code).toBe("ACCOUNT_FROZEN");

    const transfers = await listTransferRows();
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.status).toBe("failed");
    expect(transfers[0]?.error).toBeTruthy();
  });
});
