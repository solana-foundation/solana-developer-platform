import { MEMO_PROGRAM_ADDRESS } from "@sdp/types/well-known-programs";
import { SOL_MINT, SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import {
  address,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  getTransactionDecoder,
} from "@solana/kit";
import {
  findMintConfigPda,
  findThawExtraMetasAccountPda,
  getMintConfigEncoder,
  TOKEN_ACL_PROGRAM_ADDRESS,
} from "@solana/token-acl-sdk";
import {
  AccountState,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  type ExtensionArgs,
  findAssociatedTokenPda,
  getExtraAccountMetasEncoder,
  getMintEncoder,
  getTransferCheckedWithFeeInstructionDataDecoder,
} from "@solana-program/token-2022";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { generatePaymentTransferId } from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { createTenantScope } from "@/lib/tenant-scope";
import { AuditService } from "@/services/audit.service";
import { moonpayWebhook } from "@/services/ramps/webhooks/moonpay";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  installClusterRpcResponder,
  type JsonRpcResult,
  tokenAccountsByOwnerResult,
} from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  confirmTransactionMock,
  createKoraAdapterMock,
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
  testKoraAdapter,
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
import { fullySignTestTransaction } from "@/test/helpers/sponsor-signing";
import {
  answerMovementAccounts,
  associatedTokenAccount,
  encodedRpcAccount,
  mintRpcAccount,
  sentInstructions,
  tokenRpcAccount,
  transferFeeExtension,
} from "@/test/helpers/token-movement";

function testProjectPaymentsRepository() {
  return createPostgresPaymentsRepository(
    getDb(env),
    createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
  );
}

