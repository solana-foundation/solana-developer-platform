import { formatDecimalAmount } from "@sdp/solana/amount";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { generatePaymentTransferId } from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { forbidden } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { moonpayWebhook } from "@/services/ramps/webhooks/moonpay";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  installClusterRpcResponder,
  type StubTokenAccount,
  tokenAccountsByOwnerResult,
} from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  createOrgSignerForCustodyWalletMock,
  DEVNET_USDC_MINT,
  installPaymentsRouteTestHooks,
  sendTransactionMock,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import {
  postTransfer,
  readErrorResponse,
  readTransferResponse,
  readTransferRow,
} from "@/test/helpers/payments-transfers";
import {
  answerMovementAccounts,
  mintRpcAccount,
  transferFeeExtension,
} from "@/test/helpers/token-movement";

const DEVNET_PYUSD_MINT = WELL_KNOWN_TOKENS.PYUSD.mints.devnet.address;

/** An off-ramp awaiting its 25 USDC (or `mint`) deposit to wallet2, as a MoonPay sell leaves it. */
async function seedOfframpDeposit(transferId: string, mint: string) {
  await createPostgresPaymentsRepository(
    getDb(env),
    createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
  ).createTransfer({
    id: transferId,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    custodyWalletId: TEST_CUSTODY_WALLET_ID,
    walletId: TEST_WALLET_ID,
    counterpartyId: null,
    sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
    destinationAddress: null,
    token: mint,
    amount: "25",
    memo: null,
    type: "offramp",
    direction: "outbound",
    status: "awaiting_payment",
    provider: "moonpay",
    providerReference: `moonpay-deposit-${transferId}`,
    deliveryMode: "hosted",
    fiatCurrency: "USD",
    fiatAmount: "25",
    providerData: {
      cryptoDeposit: { destinationAddress: TEST_SOLANA_ADDRESSES.wallet2, amount: "25" },
    },
    serializedTx: null,
    signature: null,
    slot: null,
    initiatedByKeyId: TEST_API_KEY.id,
    idempotencyKey: null,
    idempotencyFingerprint: null,
  });
}

function usdcDepositRequest(transferId: string, amount = "25") {
  return {
    transferId,
    sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
    destination: TEST_SOLANA_ADDRESSES.wallet2,
    token: "USDC",
    amount,
  };
}

async function seedUsdcOfframpDeposit(transferId: string) {
  await seedOfframpDeposit(transferId, DEVNET_USDC_MINT);
}

async function countAuditRows(transferId: string): Promise<number> {
  const row = await getDb(env)
    .prepare(
      `SELECT COUNT(*)::int AS count FROM audit_logs
       WHERE resource_id = ? OR metadata::jsonb -> 'target' ->> 'resourceId' = ?`
    )
    .bind(transferId, transferId)
    .first<{ count: number }>();
  if (row === null) throw new Error("Audit count query returned no row");
  return row.count;
}

