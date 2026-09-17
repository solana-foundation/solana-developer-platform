import type * as feePaymentAdapters from "@sdp/payments/fee-payment";
import { SOL_MINT } from "@sdp/types";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import { generatePaymentTransferId } from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { createTenantScope } from "@/lib/tenant-scope";
import { AuditService } from "@/services/audit.service";
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

    const duplicate = await postTransfer(JSON.parse(requestBody), {});
    expect(duplicate.status).toBe(409);
    expect(await countTransferRows()).toBe(1);
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
