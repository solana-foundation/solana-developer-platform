import type * as feePaymentAdapters from "@sdp/payments/fee-payment";
import { FeePaymentError } from "@sdp/payments/fee-payment";
import type * as solanaRpc from "@sdp/rpc/solana";
import {
  generateKeyPairSigner,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { createTenantScope } from "@/lib/tenant-scope";
import { rootLogger } from "@/runtime/logger";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  confirmTransactionMock,
  createFeePaymentAdapterMock,
  createOrgSignerForCustodyWalletMock,
  fullySignTestTransaction,
  installPaymentsRouteTestHooks,
  sendTransactionMock,
  TEST_CUSTODY_WALLET_ID,
  TEST_KORA_FEE_PAYER,
  TEST_ORG,
  TEST_PROJECT,
  TEST_SPONSORSHIP_PROVIDER_CONFIG,
  updateSeededWalletPublicKey,
} from "@/test/helpers/payments-routes";
import {
  listTransferRows,
  postTransfer,
  readTransferResponse,
  readTransferRow,
} from "@/test/helpers/payments-transfers";

describe("Payments routes — signed submission", () => {
  installPaymentsRouteTestHooks();
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
      const signAndSend = vi.fn().mockRejectedValue(new Error("legacy signAndSend was used"));
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(sponsor.address),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue({
          ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
          signerAddress: sponsor.address,
        }),
        signAsFeePayer,
        signAndSend,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      return { signAsFeePayer, signAndSend };
    }

    it("persists the exact signed transaction before its first broadcast", async () => {
      const { signAsFeePayer, signAndSend } = await mockSignedSubmissionAdapter();

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
      expect(signAndSend).not.toHaveBeenCalled();
      expect(sendTransactionMock).toHaveBeenCalledOnce();
    });

    it("does not regress a transfer finalized while the route waits for confirmation", async () => {
      await mockSignedSubmissionAdapter();
      confirmTransactionMock.mockImplementationOnce(async (_rpc, signature) => {
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
          status: "finalized",
          slot: 200,
          updatedAt: new Date().toISOString(),
        });
        expect(reconciled?.status).toBe("finalized");

        return {
          signature,
          slot: 100n,
          confirmationStatus: "confirmed",
          err: null,
        } as Awaited<ReturnType<typeof solanaRpc.confirmTransaction>>;
      });

      const res = await transferRequest("0.001");

      expect(res.status).toBe(200);
      const json = await readTransferResponse(res);
      expect(json.data.transfer).toMatchObject({ status: "finalized", slot: 200 });

      const row = await readTransferRow(json.data.transfer.id);
      expect(row).toMatchObject({ status: "finalized", slot: 200 });
    });

    it("returns the durable processing transfer when its first broadcast is ambiguous", async () => {
      const { signAsFeePayer, signAndSend } = await mockSignedSubmissionAdapter();
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
      expect(signAndSend).not.toHaveBeenCalled();
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

    it("fails without broadcasting when sponsored signing is rejected", async () => {
      const { signAndSend } = await mockSignedSubmissionAdapter({
        signError: new FeePaymentError("insufficient balance", "INSUFFICIENT_BALANCE"),
      });

      const res = await transferRequest("1");

      expect(res.status).toBeGreaterThanOrEqual(400);
      const row = await latestTransferRow();
      expect(row).toMatchObject({ status: "failed", signature: null });
      expect(signAndSend).not.toHaveBeenCalled();
      expect(sendTransactionMock).not.toHaveBeenCalled();
    });

    it("records a pre-send admission rejection as a plain failed transfer", async () => {
      const signAndSendMock = vi.fn();
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        getSponsorshipConfiguration: vi.fn().mockRejectedValue(new Error("Kora config timed out")),
        signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const res = await transferRequest("1");

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(signAndSendMock).not.toHaveBeenCalled();
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
      } as unknown as Awaited<ReturnType<typeof solanaRpc.confirmTransaction>>);

      const res = await transferRequest("1");

      expect(res.status).toBe(400);
      const row = await latestTransferRow();
      expect(row.status).toBe("failed");
      expect(row.signature).toBeTruthy();
    });

    it("keeps a submitted transfer processing with its signature when confirmation fails", async () => {
      const { signAsFeePayer, signAndSend } = await mockSignedSubmissionAdapter();
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
      expect(signAndSend).not.toHaveBeenCalled();
      expect(sendTransactionMock).toHaveBeenCalledOnce();
    });
  });
});