describe("Payments routes — funding an off-ramp token deposit", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcResponder();

  function answerSourceUsdc(baseUnits: string, state: StubTokenAccount["state"]) {
    answerMovementAccounts(
      rpc,
      new Map([[DEVNET_USDC_MINT, mintRpcAccount("spl-token", { decimals: 6, extensions: null })]])
    );
    rpc.answer(
      "getTokenAccountsByOwner",
      tokenAccountsByOwnerResult(1, [
        {
          pubkey: TEST_SOLANA_ADDRESSES.wallet3,
          mint: DEVNET_USDC_MINT,
          amount: baseUnits,
          decimals: 6,
          uiAmountString: formatDecimalAmount(BigInt(baseUnits), 6),
          state,
        },
      ])
    );
  }

  function tokenAccountReads(): number {
    return rpc.calls.filter((call) => call.method === "getTokenAccountsByOwner").length;
  }

  function mintReads(): number {
    return rpc.calls.filter((call) => call.method === "getMultipleAccounts").length;
  }

  it("refuses a deposit the wallet cannot cover, leaving the sale open for the same key", async () => {
    const transferId = generatePaymentTransferId();
    await seedUsdcOfframpDeposit(transferId);
    const quoted = await readTransferRow(transferId);
    const idempotencyKey = crypto.randomUUID();
    answerSourceUsdc("5000000", "initialized");

    const refused = await postTransfer(usdcDepositRequest(transferId), { idempotencyKey });

    expect(refused.status).toBe(400);
    expect((await readErrorResponse(refused)).error).toMatchObject({
      code: "INSUFFICIENT_TOKEN_BALANCE",
      message: "Source wallet holds 5 USDC; this deposit needs 25 USDC",
    });
    expect(await readTransferRow(transferId)).toEqual(quoted);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).not.toHaveBeenCalled();
    expect(await countAuditRows(transferId)).toBe(0);

    // The refusal stored nothing under the key, so the same key funds the sale.
    answerSourceUsdc("25000000", "initialized");
    const tokenAccountReadsBefore = tokenAccountReads();
    const mintReadsBefore = mintReads();
    const funded = await postTransfer(usdcDepositRequest(transferId), { idempotencyKey });

    const fundedText = await funded.text();
    expect(funded.status, fundedText).toBe(200);
    expect((await readTransferResponse(new Response(fundedText))).data.transfer).toMatchObject({
      id: transferId,
      status: "settling",
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(1);
    // The send reuses the source and the terms the check read: one read of each.
    expect(tokenAccountReads() - tokenAccountReadsBefore).toBe(1);
    expect(mintReads() - mintReadsBefore).toBe(1);
  });

  it("refuses a deposit from a frozen token account before claiming it", async () => {
    const transferId = generatePaymentTransferId();
    await seedUsdcOfframpDeposit(transferId);
    const quoted = await readTransferRow(transferId);
    answerSourceUsdc("25000000", "frozen");

    const refused = await postTransfer(usdcDepositRequest(transferId), {});

    expect(refused.status).toBe(400);
    expect((await readErrorResponse(refused)).error).toMatchObject({
      code: "ACCOUNT_FROZEN",
      message: "Source wallet's USDC account is frozen",
    });
    expect(await readTransferRow(transferId)).toEqual(quoted);
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });

  it("refuses a deposit from a wallet with no account for the mint before claiming it", async () => {
    const transferId = generatePaymentTransferId();
    await seedUsdcOfframpDeposit(transferId);
    const quoted = await readTransferRow(transferId);
    answerSourceUsdc("0", "initialized");
    rpc.answer("getTokenAccountsByOwner", tokenAccountsByOwnerResult(1, []));

    const refused = await postTransfer(usdcDepositRequest(transferId), {});

    expect(refused.status).toBe(400);
    expect((await readErrorResponse(refused)).error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Source wallet has no token account for this mint",
    });
    expect(await readTransferRow(transferId)).toEqual(quoted);
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });

  it("returns the sale to awaiting its deposit when signing fails before any bytes exist", async () => {
    const transferId = generatePaymentTransferId();
    await seedUsdcOfframpDeposit(transferId);
    const quoted = await readTransferRow(transferId);
    answerSourceUsdc("25000000", "initialized");
    createOrgSignerForCustodyWalletMock.mockRejectedValueOnce(
      forbidden("Custody signing is paused for this wallet")
    );
    // The dashboard sends one key per deposit, so its retry reuses it.
    const idempotencyKey = crypto.randomUUID();

    const failed = await postTransfer(usdcDepositRequest(transferId), { idempotencyKey });

    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(sendTransactionMock).not.toHaveBeenCalled();
    const released = await readTransferRow(transferId);
    expect({ ...released, updated_at: quoted.updated_at }).toEqual(quoted);
    expect(released.status).toBe("awaiting_payment");

    // The release stored nothing under the key, so the same key funds the sale.
    const funded = await postTransfer(usdcDepositRequest(transferId), { idempotencyKey });
    const fundedText = await funded.text();
    expect(funded.status, fundedText).toBe(200);
    expect((await readTransferResponse(new Response(fundedText))).data.transfer).toMatchObject({
      id: transferId,
      status: "settling",
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(1);
  });

  it("fails a sale MoonPay failed during the claim, so a retry under its key sends nothing", {
    timeout: 30_000,
  }, async () => {
    const transferId = generatePaymentTransferId();
    await seedUsdcOfframpDeposit(transferId);
    answerSourceUsdc("25000000", "initialized");
    // MoonPay fails the sale while SDP holds the claim; then signing refuses.
    // The webhook runs as its own request would, under the webhook identity.
    createOrgSignerForCustodyWalletMock.mockImplementationOnce(async () => {
      expect(
        await runWithSystemDatabaseIdentity("http:webhooks", () =>
          moonpayWebhook.process(env, "sandbox", {
            provider: "moonpay",
            kind: "failed",
            rampType: "offramp",
            reference: `moonpay-deposit-${transferId}`,
            transferId,
            providerObservedAt: "2026-10-20T12:00:00.000Z",
            error: "deposit_timeout",
          })
        )
      ).toEqual({ outcome: "refused", reason: "moonpay_sell_failed" });
      throw forbidden("Custody signing is paused for this wallet");
    });
    const idempotencyKey = crypto.randomUUID();

    const failed = await postTransfer(usdcDepositRequest(transferId), { idempotencyKey });
    const retried = await postTransfer(usdcDepositRequest(transferId), { idempotencyKey });

    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(retried.status).toBeGreaterThanOrEqual(400);
    expect(createOrgSignerForCustodyWalletMock).toHaveBeenCalledTimes(1);
    expect(sendTransactionMock).not.toHaveBeenCalled();
    const row = await readTransferRow(transferId);
    expect(row.status).toBe("failed");
    expect(row.provider_data).toMatchObject({
      cryptoDeposit: null,
      providerFailure: { reference: `moonpay-deposit-${transferId}`, error: "deposit_timeout" },
    });
  });

  it("refuses a request that does not match the deposit before reading the chain", async () => {
    const transferId = generatePaymentTransferId();
    await seedUsdcOfframpDeposit(transferId);
    answerSourceUsdc("5000000", "initialized");

    const refused = await postTransfer(usdcDepositRequest(transferId, "24"), {});

    expect(refused.status).toBe(400);
    expect((await readErrorResponse(refused)).error.message).toBe(
      "Transfer does not match the off-ramp deposit instruction"
    );
    expect(tokenAccountReads()).toBe(0);
    expect(mintReads()).toBe(0);
  });

  it("delivers a fee mint's deposit in full: the debit is grossed up, the claim compares the credit", async () => {
    const transferId = generatePaymentTransferId();
    await seedOfframpDeposit(transferId, DEVNET_PYUSD_MINT);
    answerMovementAccounts(
      rpc,
      new Map([
        [
          DEVNET_PYUSD_MINT,
          mintRpcAccount("token-2022", {
            decimals: 6,
            extensions: [transferFeeExtension(50, 1_000_000n)],
          }),
        ],
      ])
    );
    const answerSourcePyusd = (baseUnits: string) =>
      rpc.answer(
        "getTokenAccountsByOwner",
        tokenAccountsByOwnerResult(1, [
          {
            pubkey: TEST_SOLANA_ADDRESSES.wallet3,
            mint: DEVNET_PYUSD_MINT,
            amount: baseUnits,
            decimals: 6,
            uiAmountString: formatDecimalAmount(BigInt(baseUnits), 6),
            state: "initialized",
          },
        ])
      );
    const request = { ...usdcDepositRequest(transferId), token: "PYUSD" };
    // 25 PYUSD reaching the provider at 50 bps costs the wallet 25.125628.
    answerSourcePyusd("25000000");

    const refused = await postTransfer(request, {});

    expect(refused.status).toBe(400);
    expect((await readErrorResponse(refused)).error.message).toBe(
      "Source wallet holds 25 PYUSD; this deposit needs 25.125629 PYUSD"
    );

    answerSourcePyusd("30000000");
    const funded = await postTransfer(request, {});
    const fundedText = await funded.text();
    expect(funded.status, fundedText).toBe(200);
    const { transfer } = (await readTransferResponse(new Response(fundedText))).data;
    expect(transfer).toMatchObject({
      id: transferId,
      status: "settling",
      amount: "25",
      amounts: {
        basis: "credit",
        debit: "25.125629",
        fee: "0.125629",
        credit: "25",
        decimals: 6,
      },
      amountVerification: { state: "verified", reason: "sdp_built_transfer_landed" },
    });
  });

  it("refuses a debit basis on an off-ramp deposit, whose amount is a receipt", async () => {
    const transferId = generatePaymentTransferId();
    await seedUsdcOfframpDeposit(transferId);

    const refused = await postTransfer(
      { ...usdcDepositRequest(transferId), amountBasis: "debit" },
      {}
    );

    expect(refused.status).toBe(400);
    expect((await readErrorResponse(refused)).error.message).toContain(
      "amountBasis must be credit"
    );
    expect(mintReads()).toBe(0);
  });
});
