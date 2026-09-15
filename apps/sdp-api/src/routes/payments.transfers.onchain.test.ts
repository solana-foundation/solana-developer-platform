import type * as feePaymentAdapters from "@sdp/payments/fee-payment";
import { type PaymentTransferStatus, SOL_MINT } from "@sdp/types";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import { generatePaymentTransferId } from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { createTenantScope } from "@/lib/tenant-scope";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  createFeePaymentAdapterMock,
  createOrgSignerForCustodyWalletMock,
  DEVNET_USDC_MINT,
  installPaymentsRouteTestHooks,
  mockRecurringActivationRpc,
  sendTransactionMock,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
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
  seedWalletControlProfile,
} from "@/test/helpers/payments-transfers";
import { fullySignTestTransaction, TEST_MOCK_FEE_PAYER } from "@/test/helpers/sponsor-signing";

describe("Payments routes — on-chain transfers", () => {
  installPaymentsRouteTestHooks();
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

  it("blocks create transfer to a destination outside the control-profile allowlist", async () => {
    await seedWalletControlProfile({
      rules: [
        {
          id: "destination-allowlist",
          kind: "destination",
          allowlist: [TEST_SOLANA_ADDRESSES.wallet2],
          action: "allow",
        },
      ],
    });

    const res = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet3,
        token: "SOL",
        amount: "0.7",
      },
      {}
    );

    expect(res.status).toBe(403);
    const body = await readErrorResponse(res);
    expect(body.error.code).toBe("FORBIDDEN");
    const details = z
      .object({ decision: z.string(), reason: z.string() })
      .parse(body.error.details);
    expect(details.decision).toBe("deny");
    expect(details.reason).toContain(
      `Destination ${TEST_SOLANA_ADDRESSES.wallet3} is not allowed by policy.`
    );

    expect(await countTransferRows()).toBe(0);

    const operation = await getDb(env)
      .prepare("SELECT status, operation_family, operation_type FROM wallet_operations")
      .first<{ status: string; operation_family: string; operation_type: string }>();
    expect(operation).toMatchObject({
      status: "failed",
      operation_family: "payment",
      operation_type: "payment_transfer_execute",
    });

    const evaluation = await getDb(env)
      .prepare("SELECT decision FROM policy_evaluations")
      .first<{ decision: string }>();
    expect(evaluation?.decision).toBe("deny");
  });

  it("creates a transfer to a destination on the control-profile allowlist", async () => {
    await seedWalletControlProfile({
      rules: [
        {
          id: "destination-allowlist",
          kind: "destination",
          allowlist: [TEST_SOLANA_ADDRESSES.wallet2],
          action: "allow",
        },
      ],
    });

    const res = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.7",
      },
      {}
    );

    expect(res.status).toBe(200);
    const body = await readTransferResponse(res);
    expect(body.data.transfer.status).toBe("confirmed");

    const evaluation = await getDb(env)
      .prepare("SELECT decision FROM policy_evaluations")
      .first<{ decision: string }>();
    expect(evaluation?.decision).toBe("allow");
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

    const duplicate = await postTransfer(JSON.parse(requestBody), {});
    expect(duplicate.status).toBe(409);
    expect(await countTransferRows()).toBe(1);
  });

  /**
   * Creates an off-ramp row the way a quote does, so a send can be attempted against it.
   *
   * @param overrides - Fields to diverge from a well-formed row, one per guard condition.
   * @returns The id of the created transfer.
   */
  async function seedOfframpAwaitingPayment(overrides?: {
    providerData?: Record<string, unknown>;
    amount?: string;
    status?: PaymentTransferStatus;
  }): Promise<string> {
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
      amount: overrides?.amount ?? "1",
      memo: null,
      type: "offramp",
      direction: "outbound",
      status: overrides?.status ?? "awaiting_payment",
      provider: "bvnk",
      providerReference: "e67b1be2-2bba-40db-9571-3a3612b865ef",
      deliveryMode: "manual_instructions",
      fiatCurrency: "EUR",
      fiatAmount: "86.84",
      providerData: overrides?.providerData ?? {
        cryptoDeposit: { destinationAddress: TEST_SOLANA_ADDRESSES.wallet2, amount: "1" },
      },
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: TEST_API_KEY.id,
      idempotencyKey: null,
      idempotencyFingerprint: null,
    });
    return transferId;
  }

  /**
   * Attempts the in-app send for an off-ramp row.
   *
   * @param input - Transfer id plus the wire fields the guard compares against the row.
   * @returns The raw response, so each case can assert its own status.
   */
  async function sendForOfframp(input: {
    transferId: string;
    destination?: string;
    amount?: string;
  }): Promise<Response> {
    return await postTransfer(
      {
        transferId: input.transferId,
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: input.destination ?? TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: input.amount ?? "1",
      },
      {}
    );
  }

  // "Transfer does not match the off-ramp deposit instruction" covers ten conditions and
  // names none of them, so each case that can produce it gets its own test. The missing
  // instruction is the one that actually shipped: a quote created before the deposit
  // instruction was persisted leaves a transfer that can never be funded.
  it("refuses the send when the off-ramp row carries no deposit instruction", async () => {
    const transferId = await seedOfframpAwaitingPayment({ providerData: {} });

    const res = await sendForOfframp({ transferId });

    expect(res.status).toBe(400);
    const body = await readErrorResponse(res);
    expect(body.error.message).toBe("Transfer does not match the off-ramp deposit instruction");
  });

  it("refuses the send when the destination differs from the deposit instruction", async () => {
    const transferId = await seedOfframpAwaitingPayment();

    const res = await sendForOfframp({
      transferId,
      destination: TEST_SOLANA_ADDRESSES.wallet3,
    });

    expect(res.status).toBe(400);
    const body = await readErrorResponse(res);
    expect(body.error.message).toBe("Transfer does not match the off-ramp deposit instruction");
  });

  it("refuses the send when the amount differs from the deposit instruction", async () => {
    const transferId = await seedOfframpAwaitingPayment();

    const res = await sendForOfframp({ transferId, amount: "2" });

    expect(res.status).toBe(400);
    const body = await readErrorResponse(res);
    expect(body.error.message).toBe("Transfer does not match the off-ramp deposit instruction");
  });

  it("refuses the send once the off-ramp row is no longer awaiting payment", async () => {
    const transferId = await seedOfframpAwaitingPayment({ status: "canceled" });

    const res = await sendForOfframp({ transferId });

    expect(res.status).toBe(409);
  });

  it("persists a signed outbox for an SPL transfer", async () => {
    mockRecurringActivationRpc({});

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
    mockRecurringActivationRpc({});
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
