import { FeePaymentError } from "@sdp/fee-payment/port";
import { SDP_RAMP_PROVIDER_MATURITY } from "@sdp/types/release-channels";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import {
  generateKeyPairSigner,
  getSignatureFromTransaction,
  getTransactionDecoder,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { getDb } from "@/db/client";
import { generatePaymentTransferId } from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { createTenantScope } from "@/lib/tenant-scope";
import { AuditService } from "@/services/audit.service";
import { INSUFFICIENT_FUNDS_MESSAGE } from "@/services/fee-payment-errors";
import { moonpayWebhook } from "@/services/ramps/webhooks/moonpay";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcStub, tokenAccountsByOwnerResult } from "@/test/helpers/cluster-rpc";
import { seedProjectCryptoWalletCounterparty } from "@/test/helpers/counterparties";
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
  TEST_USER,
  TEST_WALLET_ID,
  testKoraAdapter,
} from "@/test/helpers/payments-routes";
import {
  countTransferRows,
  listTransferRows,
  postTransfer,
  readErrorResponse,
  readTransferResponse,
  readTransferRow,
} from "@/test/helpers/payments-transfers";
import { required } from "@/test/helpers/required";
import { TEST_MOCK_FEE_PAYER } from "@/test/helpers/sponsor-signing";

/**
 * An off-ramp awaiting its 1-unit deposit to wallet2, as a MoonPay sell leaves it. Defaults to a
 * SOL sale from the Sandbox project's wallet.
 */
