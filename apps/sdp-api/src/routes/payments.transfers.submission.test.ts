import { FeePaymentError } from "@sdp/fee-payment/port";
import type { confirmTransaction } from "@sdp/rpc/solana";
import {
  generateKeyPairSigner,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import type { UpdatePaymentTransferInput } from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { AppError } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { rootLogger } from "@/runtime/logger";
import { AuditService } from "@/services/audit.service";
import * as signedSubmission from "@/services/payments/signed-submission";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  confirmTransactionMock,
  createKoraAdapterMock,
  createOrgSignerForCustodyWalletMock,
  installPaymentsRouteTestHooks,
  sendTransactionMock,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_SPONSORSHIP_PROVIDER_CONFIG,
  testKoraAdapter,
  updateSeededWalletPublicKey,
} from "@/test/helpers/payments-routes";
import {
  listTransferRows,
  postTransfer,
  readErrorResponse,
  readTransferResponse,
  readTransferRow,
} from "@/test/helpers/payments-transfers";
import { sendTransactionPreflightError } from "@/test/helpers/rpc-errors";
import { fullySignTestTransaction, TEST_MOCK_FEE_PAYER } from "@/test/helpers/sponsor-signing";

describe("Payments routes — signed submission", () => {
  installPaymentsRouteTestHooks();
  installClusterRpcStub();
  describe("signed submission boundary", () => {
    async function latestTransferRow() {
      const row = (await listTransferRows())[0];
      if (!row) throw new Error("no transfer row");
      return row;
    }

    function transferRequest(amount: string, idempotencyKey?: string) {
      const body = {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL" as const,
        amount,
      };
      if (idempotencyKey === undefined) {
        return postTransfer(body, {});
      }
      return postTransfer(body, { idempotencyKey });
    }

    async function mockSignedSubmissionAdapter(options?: { signError?: Error }) {
      const source = await generateKeyPairSigner();
      const sponsor = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(source.address);
      createOrgSignerForCustodyWalletMock.mockResolvedValueOnce(source);

      const signAsFeePayer = options?.signError
        ? vi.fn().mockRejectedValue(options.signError)
        : vi.fn(async (sourceSignedBytes: Uint8Array) => {
            const sourceSigned = getTransactionDecoder().decode(sourceSignedBytes);
            const fullySigned = await partiallySignTransaction([sponsor.keyPair], sourceSigned);
            return new Uint8Array(getTransactionEncoder().encode(fullySigned));
          });
      createKoraAdapterMock.mockReturnValue(
        testKoraAdapter({
          getFeePayer: vi.fn().mockResolvedValue(sponsor.address),
          getSponsorshipConfiguration: vi.fn().mockResolvedValue({
            ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
            signerAddress: sponsor.address,
          }),
          signAsFeePayer,
        })
      );

      return { signAsFeePayer };
    }

    it("persists the exact signed transaction before its first broadcast", async () => {
      const { signAsFeePayer } = await mockSignedSubmissionAdapter();

      let persistedSignature: string | null = null;
      sendTransactionMock.mockImplementationOnce(async (_rpc, signedBytes) => {
        const signed = getTransactionDecoder().decode(signedBytes);
        const signature = getSignatureFromTransaction(signed);
        persistedSignature = signature;
        const row = (await listTransferRows())[0];

        expect(row).toMatchObject({
          signature,
          signed_transaction: Buffer.from(signedBytes).toString("base64"),
          last_valid_block_height: "1000",
        });
        expect(row?.submission_started_at).not.toBeNull();
        return signature;
      });

      const res = await transferRequest("0.001", "signed-before-send");

      expect(res.status).toBe(200);
      const json = await readTransferResponse(res);
      expect(json.data.transfer.signature).toBe(persistedSignature);
      expect(json.data.transfer.serializedTx).toBeNull();
      expect(signAsFeePayer).toHaveBeenCalledOnce();
      expect(sendTransactionMock).toHaveBeenCalledOnce();
    });

    async function settleProcessingTransfer(
      signature: string,
      verdict: Pick<UpdatePaymentTransferInput, "status" | "slot" | "error">
    ) {
      const processing = (await listTransferRows()).find(
        (row) => row.status === "processing" && row.signature === signature
      );
      if (!processing) throw new Error("processing transfer not found");

      const reconciled = await createPostgresPaymentsRepository(
        getDb(env),
        createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
      ).updateTransfer({
        transferId: processing.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        expectedStatus: "processing",
        ...verdict,
        updatedAt: new Date().toISOString(),
      });
      expect(reconciled).toMatchObject(verdict);
    }

    it("does not regress a transfer finalized while the route waits for confirmation", async () => {
      await mockSignedSubmissionAdapter();
      confirmTransactionMock.mockImplementationOnce(async (_rpc, signature) => {
        await settleProcessingTransfer(signature, { status: "finalized", slot: 200 });

        return {
          signature,
          slot: 100n,
          confirmationStatus: "confirmed",
          err: null,
        } as Awaited<ReturnType<typeof confirmTransaction>>;
      });

      const res = await transferRequest("0.001");

      expect(res.status).toBe(200);
      const json = await readTransferResponse(res);
      expect(json.data.transfer).toMatchObject({ status: "finalized", slot: 200 });

      const row = await readTransferRow(json.data.transfer.id);
      expect(row).toMatchObject({ status: "finalized", slot: 200 });
    });

    it("upgrades a transfer reconciliation confirmed during the finalized wait to finalized", async () => {
      await mockSignedSubmissionAdapter();
      confirmTransactionMock.mockImplementationOnce(async (_rpc, signature) => {
        await settleProcessingTransfer(signature, { status: "confirmed", slot: 150 });
        return {
          signature,
          slot: 100n,
          confirmationStatus: "finalized",
          err: null,
        };
      });

      const res = await transferRequest("0.001");

      expect(res.status).toBe(200);
      const json = await readTransferResponse(res);
      expect(json.data.transfer).toMatchObject({ status: "finalized", slot: 100 });
      expect(await readTransferRow(json.data.transfer.id)).toMatchObject({ status: "finalized" });
      expect(
        await new AuditService(getDb(env)).findCriticalOutcome({
          organizationId: TEST_ORG.id,
          action: "transfer",
          resourceType: "payment_transfer",
          resourceId: json.data.transfer.id,
        })
      ).toMatchObject({ status: "success", metadata: { slot: "100" } });
    });

    it("answers an ambiguous confirmation failure with the row reconciliation already finalized", async () => {
      await mockSignedSubmissionAdapter();
      confirmTransactionMock.mockImplementationOnce(async (_rpc, signature) => {
        await settleProcessingTransfer(signature, { status: "finalized", slot: 200 });
        throw new Error("confirmation timed out");
      });

      const res = await transferRequest("0.001");

      expect(res.status).toBe(200);
      const json = await readTransferResponse(res);
      expect(json.data.transfer).toMatchObject({ status: "finalized", slot: 200 });
      expect(
        await new AuditService(getDb(env)).findCriticalOutcome({
          organizationId: TEST_ORG.id,
          action: "transfer",
          resourceType: "payment_transfer",
          resourceId: json.data.transfer.id,
        })
      ).toMatchObject({ status: "success", metadata: { slot: "200" } });
    });

    it("answers an ambiguous confirmation failure on a row reconciliation already failed like its replay", async () => {
      await mockSignedSubmissionAdapter();
      confirmTransactionMock.mockImplementationOnce(async (_rpc, signature) => {
        await settleProcessingTransfer(signature, { status: "failed", error: "Blockhash expired" });
        throw new Error("confirmation timed out");
      });

      const res = await transferRequest("0.001");

      expect(res.status).toBe(400);
      const failed = await latestTransferRow();
      expect(await readErrorResponse(res)).toEqual({
        error: {
          code: "TRANSACTION_FAILED",
          message:
            "Blockhash expired. This Idempotency-Key belongs to a transfer that failed; send the request again with a new Idempotency-Key to try again.",
          details: { transferId: failed.id, status: "failed" },
        },
        meta: { requestId: expect.stringMatching(/^req_/) },
      });
      expect(
        await new AuditService(getDb(env)).findCriticalOutcome({
          organizationId: TEST_ORG.id,
          action: "transfer",
          resourceType: "payment_transfer",
          resourceId: failed.id,
        })
      ).toMatchObject({ status: "failure", metadata: { error: "confirmation timed out" } });
    });

    it("returns the durable processing transfer when its first broadcast is ambiguous", async () => {
      const { signAsFeePayer } = await mockSignedSubmissionAdapter();
      sendTransactionMock.mockRejectedValueOnce(new Error("RPC response lost"));
      const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => undefined);
      const idempotencyKey = "signed-broadcast-timeout";

      const res = await transferRequest("0.001", idempotencyKey);

      expect(res.status).toBe(200);
      const json = await readTransferResponse(res);
      expect(json.data.transfer.status).toBe("processing");
      expect(json.data.transfer.signature).toBeTruthy();

      const row = await readTransferRow(json.data.transfer.id);
      expect(row).toMatchObject({
        status: "processing",
        signature: json.data.transfer.signature,
      });
      expect(row.signed_transaction).not.toBeNull();
      expect(row.submission_started_at).not.toBeNull();

      const replay = await transferRequest("0.001", idempotencyKey);
      expect(replay.status).toBe(200);
      const replayJson = await readTransferResponse(replay);
      expect(replayJson.data.transfer.id).toBe(json.data.transfer.id);
      expect(signAsFeePayer).toHaveBeenCalledOnce();
      expect(sendTransactionMock).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "sdp_api_payment_submission_unresolved",
          flow: "single",
          reason: "submission_unconfirmed",
          organization_id: TEST_ORG.id,
          project_id: TEST_PROJECT.id,
          transfer_id: json.data.transfer.id,
          transfer_type: "transfer",
          signature: json.data.transfer.signature,
          error: "RPC response lost",
        }),
        "sdp_api_payment_submission_unresolved"
      );
      warn.mockRestore();
    });

    it("fails a transfer whose first broadcast preflight refuses, keeping its signature", async () => {
      await mockSignedSubmissionAdapter();
      sendTransactionMock.mockRejectedValueOnce(sendTransactionPreflightError());

      const res = await transferRequest("0.001");

      expect(res.status).toBe(400);
      expect((await readErrorResponse(res)).error.code).toBe("TRANSACTION_FAILED");
      const row = await latestTransferRow();
      expect(row.status).toBe("failed");
      expect(row.signature).toBeTruthy();
      expect(sendTransactionMock).toHaveBeenCalledOnce();
    });

    it("fails a transfer whose committed start marker lost its reply, releasing its sponsorship", async () => {
      await mockSignedSubmissionAdapter();
      const createStore = signedSubmission.createTransferSignedSubmissionStore;
      vi.spyOn(signedSubmission, "createTransferSignedSubmissionStore").mockImplementationOnce(
        (repository, transfer) => {
          const store = createStore(repository, transfer);
          return {
            ...store,
            markStarted: async () => {
              await store.markStarted();
              throw new Error("marker reply lost");
            },
          };
        }
      );

      const res = await transferRequest("0.001");

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "The transaction could not be submitted; nothing was broadcast",
        },
        meta: { requestId: expect.any(String) },
      });
      const row = await latestTransferRow();
      expect(row).toMatchObject({ status: "failed", signature: expect.any(String) });
      expect(row.submission_started_at).not.toBeNull();
      expect(
        await getDb(env)
          .prepare("SELECT status FROM sponsorship_budget_reservations WHERE signature = ?")
          .bind(row.signature)
          .first<{ status: string }>()
      ).toEqual({ status: "released" });
    });

    it("fails without broadcasting when sponsored signing is rejected", async () => {
      await mockSignedSubmissionAdapter({
        signError: new FeePaymentError("insufficient balance", "INSUFFICIENT_BALANCE"),
      });

      const res = await transferRequest("1");

      expect(res.status).toBeGreaterThanOrEqual(400);
      const row = await latestTransferRow();
      expect(row).toMatchObject({ status: "failed", signature: null });
      expect(sendTransactionMock).not.toHaveBeenCalled();
    });

    it("records a pre-send admission rejection as a plain failed transfer", async () => {
      createKoraAdapterMock.mockReturnValue(
        testKoraAdapter({
          getFeePayer: vi.fn().mockResolvedValue(TEST_MOCK_FEE_PAYER),
          getSponsorshipConfiguration: vi
            .fn()
            .mockRejectedValue(new Error("Kora config timed out")),
          signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
        })
      );

      const res = await transferRequest("1");

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(sendTransactionMock).not.toHaveBeenCalled();
      const row = await latestTransferRow();
      expect(row).toMatchObject({ status: "failed", signature: null });
      expect(row.error).toContain("Sponsorship preflight is unavailable");
    });

    it("journals a definite on-chain failure as failed with the submitted signature", async () => {
      await mockSignedSubmissionAdapter();
      confirmTransactionMock.mockResolvedValueOnce({
        signature:
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
        slot: 100n,
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, { Custom: 1 }] },
      } as unknown as Awaited<ReturnType<typeof confirmTransaction>>);

      const res = await transferRequest("1");

      expect(res.status).toBe(400);
      const row = await latestTransferRow();
      expect(row.status).toBe("failed");
      expect(row.signature).toBeTruthy();
    });

    async function errorBody(response: Response) {
      // SAFETY: the app's error envelope; the tests read these fields only.
      return (await response.json()) as {
        error: { code: string; message: string };
        meta?: { requestId?: string };
      };
    }

    async function expireIdempotencyKey(key: string) {
      await getDb(env)
        .prepare("DELETE FROM idempotency_keys WHERE idempotency_key = ?")
        .bind(key)
        .run();
    }

    it("stores a 400 raised after the row, and past 24 hours answers it from the row", async () => {
      await mockSignedSubmissionAdapter();
      confirmTransactionMock.mockResolvedValueOnce({
        signature:
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
        slot: 100n,
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, { Custom: 1 }] },
      } as unknown as Awaited<ReturnType<typeof confirmTransaction>>);
      const key = "failed-after-row-400";

      const first = await transferRequest("1", key);
      expect(first.status).toBe(400);
      const firstBody = await errorBody(first);
      expect(firstBody.error.code).toBe("TRANSACTION_FAILED");

      // Within 24 hours the stored answer replays: the same 400, never a 200.
      const retry = await transferRequest("1", key);
      expect(retry.status).toBe(400);
      expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
      expect((await errorBody(retry)).error).toEqual(firstBody.error);

      // Past 24 hours the failed row answers with the same status and code.
      await expireIdempotencyKey(key);
      const late = await transferRequest("1", key);
      expect(late.status).toBe(400);
      const lateBody = await errorBody(late);
      expect(lateBody.error.code).toBe("TRANSACTION_FAILED");
      expect(lateBody.error.message).toContain("new Idempotency-Key");
      // The same envelope as a fresh error: the request id and trace header.
      expect(lateBody.meta?.requestId).toMatch(/^req_/);
      expect(late.headers.get("X-SDP-Trace-ID")).toBeTruthy();
      // The row's answer is marked a replay, so a client retires the key, and is
      // stored under the key again.
      expect(late.headers.get("Idempotent-Replayed")).toBe("true");
      expect(
        await getDb(env)
          .prepare("SELECT status, response_status FROM idempotency_keys WHERE idempotency_key = ?")
          .bind(key)
          .first<{ status: string; response_status: number | null }>()
      ).toEqual({ status: "completed", response_status: 400 });
      expect(sendTransactionMock).toHaveBeenCalledOnce();
      expect(await listTransferRows()).toHaveLength(1);
    });

    it("stores a 409 signer mismatch raised after the row and replays it", async () => {
      createOrgSignerForCustodyWalletMock.mockRejectedValueOnce(
        new AppError("CONFLICT", "Custody signer does not match the selected wallet")
      );
      const key = "failed-after-row-409";

      const first = await transferRequest("1", key);
      expect(first.status).toBe(409);
      expect((await latestTransferRow()).status).toBe("failed");

      const retry = await transferRequest("1", key);
      expect(retry.status).toBe(409);
      expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
      expect((await errorBody(retry)).error.message).toBe(
        "Custody signer does not match the selected wallet"
      );

      await expireIdempotencyKey(key);
      const late = await transferRequest("1", key);
      expect(late.status).toBe(409);
      expect((await errorBody(late)).error.code).toBe("CONFLICT");
      expect(sendTransactionMock).not.toHaveBeenCalled();
    });

    it("keeps a submitted transfer processing with its signature when confirmation fails", async () => {
      const { signAsFeePayer } = await mockSignedSubmissionAdapter();
      confirmTransactionMock.mockRejectedValueOnce(new Error("confirmation timed out"));

      const idempotencyKey = "submitted-unconfirmed-key";
      const res = await transferRequest("0.001", idempotencyKey);

      expect(res.status).toBe(200);
      const json = await readTransferResponse(res);
      expect(json.data.transfer.status).toBe("processing");
      expect(json.data.transfer.signature).toBeTruthy();

      const row = await readTransferRow(json.data.transfer.id);
      expect(row.status).toBe("processing");
      expect(row.signature).toBe(json.data.transfer.signature);
      const replay = await transferRequest("0.001", idempotencyKey);
      expect(replay.status).toBe(200);
      const replayJson = await readTransferResponse(replay);
      expect(replayJson.data.transfer.id).toBe(json.data.transfer.id);
      expect(signAsFeePayer).toHaveBeenCalledOnce();
      expect(sendTransactionMock).toHaveBeenCalledOnce();
    });
  });
});
