import type * as feePaymentAdapters from "@sdp/payments/fee-payment";
import { FeePaymentError } from "@sdp/payments/fee-payment";
import type * as solanaRpc from "@sdp/rpc/solana";
import { SOL_MINT } from "@sdp/types";
import { address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import { createPostgresPolicyRepository } from "@/db/repositories";
import { generatePaymentTransferId } from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { buildPaymentTransferFingerprint } from "@/lib/idempotency";
import { createTenantScope } from "@/lib/tenant-scope";
import { recoverApprovedWalletOperations } from "@/services/policy/approved-operation-replay";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  createFeePaymentAdapterMock,
  fullySignTestTransaction,
  getRecentBlockhashMock,
  installPaymentsRouteTestHooks,
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
  postTransfer,
  readErrorResponse,
  readTransferResponse,
  readTransferRow,
  seedWalletControlProfile,
} from "@/test/helpers/payments-transfers";

const approvalErrorDetailsSchema = z.object({
  approvalRequestId: z.string(),
  walletOperationId: z.string(),
});

describe("Payments routes — transfer idempotency", () => {
  installPaymentsRouteTestHooks();
  it("recovers an expired execution claim with a fenced retry", async () => {
    await seedWalletControlProfile({
      rules: [
        {
          id: "approve-payment-recovery",
          kind: "approval",
          operationTypes: ["payment_transfer_execute"],
        },
      ],
    });
    const _headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
    };
    const pendingResponse = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      {}
    );
    const pendingBody = await readErrorResponse(pendingResponse);
    const { approvalRequestId, walletOperationId } = approvalErrorDetailsSchema.parse(
      pendingBody.error.details
    );
    const repository = createPostgresPolicyRepository(
      getDb(env),
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
    );
    await repository.updateApprovalRequestStatus({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      approvalRequestId,
      status: "approved",
      operationStatus: "executing",
      resolvedBy: TEST_API_KEY.id,
    });
    const interrupted = await repository.claimWalletOperationExecution(
      walletOperationId,
      "interrupted-attempt"
    );
    expect(interrupted?.execution_attempts).toBe(1);
    await getDb(env)
      .prepare(
        `UPDATE wallet_operations
         SET execution_lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE id = ?`
      )
      .bind(walletOperationId)
      .run();
    expect(
      await repository.completeWalletOperationExecution({
        walletOperationId,
        executionAttemptId: "interrupted-attempt",
        status: "failed",
        error: "stale worker",
      })
    ).toBeNull();
    expect(await repository.getWalletOperationById(walletOperationId)).toMatchObject({
      status: "executing",
      execution_attempt_id: "interrupted-attempt",
    });

    expect(await recoverApprovedWalletOperations(env)).toBe(1);
    const recovered = await repository.getWalletOperationById(walletOperationId);
    expect(recovered).toMatchObject({
      status: "completed",
      execution_attempts: 2,
      execution_error: null,
      execution_lease_expires_at: null,
    });
    expect(recovered?.execution_attempt_id).not.toBe("interrupted-attempt");

    expect(await countTransferRows()).toBe(1);
  });

  it("fails recovery closed for an incomplete idempotent transfer", async () => {
    await seedWalletControlProfile({
      rules: [
        {
          id: "approve-payment-incomplete-replay",
          kind: "approval",
          operationTypes: ["payment_transfer_execute"],
        },
      ],
    });
    const idempotencyKey = "approved-incomplete-transfer";
    const pendingResponse = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      { idempotencyKey: idempotencyKey }
    );
    expect(pendingResponse.status).toBe(202);
    const pendingBody = await readErrorResponse(pendingResponse);
    const { approvalRequestId, walletOperationId } = approvalErrorDetailsSchema.parse(
      pendingBody.error.details
    );
    const scope = createTenantScope({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
    });
    const policyRepository = createPostgresPolicyRepository(getDb(env), scope);
    await policyRepository.updateApprovalRequestStatus({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      approvalRequestId,
      status: "approved",
      operationStatus: "executing",
      resolvedBy: TEST_API_KEY.id,
    });
    await policyRepository.claimWalletOperationExecution(walletOperationId, "interrupted-attempt");

    const stranded = await createPostgresPaymentsRepository(getDb(env), scope).createTransfer({
      id: generatePaymentTransferId(),
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      counterpartyId: null,
      sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      token: SOL_MINT,
      amount: "0.1",
      memo: null,
      type: "transfer",
      direction: "outbound",
      status: "processing",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: {},
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: TEST_API_KEY.id,
      idempotencyKey,
      idempotencyFingerprint: buildPaymentTransferFingerprint({
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
        destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
        token: SOL_MINT,
        amount: "0.1",
        memo: undefined,
        type: "transfer",
      }),
    });
    if (!stranded) {
      throw new Error("Expected the stranded transfer fixture to be created");
    }
    expect(stranded).toMatchObject({ status: "processing", signature: null });
    await getDb(env)
      .prepare(
        `UPDATE wallet_operations
         SET execution_lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE id = ?`
      )
      .bind(walletOperationId)
      .run();

    expect(await recoverApprovedWalletOperations(env)).toBe(1);
    const recovered = await policyRepository.getWalletOperationById(walletOperationId);
    expect(recovered).toMatchObject({
      status: "failed",
      execution_attempts: 2,
    });
    expect(recovered?.execution_effect_started_at).toBeTruthy();
    expect(recovered?.execution_error).toContain(
      "Approved transfer execution is incomplete and requires manual reconciliation"
    );

    const unchanged = await readTransferRow(stranded.id);
    expect(unchanged).toEqual({ status: "processing", signature: null });
  });

  it("fails a completed approved replay when its persisted wallet identity differs", async () => {
    const body = JSON.stringify({
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "0.1",
    });
    const completedResponse = await postTransfer(JSON.parse(body), {
      idempotencyKey: "approved-completed-transfer-source",
    });
    expect(completedResponse.status).toBe(200);
    const completedBody = await readTransferResponse(completedResponse);

    await seedWalletControlProfile({
      rules: [
        {
          id: "approve-completed-transfer-replay",
          kind: "approval",
          operationTypes: ["payment_transfer_execute"],
        },
      ],
    });
    const replayKey = "approved-completed-transfer-replay";
    const pendingResponse = await postTransfer(JSON.parse(body), { idempotencyKey: replayKey });
    expect(pendingResponse.status).toBe(202);
    const pendingBody = await readErrorResponse(pendingResponse);
    const { approvalRequestId, walletOperationId } = approvalErrorDetailsSchema.parse(
      pendingBody.error.details
    );

    await getDb(env).batch([
      getDb(env)
        .prepare("UPDATE payment_transfers SET idempotency_key = ? WHERE id = ?")
        .bind(replayKey, completedBody.data.transfer.id),
      getDb(env)
        .prepare("UPDATE wallet_operations SET custody_wallet_id = NULL WHERE id = ?")
        .bind(walletOperationId),
    ]);
    const repository = createPostgresPolicyRepository(
      getDb(env),
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
    );
    await repository.updateApprovalRequestStatus({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      approvalRequestId,
      status: "approved",
      operationStatus: "executing",
      resolvedBy: TEST_API_KEY.id,
    });

    expect(await recoverApprovedWalletOperations(env)).toBe(1);
    expect(await repository.getWalletOperationById(walletOperationId)).toMatchObject({
      status: "failed",
      execution_error: "Approved wallet operation does not match persisted wallet identity",
    });
    const transfer = await readTransferRow(completedBody.data.transfer.id);
    expect(transfer).toMatchObject({
      custody_wallet_id: TEST_CUSTODY_WALLET_ID,
      status: "confirmed",
    });
    expect(transfer.signature).toBeTruthy();
  });

  it("requires manual reconciliation when an expired execution crossed its effect fence", async () => {
    await seedWalletControlProfile({
      rules: [
        {
          id: "approve-payment-ambiguous-recovery",
          kind: "approval",
          operationTypes: ["payment_transfer_execute"],
        },
      ],
    });
    const pendingResponse = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      {}
    );
    const pendingBody = await readErrorResponse(pendingResponse);
    const { approvalRequestId, walletOperationId } = approvalErrorDetailsSchema.parse(
      pendingBody.error.details
    );
    const repository = createPostgresPolicyRepository(
      getDb(env),
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
    );
    await repository.updateApprovalRequestStatus({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      approvalRequestId,
      status: "approved",
      operationStatus: "executing",
      resolvedBy: TEST_API_KEY.id,
    });
    await repository.claimWalletOperationExecution(walletOperationId, "ambiguous-attempt");
    expect(
      await repository.beginWalletOperationExecutionEffect(walletOperationId, "ambiguous-attempt")
    ).toBe(true);
    const firstEffect = await repository.getWalletOperationById(walletOperationId);
    expect(
      await repository.beginWalletOperationExecutionEffect(walletOperationId, "ambiguous-attempt")
    ).toBe(true);
    const repeatedEffect = await repository.getWalletOperationById(walletOperationId);
    expect(repeatedEffect?.execution_effect_started_at).toBe(
      firstEffect?.execution_effect_started_at
    );
    await getDb(env)
      .prepare(
        `UPDATE wallet_operations
         SET execution_lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE id = ?`
      )
      .bind(walletOperationId)
      .run();

    expect(await recoverApprovedWalletOperations(env)).toBe(0);
    const reconciled = await repository.getWalletOperationById(walletOperationId);
    expect(reconciled).toMatchObject({
      status: "failed",
      execution_attempt_id: "ambiguous-attempt",
      execution_attempts: 1,
      execution_lease_expires_at: null,
    });
    expect(reconciled?.execution_effect_started_at).toBeTruthy();
    expect(reconciled?.execution_completed_at).toBeTruthy();
    expect(reconciled?.execution_error).toContain("manual reconciliation");

    expect(await countTransferRows()).toBe(0);
  });

  it("replays a transfer when the same Idempotency-Key + body is retried", async () => {
    const signAndSendMock = vi
      .fn()
      .mockResolvedValue(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue({
        ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
        signerAddress: address("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      }),
      signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "xfer-key-1",
    };
    const body = JSON.stringify({
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "1",
    });

    const first = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    const second = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstJson = await readTransferResponse(first);
    const secondJson = await readTransferResponse(second);
    expect(secondJson.data.transfer.id).toBe(firstJson.data.transfer.id);
    const stored = await readTransferRow(firstJson.data.transfer.id);
    expect(stored.custody_wallet_id).toBe(TEST_CUSTODY_WALLET_ID);
    if (!stored.idempotency_fingerprint) throw new Error("missing idempotency fingerprint");
    expect(JSON.parse(stored.idempotency_fingerprint)).not.toHaveProperty("custodyWalletId");
    expect(signAndSendMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).toHaveBeenCalledOnce();
  });

  it("replays a failed transfer on retry without submitting again", async () => {
    const signAsFeePayerMock = vi
      .fn()
      .mockRejectedValue(new FeePaymentError("insufficient balance", "INSUFFICIENT_BALANCE"));
    const signAndSendMock = vi.fn();
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue({
        ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
        signerAddress: address("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      }),
      signAsFeePayer: signAsFeePayerMock,
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "failed-retry-key",
    };
    const body = JSON.stringify({
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "0.001",
    });

    const first = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    const second = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });

    expect(first.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBe(200);
    const secondBody = await readTransferResponse(second);
    expect(secondBody.data.transfer.status).toBe("failed");
    expect(signAsFeePayerMock).toHaveBeenCalledOnce();
    expect(signAndSendMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });

  it("does not re-run policy enforcement on an idempotent replay", async () => {
    const signAndSendMock = vi
      .fn()
      .mockResolvedValue(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue({
        ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
        signerAddress: address("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      }),
      signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "xfer-policy-replay-key",
    };
    const body = JSON.stringify({
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "1",
    });

    const countWalletOperations = async () => {
      const row = await getDb(env)
        .prepare("SELECT COUNT(*) AS count FROM wallet_operations WHERE organization_id = ?")
        .bind(TEST_ORG.id)
        .first<{ count: number }>();
      return row === null ? 0 : Number(row.count);
    };

    const before = await countWalletOperations();

    const first = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(first.status).toBe(200);
    const afterFirst = await countWalletOperations();
    expect(afterFirst).toBe(before + 1);

    const second = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(second.status).toBe(200);
    const afterSecond = await countWalletOperations();

    const firstJson = await readTransferResponse(first);
    const secondJson = await readTransferResponse(second);
    expect(secondJson.data.transfer.id).toBe(firstJson.data.transfer.id);
    expect(afterSecond).toBe(afterFirst);
    expect(signAndSendMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).toHaveBeenCalledOnce();
  });

  it("rejects the same Idempotency-Key with a different body", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "xfer-key-2",
    };

    const first = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
      },
      { idempotencyKey: headers["Idempotency-Key"] }
    );
    expect(first.status).toBe(200);

    const conflict = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "2",
      },
      { idempotencyKey: headers["Idempotency-Key"] }
    );
    expect(conflict.status).toBe(409);
  });

  it("does not dedup when no Idempotency-Key is supplied", async () => {
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "3agLAsjf2Qba9W59cqxbXFoPRJFDFKB3efqYRhT6wLxaM4KwV31NVrLDjKAw22hR1GFcQc4mePSjZ6XZEHUAjN4c"
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV"
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue({
        ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
        signerAddress: address("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      }),
      signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

    const _headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const body = JSON.stringify({
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "1",
    });
    getRecentBlockhashMock
      .mockResolvedValueOnce({
        blockhash: "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2" as Awaited<
          ReturnType<typeof solanaRpc.getRecentBlockhash>
        >["blockhash"],
        lastValidBlockHeight: 1000n,
      })
      .mockResolvedValueOnce({
        blockhash: "3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3" as Awaited<
          ReturnType<typeof solanaRpc.getRecentBlockhash>
        >["blockhash"],
        lastValidBlockHeight: 1000n,
      });

    const a = await postTransfer(JSON.parse(body), {});
    const b = await postTransfer(JSON.parse(body), {});

    const aJson = await readTransferResponse(a);
    const bJson = await readTransferResponse(b);
    expect(bJson.data.transfer.id).not.toBe(aJson.data.transfer.id);
  });
});