/** An off-ramp awaiting its 1 SOL deposit to wallet2, as a MoonPay sell leaves it. */
async function seedSolOfframpDeposit(transferId: string) {
  await testProjectPaymentsRepository().createTransfer({
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
}

function solOfframpDepositRequest(transferId: string) {
  return {
    transferId,
    sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
    destination: TEST_SOLANA_ADDRESSES.wallet2,
    token: "SOL",
    amount: "1",
  };
}

describe("Payments routes — on-chain transfers", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcResponder();

  function answerSourceUsdcTokenAccount(mint: string) {
    answerMovementAccounts(
      rpc,
      new Map([[mint, mintRpcAccount("spl-token", { decimals: 6, extensions: null })]])
    );
    rpc.answer(
      "getTokenAccountsByOwner",
      tokenAccountsByOwnerResult(1, [
        {
          pubkey: TEST_SOLANA_ADDRESSES.wallet3,
          mint,
          amount: "1000000000",
          decimals: 6,
          uiAmountString: "1000",
          state: "initialized",
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

  it("refuses a USDC amount finer than its decimals before creating a transfer record", async () => {
    // The mint's live terms say how many decimals an amount may carry (ADR 0012).
    answerSourceUsdcTokenAccount(DEVNET_USDC_MINT);
    const res = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: DEVNET_USDC_MINT,
        amount: "1.0000001",
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

  it("executes a SOL transfer, waits for finalization, and returns a finalized transfer record", async () => {
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
    expect(body.data.transfer.status).toBe("finalized");
    expect(body.data.transfer.id).toMatch(/^xfr_/);
    expect(body.data.transfer.signature).toBeTruthy();
    expect(confirmTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      body.data.transfer.signature,
      { commitment: "finalized" }
    );

    const row = await readTransferRow(body.data.transfer.id);
    expect(row.status).toBe("finalized");
    expect(row.signature).toBeTruthy();
    expect(row.confirmed_at).not.toBeNull();
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
    await seedSolOfframpDeposit(transferId);

    const requestBody = JSON.stringify(solOfframpDepositRequest(transferId));
    const res = await postTransfer(JSON.parse(requestBody), {});

    const responseText = await res.text();
    expect(res.status, responseText).toBe(200);
    const body = await readTransferResponse(new Response(responseText));
    expect(body.data.transfer).toMatchObject({
      id: transferId,
      status: "settling",
    });
    expect(body.data.transfer.signature).toBeTruthy();
    expect(confirmTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      body.data.transfer.signature,
      { commitment: "confirmed" }
    );

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

  it("rejects a deposit after MoonPay fails the sale", async () => {
    const transferId = generatePaymentTransferId();
    await seedSolOfframpDeposit(transferId);
    expect(
      await moonpayWebhook.process(env, "sandbox", {
        provider: "moonpay",
        kind: "failed",
        rampType: "offramp",
        reference: "moonpay-ramp-deposit",
        transferId,
        providerObservedAt: "2026-08-31T11:01:00.000Z",
      })
    ).toEqual({ outcome: "refused", reason: "moonpay_sell_failed" });

    const staleClaim = await testProjectPaymentsRepository().updateOnchainTransferForRamp({
      transferId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      token: SOL_MINT,
      credit: "1",
      initiatedByKeyId: TEST_API_KEY.id,
      idempotency: null,
      updatedAt: new Date().toISOString(),
    });
    expect(staleClaim).toBeNull();

    const response = await postTransfer(solOfframpDepositRequest(transferId), {});
    expect(response.status).toBe(400);
    expect(sendTransactionMock).not.toHaveBeenCalled();
    const row = await readTransferRow(transferId);
    expect(row.status).toBe("failed");
    expect(row.provider_reference).toBe("moonpay-ramp-deposit");
    expect(row.provider_data.cryptoDeposit).toBeNull();
  });

  it("returns a claimed off-ramp deposit to awaiting it when audit-ledger admission is refused", async () => {
    const transferId = generatePaymentTransferId();
    await seedSolOfframpDeposit(transferId);
    const beginSpy = vi
      .spyOn(AuditService.prototype, "beginCritical")
      .mockRejectedValueOnce(new Error("audit ledger unavailable"));

    try {
      const res = await postTransfer(solOfframpDepositRequest(transferId), {});
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(sendTransactionMock).not.toHaveBeenCalled();

      const row = await readTransferRow(transferId);
      expect(row.status).toBe("awaiting_payment");
      expect(row.destination_address).toBeNull();
    } finally {
      beginSpy.mockRestore();
    }
  });

  it("keeps a deposit the provider completed mid-send at settling", async () => {
    const transferId = generatePaymentTransferId();
    await seedSolOfframpDeposit(transferId);
    sendTransactionMock.mockImplementationOnce(async (_rpc, transactionBytes) => {
      await testProjectPaymentsRepository().transitionRampTransfer({
        transferId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        transition: "provider_settled",
        updatedAt: new Date().toISOString(),
      });
      return getSignatureFromTransaction(getTransactionDecoder().decode(transactionBytes));
    });

    const res = await postTransfer(solOfframpDepositRequest(transferId), {});

    expect(res.status, await res.text()).toBe(200);
    expect((await readTransferRow(transferId)).status).toBe("settling");
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
      token: MAINNET_USDC_MINT,
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
    expect(body.data.transfer.status).toBe("finalized");
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
    createKoraAdapterMock.mockReturnValueOnce(
      testKoraAdapter({
        getFeePayer: vi.fn().mockRejectedValue(new Error("RPC connection refused")),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
        signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
      })
    );

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

  describe("token movements (ADR 0012)", () => {
    const pyusd = WELL_KNOWN_TOKENS.PYUSD.mints.devnet.address;
    const usdc = DEVNET_USDC_MINT;

    function answerPyusd(options: {
      extensions: ExtensionArgs[];
      destination?: { extensions: ExtensionArgs[] };
    }) {
      return associatedTokenAccount("token-2022", pyusd, TEST_SOLANA_ADDRESSES.wallet2).then(
        (destinationAccount) => {
          const accounts = new Map<string, JsonRpcResult>([
            [pyusd, mintRpcAccount("token-2022", { decimals: 6, extensions: options.extensions })],
          ]);
          if (options.destination !== undefined) {
            accounts.set(
              destinationAccount,
              tokenRpcAccount("token-2022", {
                mint: pyusd,
                owner: TEST_SOLANA_ADDRESSES.wallet2,
                amount: 0n,
                extensions: options.destination.extensions,
              })
            );
          }
          answerMovementAccounts(rpc, accounts);
          rpc.answer(
            "getTokenAccountsByOwner",
            tokenAccountsByOwnerResult(1, [
              {
                pubkey: TEST_SOLANA_ADDRESSES.wallet3,
                mint: pyusd,
                amount: "1000000000",
                decimals: 6,
                uiAmountString: "1000",
                state: "initialized",
              },
            ])
          );
          return destinationAccount;
        }
      );
    }

    const lastSentInstructions = () => {
      const [, transactionBytes] = required(sendTransactionMock.mock.calls.at(-1));
      return sentInstructions(transactionBytes);
    };

    it("answers a SOL transfer with its amounts, verified once it lands", async () => {
      const res = await postTransfer(
        {
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "SOL",
          amount: "1.5",
        },
        {}
      );

      expect(res.status).toBe(200);
      expect((await readTransferResponse(res)).data.transfer).toMatchObject({
        status: "finalized",
        amount: "1.5",
        amounts: { basis: "debit", debit: "1.5", fee: "0", credit: "1.5", decimals: 9 },
        amountVerification: { state: "verified", reason: "sdp_built_transfer_landed" },
      });
      expect(rpc.calls.filter((call) => call.method === "getMultipleAccounts")).toEqual([]);
    });

    it("moves a fee mint with TransferCheckedWithFee, grossing up a credit, in two reads", async () => {
      await answerPyusd({ extensions: [transferFeeExtension(50, 1_000_000n)] });

      const res = await postTransfer(
        {
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "PYUSD",
          amount: "0.995",
          amountBasis: "credit",
        },
        {}
      );

      const text = await res.text();
      expect(res.status, text).toBe(200);
      expect((await readTransferResponse(new Response(text))).data.transfer).toMatchObject({
        token: pyusd,
        amount: "1",
        amounts: { basis: "credit", debit: "1", fee: "0.005", credit: "0.995", decimals: 6 },
        amountVerification: { state: "verified" },
      });
      const transfer = required(
        lastSentInstructions().find(
          (instruction) => instruction.programAddress === SPL_TOKEN_PROGRAMS["token-2022"]
        )
      );
      expect(
        getTransferCheckedWithFeeInstructionDataDecoder().decode(required(transfer.data))
      ).toMatchObject({ amount: 1_000_000n, decimals: 6, fee: 5_000n });
      expect(
        rpc.calls
          .map((call) => call.method)
          .filter(
            (method) => method === "getMultipleAccounts" || method === "getTokenAccountsByOwner"
          )
          .sort()
      ).toEqual(["getMultipleAccounts", "getTokenAccountsByOwner"]);
    });

    it("refuses an amount the mint cannot hold before writing a row, so the key is not spent", async () => {
      answerSourceUsdcTokenAccount(usdc);
      const idempotencyKey = crypto.randomUUID();
      const request = {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "USDC",
        amount: "1.0000001",
      };

      const refused = await postTransfer(request, { idempotencyKey });

      expect(refused.status).toBe(400);
      expect(await countTransferRows()).toBe(0);
      expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
      const retried = await postTransfer({ ...request, amount: "1" }, { idempotencyKey });
      expect(retried.status).toBe(200);
    });

    it("refuses a paused mint before writing a row", async () => {
      await answerPyusd({
        extensions: [
          {
            __kind: "PausableConfig",
            authority: address(TEST_SOLANA_ADDRESSES.wallet1),
            paused: true,
          },
        ],
      });

      const refused = await postTransfer(
        {
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "PYUSD",
          amount: "1",
        },
        {}
      );

      expect(refused.status).toBe(400);
      expect((await readErrorResponse(refused)).error).toMatchObject({
        code: "BAD_REQUEST",
        details: { reason: "paused" },
      });
      expect(await countTransferRows()).toBe(0);
    });

    it("thaws a new destination of a Token ACL mint right after creating it", async () => {
      const mint = address(pyusd);
      const gate = (await generateKeyPairSigner()).address;
      const [mintConfig] = await findMintConfigPda(
        { mint },
        { programAddress: TOKEN_ACL_PROGRAM_ADDRESS }
      );
      const [thawList] = await findThawExtraMetasAccountPda({ mint }, { programAddress: gate });
      await answerPyusd({ extensions: [] });
      answerMovementAccounts(
        rpc,
        new Map([
          [
            pyusd,
            encodedRpcAccount(
              SPL_TOKEN_PROGRAMS["token-2022"],
              getMintEncoder().encode({
                mintAuthority: mintConfig,
                supply: 1_000_000_000_000n,
                decimals: 6,
                isInitialized: true,
                freezeAuthority: mintConfig,
                extensions: [{ __kind: "DefaultAccountState", state: AccountState.Frozen }],
              })
            ),
          ],
        ])
      );
      const aclAccounts = new Map<string, JsonRpcResult>([
        [
          mintConfig,
          encodedRpcAccount(
            TOKEN_ACL_PROGRAM_ADDRESS,
            getMintConfigEncoder().encode({
              bump: 255,
              enablePermissionlessThaw: true,
              enablePermissionlessFreeze: false,
              mint,
              freezeAuthority: address(TEST_SOLANA_ADDRESSES.wallet1),
              gatingProgram: gate,
            })
          ),
        ],
        [thawList, encodedRpcAccount(gate, getExtraAccountMetasEncoder().encode([]))],
      ]);
      rpc.respond("getAccountInfo", (request) => ({
        result: {
          context: { slot: 1 },
          value: aclAccounts.get(z.string().parse(request.params[0])) ?? null,
        },
      }));

      const res = await postTransfer(
        {
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "PYUSD",
          amount: "1",
        },
        {}
      );

      expect(res.status, await res.clone().text()).toBe(200);
      expect(lastSentInstructions().map((instruction) => instruction.programAddress)).toEqual([
        ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
        TOKEN_ACL_PROGRAM_ADDRESS,
        SPL_TOKEN_PROGRAMS["token-2022"],
      ]);
      expect(
        rpc.requests
          .filter((request) => request.method === "getAccountInfo")
          .map((request) => request.params[0])
      ).toEqual([mintConfig, thawList]);
    });

    it("refuses a frozen-by-default mint with no freeze authority before writing a row", async () => {
      await answerPyusd({
        extensions: [{ __kind: "DefaultAccountState", state: AccountState.Frozen }],
      });

      const refused = await postTransfer(
        {
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "PYUSD",
          amount: "1",
        },
        {}
      );

      expect(refused.status).toBe(400);
      expect((await readErrorResponse(refused)).error.details).toEqual({
        reason: "default_frozen",
      });
      expect(await countTransferRows()).toBe(0);
    });

    it("sends the memo a memo-required destination needs, and refuses the transfer without one", async () => {
      const destinationAccount = await answerPyusd({
        extensions: [],
        destination: {
          extensions: [
            { __kind: "ImmutableOwner" },
            { __kind: "MemoTransfer", requireIncomingTransferMemos: true },
          ],
        },
      });
      const request = {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "PYUSD",
        amount: "1",
      };

      const refused = await postTransfer(request, {});
      expect(refused.status).toBe(400);
      expect((await readErrorResponse(refused)).error.details).toEqual({ reason: "memo_required" });
      expect(await countTransferRows()).toBe(0);

      const sent = await postTransfer({ ...request, memo: "invoice 42" }, {});
      expect(sent.status).toBe(200);
      const instructions = lastSentInstructions();
      const transferIndex = instructions.findIndex(
        (instruction) =>
          instruction.programAddress === SPL_TOKEN_PROGRAMS["token-2022"] &&
          instruction.accounts.includes(destinationAccount)
      );
      expect(instructions[transferIndex - 1]).toMatchObject({
        programAddress: MEMO_PROGRAM_ADDRESS,
        data: new TextEncoder().encode("invoice 42"),
      });
    });

    it("refuses the wrapped SOL mint with a 400 before reading the chain", async () => {
      const wrapped = await postTransfer(
        {
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: SOL_MINT,
          amount: "1",
        },
        {}
      );

      // Rows and balances store native SOL under the wrapped SOL mint, so a wrapped SOL move
      // would read back as native SOL: the caller names native SOL as "SOL".
      expect(wrapped.status).toBe(400);
      expect((await readErrorResponse(wrapped)).error.message).toBe(
        'Payments does not move wrapped SOL: send token "SOL" to move native SOL'
      );
      expect(sendTransactionMock).not.toHaveBeenCalled();
      expect(rpc.calls).toEqual([]);
      expect(await countTransferRows()).toBe(0);
    });

    it("refuses a transfer into the source's own token account, which would move nothing", async () => {
      const [ownAccount] = await findAssociatedTokenPda({
        owner: address(TEST_SOLANA_ADDRESSES.wallet1),
        mint: address(DEVNET_USDC_MINT),
        tokenProgram: address(SPL_TOKEN_PROGRAMS["spl-token"]),
      });
      answerMovementAccounts(
        rpc,
        new Map([
          [DEVNET_USDC_MINT, mintRpcAccount("spl-token", { decimals: 6, extensions: null })],
        ])
      );
      rpc.answer(
        "getTokenAccountsByOwner",
        tokenAccountsByOwnerResult(1, [
          {
            pubkey: ownAccount,
            mint: DEVNET_USDC_MINT,
            amount: "1000000000",
            decimals: 6,
            uiAmountString: "1000",
            state: "initialized",
          },
        ])
      );

      const res = await postTransfer(
        {
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet1,
          token: DEVNET_USDC_MINT,
          amount: "1",
        },
        {}
      );

      expect(res.status).toBe(400);
      expect((await readErrorResponse(res)).error.message).toBe(
        "The destination is the source account: the transfer would move nothing"
      );
      expect(sendTransactionMock).not.toHaveBeenCalled();
      expect(await countTransferRows()).toBe(0);
    });

    it("refuses native SOL sent to the source wallet itself", async () => {
      const res = await postTransfer(
        {
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet1,
          token: "SOL",
          amount: "1",
        },
        {}
      );

      expect(res.status).toBe(400);
      expect((await readErrorResponse(res)).error.message).toBe(
        "The destination is the source account: the transfer would move nothing"
      );
      expect(await countTransferRows()).toBe(0);
    });
  });

  it("returns 400 ACCOUNT_FROZEN when the source SPL token account is frozen", async () => {
    answerSourceUsdcTokenAccount(DEVNET_USDC_MINT);
    sendTransactionMock.mockRejectedValueOnce(
      new Error(
        "Failed to send transaction: RPC Error -32000: Invalid transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x11"
      )
    );

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