async function seedOfframpDeposit(deposit: {
  transferId: string;
  projectId?: string;
  custodyWalletId?: string;
  walletId?: string;
  sourceAddress?: string;
  token?: string;
  providerReference?: string;
}) {
  const projectId = deposit.projectId ?? TEST_PROJECT.id;
  await createPostgresPaymentsRepository(
    getDb(env),
    createTenantScope({ organizationId: TEST_ORG.id, projectId })
  ).createTransfer({
    id: deposit.transferId,
    organizationId: TEST_ORG.id,
    projectId,
    custodyWalletId: deposit.custodyWalletId ?? TEST_CUSTODY_WALLET_ID,
    walletId: deposit.walletId ?? TEST_WALLET_ID,
    counterpartyId: null,
    sourceAddress: deposit.sourceAddress ?? TEST_SOLANA_ADDRESSES.wallet1,
    destinationAddress: null,
    token: deposit.token ?? SOL_MINT,
    amount: "1",
    memo: null,
    type: "offramp",
    direction: "outbound",
    status: "awaiting_payment",
    provider: "moonpay",
    providerReference: deposit.providerReference ?? "moonpay-ramp-deposit",
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

const SOL_TRANSFER = {
  sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
  destination: TEST_SOLANA_ADDRESSES.wallet2,
  token: "SOL",
  amount: "1",
};

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
          state: "initialized",
        },
      ])
    );
  }

  it("blocks create transfer with zero amount before creating a transfer record", async () => {
    const res = await postTransfer({ ...SOL_TRANSFER, amount: "0" }, {});

    expect(res.status).toBe(400);
    const body = await readErrorResponse(res);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Invalid request body");
    expect(body.error.message).toContain("Amount must be greater than zero");

    expect(await countTransferRows()).toBe(0);
  });

  it("refuses a USDC amount finer than its decimals before creating a transfer record", async () => {
    const res = await postTransfer(
      { ...SOL_TRANSFER, token: DEVNET_USDC_MINT, amount: "1.0000001" },
      {}
    );

    expect(res.status).toBe(400);
    const body = await readErrorResponse(res);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).not.toHaveBeenCalled();
    expect(await countTransferRows()).toBe(0);
  });

  describe("native SOL below the rent-exempt minimum (HOO-2375)", () => {
    const account = (lamports: number) => ({
      data: ["", "base64"],
      executable: false,
      lamports,
      owner: "11111111111111111111111111111111",
      rentEpoch: 0,
      space: 0,
    });

    it.each([
      {
        case: "pays less than the minimum to an address with no account",
        amount: "0.0001",
        // The small destination, then the source.
        accounts: [null, account(5_000_000_000)],
        fundedAccounts: [account(5_000_000_000), account(5_000_000_000)],
        details: { recipientIndexes: [0], sourceRemainder: null },
      },
      {
        case: "would leave the source wallet below the minimum",
        amount: "0.5",
        accounts: [account(500_300_000)],
        fundedAccounts: [account(5_000_000_000)],
        details: { recipientIndexes: [], sourceRemainder: "0.0003" },
      },
    ])(
      "refuses a transfer that $case with a 409 that leaves its key free for a retry",
      async ({ amount, accounts, fundedAccounts, details }) => {
        rpc.answer("getMultipleAccounts", { context: { slot: 1 }, value: accounts });
        const request = { ...SOL_TRANSFER, amount };

        const res = await postTransfer(request, { idempotencyKey: "rent-minimum-refusal" });

        expect(res.status).toBe(409);
        const body = await readErrorResponse(res);
        expect(body.error.code).toBe("AMOUNT_BELOW_RENT_MINIMUM");
        expect(body.error.details).toMatchObject({ ...details, minimumAmount: "0.00089088" });
        expect(sendTransactionMock).not.toHaveBeenCalled();
        expect(await countTransferRows()).toBe(0);

        rpc.answer("getMultipleAccounts", { context: { slot: 1 }, value: fundedAccounts });
        const retried = await postTransfer(request, { idempotencyKey: "rent-minimum-refusal" });

        expect(retried.status).toBe(200);
        expect(retried.headers.get("Idempotent-Replayed")).toBeNull();
        expect(await countTransferRows()).toBe(1);
      }
    );
  });

  it("executes a SOL transfer, waits for finalization, and records it finalized", async () => {
    const res = await postTransfer(SOL_TRANSFER, {});

    expect(res.status).toBe(200);
    const { transfer } = (await readTransferResponse(res)).data;
    expect(transfer.id).toMatch(/^xfr_/);
    // The sponsor paid the network fee, so the source wallet paid none (HOO-2614).
    expect(transfer).toMatchObject({ status: "finalized", fee: 0 });
    expect(transfer.signature).toEqual(expect.any(String));
    expect(confirmTransactionMock).toHaveBeenCalledWith(expect.anything(), transfer.signature, {
      commitment: "finalized",
    });

    const row = await readTransferRow(transfer.id);
    expect(row).toMatchObject({
      status: "finalized",
      signature: transfer.signature,
      custody_wallet_id: TEST_CUSTODY_WALLET_ID,
      source_address: TEST_SOLANA_ADDRESSES.wallet1,
      destination_address: TEST_SOLANA_ADDRESSES.wallet2,
      token: SOL_MINT,
      amount: "1",
      fee: 0,
    });
    expect(row.confirmed_at).not.toBeNull();
  });

  it("ties the transfer to the contact whose account it names", async () => {
    await seedProjectCryptoWalletCounterparty(getDb(env), {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      createdBy: TEST_USER.id,
      counterpartyId: "cpty_named_payee",
      counterpartyAccountId: "cpacct_named_payee",
      walletAddress: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const res = await postTransfer(
      { ...SOL_TRANSFER, counterpartyAccountId: "cpacct_named_payee" },
      {}
    );

    expect(res.status).toBe(200);
    const body = await readTransferResponse(res);
    expect(body.data.transfer.counterpartyId).toBe("cpty_named_payee");
    expect((await readTransferRow(body.data.transfer.id)).counterparty_id).toBe("cpty_named_payee");
  });

  it("refuses a contact account from another project before writing anything", async () => {
    await seedProjectCryptoWalletCounterparty(getDb(env), {
      organizationId: TEST_ORG.id,
      projectId: TEST_PRODUCTION_PROJECT_ID,
      createdBy: TEST_USER.id,
      counterpartyId: "cpty_other_project",
      counterpartyAccountId: "cpacct_other_project",
      walletAddress: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const res = await postTransfer(
      { ...SOL_TRANSFER, counterpartyAccountId: "cpacct_other_project" },
      {}
    );

    expect(res.status).toBe(404);
    expect((await readErrorResponse(res)).error).toMatchObject({
      code: "NOT_FOUND",
      message: "Counterparty account cpacct_other_project not found",
    });
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(await countTransferRows()).toBe(0);
  });

  it("refuses a contact account whose address is not the destination", async () => {
    await seedProjectCryptoWalletCounterparty(getDb(env), {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      createdBy: TEST_USER.id,
      counterpartyId: "cpty_elsewhere",
      counterpartyAccountId: "cpacct_elsewhere",
      walletAddress: TEST_SOLANA_ADDRESSES.wallet3,
    });

    const res = await postTransfer(
      { ...SOL_TRANSFER, counterpartyAccountId: "cpacct_elsewhere" },
      {}
    );

    expect(res.status).toBe(400);
    expect((await readErrorResponse(res)).error).toMatchObject({
      code: "BAD_REQUEST",
      message: "destination must be the address of the counterpartyAccountId account",
    });
    expect(sendTransactionMock).not.toHaveBeenCalled();
    expect(await countTransferRows()).toBe(0);
  });

  it("appends a tamper-evident audit intent and outcome for an executed transfer", async () => {
    const res = await postTransfer(SOL_TRANSFER, {});
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
      sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      tokenMint: SOL_MINT,
      amount: "1",
      slot: "100",
    });

    const intent = required(
      await getDb(env)
        .prepare(
          `SELECT resource_id, metadata FROM audit_logs
           WHERE action = 'maintenance' AND resource_type = 'audit_ledger'
             AND metadata::jsonb -> 'target' ->> 'resourceId' = ?`
        )
        .bind(body.data.transfer.id)
        .first<{ resource_id: string; metadata: string }>()
    );
    expect(outcomeMetadata.auditIntentId).toBe(intent.resource_id);
    const intentTarget = (
      JSON.parse(intent.metadata) as { target?: { metadata?: Record<string, unknown> } }
    ).target?.metadata;
    expect(intentTarget).toMatchObject({
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      tokenMint: SOL_MINT,
      amount: "1",
    });
  });

  it("settles the transfer as failed when audit-ledger admission is refused", async () => {
    const beginSpy = vi
      .spyOn(AuditService.prototype, "beginCriticalWithin")
      .mockRejectedValueOnce(new Error("audit ledger unavailable"));

    try {
      const res = await postTransfer(SOL_TRANSFER, {});
      expect(res.status).toBe(500);
      expect(sendTransactionMock).not.toHaveBeenCalled();

      // The processing row must not survive as a replayable success: a ledger
      // refusal settles it failed instead of stranding it.
      expect(await listTransferRows()).toEqual([
        expect.objectContaining({
          status: "failed",
          error: "Audit ledger admission failed before execution",
        }),
      ]);
    } finally {
      beginSpy.mockRestore();
    }
  });

  it("fails a transfer whose execution breaks before submission with a 502 and a failure audit outcome", async () => {
    createOrgSignerForCustodyWalletMock.mockRejectedValueOnce(new Error("signer unavailable"));

    const res = await postTransfer(SOL_TRANSFER, {});

    expect(res.status).toBe(502);
    expect((await readErrorResponse(res)).error.code).toBe("SOLANA_RPC_ERROR");
    expect(sendTransactionMock).not.toHaveBeenCalled();
    const transfers = await listTransferRows();
    expect(transfers).toEqual([
      expect.objectContaining({ status: "failed", error: "signer unavailable" }),
    ]);
    const outcome = await getDb(env)
      .prepare(
        `SELECT status, metadata FROM audit_logs
         WHERE action = 'transfer' AND resource_type = 'payment_transfer' AND resource_id = ?`
      )
      .bind(required(transfers[0]).id)
      .first<{ status: string; metadata: string }>();
    expect(outcome?.status).toBe("failure");
    expect(JSON.parse(outcome?.metadata ?? "{}").auditPhase).toBe("outcome");
  });

  it("funds an off-ramp deposit on its existing row, and answers a second funding from that row", async () => {
    const transferId = generatePaymentTransferId();
    await seedOfframpDeposit({ transferId });

    const res = await postTransfer(solOfframpDepositRequest(transferId), {});

    expect(res.status).toBe(200);
    const { transfer } = (await readTransferResponse(res)).data;
    expect(transfer).toMatchObject({ id: transferId, status: "settling" });
    expect(confirmTransactionMock).toHaveBeenCalledWith(expect.anything(), transfer.signature, {
      commitment: "confirmed",
    });
    const [row] = await listTransferRows();
    expect(await countTransferRows()).toBe(1);
    expect(row).toMatchObject({
      id: transferId,
      custody_wallet_id: TEST_CUSTODY_WALLET_ID,
      status: "settling",
      destination_address: TEST_SOLANA_ADDRESSES.wallet2,
      signature: transfer.signature,
    });
    expect(row?.signed_transaction).toEqual(expect.any(String));

    // A second request to fund the same deposit (a retry after a crash, or
    // another key) is answered from the funded row and sends nothing again
    // (HOO-1918), instead of a 409 the client could never get past.
    const sendsBefore = sendTransactionMock.mock.calls.length;
    const duplicate = await postTransfer(solOfframpDepositRequest(transferId), {});
    expect(duplicate.status).toBe(200);
    expect((await readTransferResponse(duplicate)).data.transfer).toMatchObject({
      id: transferId,
      signature: transfer.signature,
    });
    expect(sendTransactionMock.mock.calls.length).toBe(sendsBefore);
    expect(await countTransferRows()).toBe(1);
  });

  it("refuses to fund a deposit after MoonPay fails the sale", async () => {
    const transferId = generatePaymentTransferId();
    await seedOfframpDeposit({ transferId });
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

    const response = await postTransfer(solOfframpDepositRequest(transferId), {});

    expect(response.status).toBe(400);
    expect((await readErrorResponse(response)).error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Transfer does not match the off-ramp deposit instruction",
    });
    expect(sendTransactionMock).not.toHaveBeenCalled();
    const row = await readTransferRow(transferId);
    expect(row.status).toBe("failed");
    expect(row.provider_reference).toBe("moonpay-ramp-deposit");
    expect(row.provider_data.cryptoDeposit).toBeNull();
  });

  it("returns a claimed off-ramp deposit to awaiting it when audit-ledger admission is refused, so its key can fund it again", async () => {
    const transferId = generatePaymentTransferId();
    await seedOfframpDeposit({ transferId });
    const beginSpy = vi
      .spyOn(AuditService.prototype, "beginCriticalWithin")
      .mockRejectedValueOnce(new Error("audit ledger unavailable"));

    try {
      const res = await postTransfer(solOfframpDepositRequest(transferId), {
        idempotencyKey: "deposit-audit-refused",
      });
      expect(res.status).toBe(500);
      expect(sendTransactionMock).not.toHaveBeenCalled();
      expect(await readTransferRow(transferId)).toMatchObject({
        status: "awaiting_payment",
        destination_address: null,
      });

      const retried = await postTransfer(solOfframpDepositRequest(transferId), {
        idempotencyKey: "deposit-audit-refused",
      });
      expect(retried.status).toBe(200);
      expect((await readTransferResponse(retried)).data.transfer).toMatchObject({
        id: transferId,
        status: "settling",
      });
    } finally {
      beginSpy.mockRestore();
    }
  });

  it("keeps a deposit the provider completed mid-send at settling", async () => {
    const transferId = generatePaymentTransferId();
    await seedOfframpDeposit({ transferId });
    sendTransactionMock.mockImplementationOnce(async (_rpc, transactionBytes) => {
      await createPostgresPaymentsRepository(
        getDb(env),
        createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
      ).transitionRampTransfer({
        transferId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        transition: "provider_settled",
        updatedAt: new Date().toISOString(),
      });
      return getSignatureFromTransaction(getTransactionDecoder().decode(transactionBytes));
    });

    const res = await postTransfer(solOfframpDepositRequest(transferId), {});

    expect(res.status).toBe(200);
    expect((await readTransferRow(transferId)).status).toBe("settling");
  });

  it("funds a Production off-ramp with the mainnet USDC mint its quote recorded", async () => {
    const productionSigner = await generateKeyPairSigner();
    createOrgSignerForCustodyWalletMock.mockResolvedValue(productionSigner);
    const productionWalletId = await seedProductionPrivyWallet({
      custodyWalletId: "cwlt_payments_production",
      publicKey: productionSigner.address,
    });
    await enableMainnetSponsorship();
    answerSourceUsdcTokenAccount(MAINNET_USDC_MINT);
    const transferId = generatePaymentTransferId();
    await seedOfframpDeposit({
      transferId,
      projectId: TEST_PRODUCTION_PROJECT_ID,
      custodyWalletId: "cwlt_payments_production",
      walletId: productionWalletId,
      sourceAddress: productionSigner.address,
      token: MAINNET_USDC_MINT,
      providerReference: "moonpay-production-deposit",
    });

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

    expect(res.status).toBe(200);
    expect((await readTransferResponse(res)).data.transfer).toMatchObject({
      id: transferId,
      status: "settling",
    });
  });

  // Jina (#2334): past the key's record, the deposit row answered the same key
  // with a changed memo, because recovery compared only the on-chain fields.
  it("compares a funded deposit's retry by the fingerprint its key recorded", async () => {
    const transferId = generatePaymentTransferId();
    await seedOfframpDeposit({ transferId, providerReference: "moonpay-ramp-deposit-fingerprint" });
    const idempotencyKey = crypto.randomUUID();
    const request = { ...solOfframpDepositRequest(transferId), memo: "first" };
    const funded = await postTransfer(request, { idempotencyKey });
    expect(funded.status).toBe(200);
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
    expect((await readErrorResponse(changed)).error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const same = await postTransfer(request, { idempotencyKey });
    expect(same.status).toBe(200);
    expect(same.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await readTransferResponse(same)).data.transfer.id).toBe(transferId);
    expect(sendTransactionMock.mock.calls.length).toBe(sendsBefore);
  });

  it("refuses to fund the deposit of a ramp provider the release channel leaves out", async () => {
    const transferId = generatePaymentTransferId();
    await seedOfframpDeposit({ transferId });
    const app = createApp({
      rampProviderMaturity: { ...SDP_RAMP_PROVIDER_MATURITY, stripe: "stable" },
    });

    const res = await app.request(
      "/v1/payments/transfers/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(solOfframpDepositRequest(transferId)),
      },
      { ...env, SDP_RELEASE_CHANNEL: "stable" }
    );

    expect(res.status).toBe(403);
    expect((await readErrorResponse(res)).error.message).toContain("moonpay");
    expect(await readTransferRow(transferId)).toMatchObject({
      status: "awaiting_payment",
      signature: null,
      destination_address: null,
    });
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });

  it("executes an SPL transfer and records it finalized", async () => {
    answerSourceUsdcTokenAccount(DEVNET_USDC_MINT);

    const res = await postTransfer({ ...SOL_TRANSFER, token: DEVNET_USDC_MINT }, {});

    expect(res.status).toBe(200);
    const { transfer } = (await readTransferResponse(res)).data;
    expect(transfer.status).toBe("finalized");
    expect(await readTransferRow(transfer.id)).toMatchObject({
      status: "finalized",
      signature: transfer.signature,
      token: DEVNET_USDC_MINT,
      amount: "1",
    });
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

  it("returns 400 ACCOUNT_FROZEN when the source SPL token account is frozen, and fails the transfer", async () => {
    answerSourceUsdcTokenAccount(DEVNET_USDC_MINT);
    sendTransactionMock.mockRejectedValueOnce(
      new Error(
        "Failed to send transaction: RPC Error -32000: Invalid transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x11"
      )
    );

    const res = await postTransfer({ ...SOL_TRANSFER, token: DEVNET_USDC_MINT }, {});

    expect(res.status).toBe(400);
    expect((await readErrorResponse(res)).error.code).toBe("ACCOUNT_FROZEN");
    expect(await listTransferRows()).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  describe("a source wallet short of funds (HOO-2621)", () => {
    const koraShortfall = (instructionIndex: number) =>
      new FeePaymentError(
        `Failed to sign transaction as fee payer: Kora Error -32000: Invalid transaction: Transaction simulation failed: Error processing Instruction ${instructionIndex}: custom program error: 0x1`,
        "PROVIDER_REJECTED"
      );

    function sponsorRefuses(error: FeePaymentError) {
      createKoraAdapterMock.mockReturnValue(
        testKoraAdapter({
          getFeePayer: vi.fn().mockResolvedValue(TEST_MOCK_FEE_PAYER),
          getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
          signAsFeePayer: vi.fn().mockRejectedValue(error),
        })
      );
    }

    function expectTenantSafe(message: string) {
      expect(message).toBe(INSUFFICIENT_FUNDS_MESSAGE);
      expect(message).not.toMatch(/kora|simulation|fee payer|program error/i);
    }

    it("answers an SPL transfer 400 TRANSACTION_FAILED, records why, and replays the same error", async () => {
      answerSourceUsdcTokenAccount(DEVNET_USDC_MINT);
      // Instruction 1 is the token transfer; instruction 0 creates the destination account.
      sponsorRefuses(koraShortfall(1));
      const request = { ...SOL_TRANSFER, token: DEVNET_USDC_MINT, amount: "500" };

      const res = await postTransfer(request, { idempotencyKey: "hoo-2621-spl-shortfall" });

      expect(res.status).toBe(400);
      const body = await readErrorResponse(res);
      expect(body.error.code).toBe("TRANSACTION_FAILED");
      expectTenantSafe(body.error.message);
      const transfers = await listTransferRows();
      expect(transfers).toHaveLength(1);
      expect(transfers[0]?.status).toBe("failed");
      expectTenantSafe(required(transfers[0]?.error));

      const replay = await postTransfer(request, { idempotencyKey: "hoo-2621-spl-shortfall" });

      expect(replay.status).toBe(400);
      const replayed = await readErrorResponse(replay);
      expect(replayed.error.code).toBe("TRANSACTION_FAILED");
      expect(replayed.error.message).toContain(
        "does not have enough funds. Add funds and try again."
      );
      expect(replayed.error.message).not.toContain("again..");
      expect(replayed.error.message).not.toMatch(/kora|simulation|fee payer/i);
      expect(await listTransferRows()).toHaveLength(1);
    });

    it("answers a SOL transfer short of lamports 400 TRANSACTION_FAILED", async () => {
      sponsorRefuses(koraShortfall(0));

      const res = await postTransfer(SOL_TRANSFER, {});

      expect(res.status).toBe(400);
      const body = await readErrorResponse(res);
      expect(body.error.code).toBe("TRANSACTION_FAILED");
      expectTenantSafe(body.error.message);
      expectTenantSafe(required((await listTransferRows())[0]?.error));
    });

    it("keeps 0x1 on the sponsor-funded account creation an upstream failure", async () => {
      answerSourceUsdcTokenAccount(DEVNET_USDC_MINT);
      sponsorRefuses(koraShortfall(0));

      const res = await postTransfer({ ...SOL_TRANSFER, token: DEVNET_USDC_MINT }, {});

      expect(res.status).toBe(502);
      expect((await readErrorResponse(res)).error.code).toBe("SOLANA_RPC_ERROR");
    });
  });
});
