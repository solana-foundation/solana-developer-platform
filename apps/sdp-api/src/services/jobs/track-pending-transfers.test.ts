import * as solanaRpc from "@sdp/rpc/solana";
import type { Signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createSystemPaymentsRepository } from "@/db/repositories";
import { rootLogger } from "@/runtime/logger";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { trackPendingTransfers } from "./track-pending-transfers";

const createRpcMock = vi.spyOn(solanaRpc, "createRpc");
const getSignatureStatusesMock = vi.spyOn(solanaRpc, "getSignatureStatuses");
const getBlockHeightMock = vi.fn();

const TEST_SIG_1 =
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as unknown as Signature;
const TEST_SIG_2 =
  "5hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as unknown as Signature;
const TEST_SIG_3 =
  "6hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as unknown as Signature;
const TEST_SIG_4 =
  "7hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as unknown as Signature;

const TEST_ORG_ID = "org_job_test_001";

async function seedOrg(): Promise<void> {
  await getDb(env)
    .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
    .bind(TEST_ORG_ID, "Job Test Org", "job-test-org", "individual", "active")
    .run();
}

async function insertTransfer(params: {
  id: string;
  status: string;
  signature?: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  signedTransaction?: string;
  lastValidBlockHeight?: string;
  submissionStartedAt?: string;
  type?: string;
}): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers
       (id, organization_id, wallet_id, source_address, destination_address,
        token, amount, type, direction, status, signature, signed_transaction,
        last_valid_block_height, submission_started_at, confirmed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?, ?, ?, ?)`
    )
    .bind(
      params.id,
      TEST_ORG_ID,
      "wal_test",
      "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
      "9dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
      "SOL",
      "1.0",
      params.type ?? "transfer",
      "outbound",
      params.status,
      params.signature ?? null,
      params.signedTransaction ?? null,
      params.lastValidBlockHeight ?? null,
      params.submissionStartedAt ?? null,
      params.confirmedAt ?? null,
      params.createdAt,
      params.updatedAt
    )
    .run();
}

async function getTransfer(id: string) {
  return getDb(env).prepare("SELECT * FROM payment_transfers WHERE id = ?").bind(id).first<{
    id: string;
    status: string;
    error: string | null;
    slot: number | null;
    confirmed_at: string | null;
    finalization_last_polled_at: string | null;
    updated_at: string;
  }>();
}

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

describe("trackPendingTransfers", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedTestDatabase(env);
    await seedOrg();
    vi.clearAllMocks();
    getBlockHeightMock.mockResolvedValue(1_000n);
    createRpcMock.mockReturnValue({
      getBlockHeight: () => ({ send: getBlockHeightMock }),
    } as unknown as ReturnType<typeof solanaRpc.createRpc>);
    getSignatureStatusesMock.mockImplementation(async (_rpc, signatures) =>
      signatures.map(() => null)
    );
  });

  describe("recoverStuckProcessingTransfers", () => {
    it("marks stuck processing transfers (no signature, > 5 min stale) as failed", async () => {
      await insertTransfer({
        id: "xfr_stuck_processing",
        status: "processing",
        signature: null,
        createdAt: minutesAgo(6),
        updatedAt: minutesAgo(6),
      });

      await trackPendingTransfers(env);

      const updated = await getTransfer("xfr_stuck_processing");
      expect(updated?.status).toBe("failed");
      expect(updated?.error).toBe("Transfer processing timed out");
    });

    it("does not fail processing transfers that are still within the threshold", async () => {
      await insertTransfer({
        id: "xfr_recent_processing",
        status: "processing",
        signature: null,
        createdAt: minutesAgo(2),
        updatedAt: minutesAgo(2),
      });

      await trackPendingTransfers(env);

      const unchanged = await getTransfer("xfr_recent_processing");
      expect(unchanged?.status).toBe("processing");
    });
  });

  describe("syncProcessingTransfersOnChain", () => {
    it("updates processing transfer to confirmed when signature is confirmed on-chain", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([
        {
          slot: 12345n,
          confirmations: 10n,
          confirmationStatus: "confirmed",
          err: null,
        },
      ]);

      await insertTransfer({
        id: "xfr_processing_confirmed",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

      await trackPendingTransfers(env);

      const updated = await getTransfer("xfr_processing_confirmed");
      expect(updated?.status).toBe("confirmed");
      expect(updated?.slot).toBe(12345);
    });

    it("updates processing transfer to finalized when signature is finalized on-chain", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([
        {
          slot: 99999n,
          confirmations: null,
          confirmationStatus: "finalized",
          err: null,
        },
      ]);

      await insertTransfer({
        id: "xfr_processing_finalized",
        status: "processing",
        signature: String(TEST_SIG_2),
        signedTransaction: "AQ==",
        lastValidBlockHeight: "100",
        submissionStartedAt: minutesAgo(1),
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

      await trackPendingTransfers(env);

      const updated = await getTransfer("xfr_processing_finalized");
      expect(updated?.status).toBe("finalized");
      expect(updated?.slot).toBe(99999);
      expect(getBlockHeightMock).not.toHaveBeenCalled();
    });

    it("marks processing transfer as failed when on-chain status has an error", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([
        {
          slot: 55555n,
          confirmations: 0n,
          confirmationStatus: "confirmed",
          err: { InstructionError: [0, "InsufficientFunds"] },
        },
      ]);

      await insertTransfer({
        id: "xfr_processing_errored",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

      await trackPendingTransfers(env);

      const updated = await getTransfer("xfr_processing_errored");
      expect(updated?.status).toBe("failed");
      expect(updated?.slot).toBe(55555);
      expect(updated?.error).toContain("InsufficientFunds");
    });

    it("marks old processing transfer as failed when signature is not found on chain", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([null]);

      await insertTransfer({
        id: "xfr_processing_not_found",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(10),
        updatedAt: minutesAgo(10),
      });

      await trackPendingTransfers(env);

      const updated = await getTransfer("xfr_processing_not_found");
      expect(updated?.status).toBe("failed");
      expect(updated?.error).toBe("Transaction not found on chain");
      expect(getSignatureStatusesMock).toHaveBeenCalledOnce();
    });

    it("fails an expired signed submission whose broadcast never started", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([null]);
      getBlockHeightMock.mockResolvedValueOnce(101n);

      await insertTransfer({
        id: "xfr_unstarted_outbox_expired",
        status: "processing",
        signature: String(TEST_SIG_1),
        signedTransaction: "AQ==",
        lastValidBlockHeight: "100",
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

      await trackPendingTransfers(env);

      const failed = await getTransfer("xfr_unstarted_outbox_expired");
      expect(failed?.status).toBe("failed");
      expect(failed?.error).toBe("Transaction not found on chain");
      expect(getSignatureStatusesMock).toHaveBeenCalledOnce();
    });

    it("keeps and rotates an expired started submission when history is inconclusive", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([null]).mockResolvedValueOnce([null]);
      getBlockHeightMock.mockResolvedValueOnce(101n);
      const staleAt = minutesAgo(10);
      const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => undefined);

      try {
        await insertTransfer({
          id: "xfr_started_outbox_not_found",
          status: "processing",
          signature: String(TEST_SIG_1),
          signedTransaction: "AQ==",
          lastValidBlockHeight: "100",
          submissionStartedAt: staleAt,
          createdAt: staleAt,
          updatedAt: staleAt,
        });

        await trackPendingTransfers(env);

        const unresolved = await getTransfer("xfr_started_outbox_not_found");
        expect(unresolved?.status).toBe("processing");
        expect(unresolved?.error).toBeNull();
        expect(unresolved?.updated_at).not.toBe(staleAt);
        expect(getSignatureStatusesMock).toHaveBeenLastCalledWith(expect.anything(), [TEST_SIG_1], {
          searchTransactionHistory: true,
        });
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "sdp_api_payment_submission_unresolved",
            flow: "reconciler",
            reason: "history_absent",
            organization_id: TEST_ORG_ID,
            project_id: null,
            transfer_id: "xfr_started_outbox_not_found",
            transfer_type: "transfer",
            signature: TEST_SIG_1,
            last_valid_block_height: "100",
            submission_started_at: staleAt,
          }),
          "sdp_api_payment_submission_unresolved"
        );
      } finally {
        warn.mockRestore();
      }
    });

    it("keeps and rotates expired submissions when archival history is unavailable", async () => {
      getSignatureStatusesMock
        .mockResolvedValueOnce([null])
        .mockRejectedValueOnce(new Error("archive unavailable"));
      getBlockHeightMock.mockResolvedValueOnce(101n);
      const staleAt = minutesAgo(10);

      await insertTransfer({
        id: "xfr_started_outbox_archive_unavailable",
        status: "processing",
        signature: String(TEST_SIG_1),
        signedTransaction: "AQ==",
        lastValidBlockHeight: "100",
        submissionStartedAt: staleAt,
        createdAt: staleAt,
        updatedAt: staleAt,
      });

      await trackPendingTransfers(env);

      const unresolved = await getTransfer("xfr_started_outbox_archive_unavailable");
      expect(unresolved?.status).toBe("processing");
      expect(unresolved?.updated_at).not.toBe(staleAt);
    });

    it("keeps and rotates signed submissions when block height is unavailable", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([null]);
      getBlockHeightMock.mockRejectedValueOnce(new Error("block height unavailable"));
      const staleAt = minutesAgo(10);

      await insertTransfer({
        id: "xfr_started_outbox_height_unavailable",
        status: "processing",
        signature: String(TEST_SIG_1),
        signedTransaction: "AQ==",
        lastValidBlockHeight: "100",
        submissionStartedAt: staleAt,
        createdAt: staleAt,
        updatedAt: staleAt,
      });

      await trackPendingTransfers(env);

      const unresolved = await getTransfer("xfr_started_outbox_height_unavailable");
      expect(unresolved?.status).toBe("processing");
      expect(unresolved?.updated_at).not.toBe(staleAt);
      expect(getSignatureStatusesMock).toHaveBeenCalledOnce();
    });

    it("applies archival verdicts to the matching signatures", async () => {
      getSignatureStatusesMock
        .mockResolvedValueOnce([null, null, null, null])
        .mockResolvedValueOnce([
          { slot: 301n, confirmations: 1n, confirmationStatus: "confirmed", err: null },
          { slot: 302n, confirmations: null, confirmationStatus: "finalized", err: null },
          {
            slot: 303n,
            confirmations: 0n,
            confirmationStatus: "confirmed",
            err: { InstructionError: [0, "InsufficientFunds"] },
          },
          { slot: 304n, confirmations: 1n, confirmationStatus: "processed", err: null },
        ]);
      getBlockHeightMock.mockResolvedValueOnce(101n);
      const staleAt = minutesAgo(10);
      const rows = [
        ["xfr_archive_a_confirmed", TEST_SIG_1],
        ["xfr_archive_b_finalized", TEST_SIG_2],
        ["xfr_archive_c_failed", TEST_SIG_3],
        ["xfr_archive_d_processed", TEST_SIG_4],
      ] as const;
      for (const [id, signature] of rows) {
        await insertTransfer({
          id,
          status: "processing",
          signature: String(signature),
          signedTransaction: "AQ==",
          lastValidBlockHeight: "100",
          submissionStartedAt: staleAt,
          createdAt: staleAt,
          updatedAt: staleAt,
        });
      }

      await trackPendingTransfers(env);

      await expect(getTransfer("xfr_archive_a_confirmed")).resolves.toMatchObject({
        status: "confirmed",
        slot: 301,
      });
      await expect(getTransfer("xfr_archive_b_finalized")).resolves.toMatchObject({
        status: "finalized",
        slot: 302,
      });
      await expect(getTransfer("xfr_archive_c_failed")).resolves.toMatchObject({
        status: "failed",
        slot: 303,
      });
      await expect(getTransfer("xfr_archive_d_processed")).resolves.toMatchObject({
        status: "processing",
        updated_at: expect.not.stringMatching(staleAt),
      });
    });

    it("keeps and rotates a transfer when writing a terminal verdict fails", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([
        { slot: 401n, confirmations: 1n, confirmationStatus: "confirmed", err: null },
      ]);
      const staleAt = minutesAgo(10);

      await insertTransfer({
        id: "xfr_batch_verdict_write_failed",
        type: "transfer_batch",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: staleAt,
        updatedAt: staleAt,
      });

      await trackPendingTransfers(env);

      const unresolved = await getTransfer("xfr_batch_verdict_write_failed");
      expect(unresolved?.status).toBe("processing");
      expect(unresolved?.updated_at).not.toBe(staleAt);
    });

    it("uses block height rather than row age to expire a signed submission", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([null]);
      getBlockHeightMock.mockResolvedValueOnce(100n);

      await insertTransfer({
        id: "xfr_started_outbox_not_expired",
        status: "processing",
        signature: String(TEST_SIG_1),
        signedTransaction: "AQ==",
        lastValidBlockHeight: "100",
        submissionStartedAt: minutesAgo(10),
        createdAt: minutesAgo(10),
        updatedAt: minutesAgo(10),
      });

      await trackPendingTransfers(env);

      const unchanged = await getTransfer("xfr_started_outbox_not_expired");
      expect(unchanged?.status).toBe("processing");
      expect(getSignatureStatusesMock).toHaveBeenCalledOnce();
    });

    it("leaves processing transfer alone when signature not found but transfer is recent", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([null]);

      await insertTransfer({
        id: "xfr_processing_recent_not_found",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

      await trackPendingTransfers(env);

      const unchanged = await getTransfer("xfr_processing_recent_not_found");
      expect(unchanged?.status).toBe("processing");
    });

    it("does not rotate a legacy transfer in 'processed' confirmation status", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([
        {
          slot: 11111n,
          confirmations: 1n,
          confirmationStatus: "processed",
          err: null,
        },
      ]);
      const updatedAt = minutesAgo(1);
      const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => undefined);

      try {
        await insertTransfer({
          id: "xfr_processing_only_processed",
          status: "processing",
          signature: String(TEST_SIG_1),
          createdAt: updatedAt,
          updatedAt,
        });

        await trackPendingTransfers(env);

        const unchanged = await getTransfer("xfr_processing_only_processed");
        expect(unchanged?.status).toBe("processing");
        expect(unchanged?.updated_at).toBe(updatedAt);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it("reconciles mixed processing rows in one Postgres-backed run", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([
        {
          slot: 22222n,
          confirmations: 3n,
          confirmationStatus: "confirmed",
          err: null,
        },
      ]);

      await insertTransfer({
        id: "xfr_batch_processing_confirmed",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(2),
        updatedAt: minutesAgo(2),
      });
      await insertTransfer({
        id: "xfr_batch_processing_stuck",
        status: "processing",
        signature: null,
        createdAt: minutesAgo(7),
        updatedAt: minutesAgo(7),
      });

      await trackPendingTransfers(env);

      const [confirmed, stuck] = await Promise.all([
        getTransfer("xfr_batch_processing_confirmed"),
        getTransfer("xfr_batch_processing_stuck"),
      ]);

      expect(confirmed?.status).toBe("confirmed");
      expect(confirmed?.slot).toBe(22222);
      expect(stuck?.status).toBe("failed");
      expect(stuck?.error).toBe("Transfer processing timed out");
    });

    it("skips an invalid stored signature without blocking valid transfers", async () => {
      getSignatureStatusesMock.mockImplementation(async (_rpc, signatures) =>
        signatures.map((signature) =>
          signature === TEST_SIG_1
            ? {
                slot: 22223n,
                confirmations: 3n,
                confirmationStatus: "confirmed",
                err: null,
              }
            : null
        )
      );

      await insertTransfer({
        id: "xfr_invalid_signature",
        status: "processing",
        signature: "not-a-solana-signature",
        createdAt: minutesAgo(2),
        updatedAt: minutesAgo(2),
      });
      await insertTransfer({
        id: "xfr_valid_signature",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

      await trackPendingTransfers(env);

      const [invalid, valid] = await Promise.all([
        getTransfer("xfr_invalid_signature"),
        getTransfer("xfr_valid_signature"),
      ]);
      expect(invalid?.status).toBe("processing");
      expect(valid?.status).toBe("confirmed");
      expect(
        getSignatureStatusesMock.mock.calls.flatMap(([, signatures]) => signatures)
      ).not.toContain("not-a-solana-signature");
    });

    it("rotates a full page of invalid signatures so a later valid transfer is reached", async () => {
      getSignatureStatusesMock.mockImplementation(async (_rpc, signatures) =>
        signatures.map((signature) =>
          signature === TEST_SIG_1
            ? {
                slot: 22224n,
                confirmations: 3n,
                confirmationStatus: "confirmed",
                err: null,
              }
            : null
        )
      );

      await Promise.all(
        Array.from({ length: 256 }, (_, i) =>
          insertTransfer({
            id: `xfr_processing_invalid_${i}`,
            status: "processing",
            signature: `invalid-signature-${i}`,
            createdAt: minutesAgo(30),
            updatedAt: minutesAgo(30),
          })
        )
      );
      await insertTransfer({
        id: "xfr_processing_valid_behind_invalid_page",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(2),
        updatedAt: minutesAgo(2),
      });

      await trackPendingTransfers(env);
      expect((await getTransfer("xfr_processing_valid_behind_invalid_page"))?.status).toBe(
        "processing"
      );

      await trackPendingTransfers(env);
      expect((await getTransfer("xfr_processing_valid_behind_invalid_page"))?.status).toBe(
        "confirmed"
      );
    });

    it("does not call getSignatureStatuses when there are no processing transfers with signatures", async () => {
      await insertTransfer({
        id: "xfr_processing_without_sig",
        status: "processing",
        signature: null,
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

      await trackPendingTransfers(env);

      expect(getSignatureStatusesMock).not.toHaveBeenCalled();
    });
  });

  describe("finalizeConfirmedTransfers", () => {
    it("upgrades confirmed transfer to finalized, polling with searchTransactionHistory", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([
        {
          slot: 77777n,
          confirmations: null,
          confirmationStatus: "finalized",
          err: null,
        },
      ]);

      await insertTransfer({
        id: "xfr_confirmed_finalizing",
        status: "confirmed",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(3),
        updatedAt: minutesAgo(2),
        confirmedAt: minutesAgo(2),
      });

      await trackPendingTransfers(env);

      const updated = await getTransfer("xfr_confirmed_finalizing");
      expect(updated?.status).toBe("finalized");
      expect(updated?.slot).toBe(77777);
      expect(updated?.finalization_last_polled_at).not.toBeNull();
      expect(getSignatureStatusesMock).toHaveBeenCalledWith(expect.anything(), [TEST_SIG_1], {
        searchTransactionHistory: true,
      });
    });

    it("rotates a confirmed transfer whose signature status reads null without touching its status", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([null]);

      await insertTransfer({
        id: "xfr_confirmed_no_status",
        status: "confirmed",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(10),
        updatedAt: minutesAgo(10),
        confirmedAt: minutesAgo(10),
      });

      await trackPendingTransfers(env);

      const rotated = await getTransfer("xfr_confirmed_no_status");
      expect(rotated?.status).toBe("confirmed");
      expect(rotated?.finalization_last_polled_at).not.toBeNull();
    });

    it("does not poll confirmed transfers older than the finalization window", async () => {
      await insertTransfer({
        id: "xfr_confirmed_aged_out",
        status: "confirmed",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(25 * 60),
        updatedAt: minutesAgo(25 * 60),
        confirmedAt: minutesAgo(25 * 60),
      });

      await trackPendingTransfers(env);

      expect(getSignatureStatusesMock).not.toHaveBeenCalled();
      const unchanged = await getTransfer("xfr_confirmed_aged_out");
      expect(unchanged?.status).toBe("confirmed");
    });

    it("rotates a full page of invalid signatures so the next tick reaches a valid transfer", async () => {
      getSignatureStatusesMock.mockImplementation(async (_rpc, signatures) =>
        signatures.map((signature) =>
          String(signature) === String(TEST_SIG_2)
            ? { slot: 33333n, confirmations: null, confirmationStatus: "finalized", err: null }
            : null
        )
      );

      await Promise.all(
        Array.from({ length: 256 }, (_, i) =>
          insertTransfer({
            id: `xfr_confirmed_invalid_${i}`,
            status: "confirmed",
            signature: `invalid-confirmed-signature-${i}`,
            createdAt: minutesAgo(30),
            updatedAt: minutesAgo(30),
            confirmedAt: minutesAgo(30),
          })
        )
      );
      await insertTransfer({
        id: "xfr_confirmed_zz_behind_stuck_page",
        status: "confirmed",
        signature: String(TEST_SIG_2),
        createdAt: minutesAgo(2),
        updatedAt: minutesAgo(2),
        confirmedAt: minutesAgo(2),
      });

      await trackPendingTransfers(env);

      const behindFullPage = await getTransfer("xfr_confirmed_zz_behind_stuck_page");
      expect(behindFullPage?.status).toBe("confirmed");
      expect(behindFullPage?.finalization_last_polled_at).toBeNull();

      await trackPendingTransfers(env);

      const upgraded = await getTransfer("xfr_confirmed_zz_behind_stuck_page");
      expect(upgraded?.status).toBe("finalized");
      expect(upgraded?.slot).toBe(33333);
      const invalid = await getTransfer("xfr_confirmed_invalid_0");
      expect(invalid?.status).toBe("confirmed");
    });

    it("rotates the polled page even when the RPC batch call fails", async () => {
      getSignatureStatusesMock.mockRejectedValueOnce(new Error("rpc unreachable"));

      await insertTransfer({
        id: "xfr_confirmed_rpc_failed",
        status: "confirmed",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(3),
        updatedAt: minutesAgo(2),
        confirmedAt: minutesAgo(2),
      });

      await trackPendingTransfers(env);

      const rotated = await getTransfer("xfr_confirmed_rpc_failed");
      expect(rotated?.status).toBe("confirmed");
      expect(rotated?.finalization_last_polled_at).not.toBeNull();

      getSignatureStatusesMock.mockResolvedValueOnce([
        {
          slot: 44444n,
          confirmations: null,
          confirmationStatus: "finalized",
          err: null,
        },
      ]);

      await trackPendingTransfers(env);

      const upgraded = await getTransfer("xfr_confirmed_rpc_failed");
      expect(upgraded?.status).toBe("finalized");
      expect(upgraded?.slot).toBe(44444);
    });

    it("leaves confirmed transfer untouched when the finalized status carries an error", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([
        {
          slot: 88888n,
          confirmations: null,
          confirmationStatus: "finalized",
          err: { InstructionError: [0, { Custom: 1 }] },
        },
      ]);

      await insertTransfer({
        id: "xfr_confirmed_errored",
        status: "confirmed",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(3),
        updatedAt: minutesAgo(2),
        confirmedAt: minutesAgo(2),
      });

      await trackPendingTransfers(env);

      const unchanged = await getTransfer("xfr_confirmed_errored");
      expect(unchanged?.status).toBe("confirmed");
    });
  });

  describe("cron state regressions", () => {
    it("stamps confirmed_at when the sync pass confirms, and never re-stamps it", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([
        { slot: 100n, confirmations: 3n, confirmationStatus: "confirmed", err: null },
      ]);

      await insertTransfer({
        id: "xfr_regression_confirmed_at",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

      await trackPendingTransfers(env);

      const confirmed = await getTransfer("xfr_regression_confirmed_at");
      expect(confirmed?.status).toBe("confirmed");
      expect(confirmed?.confirmed_at).not.toBeNull();
      const stampedAt = confirmed?.confirmed_at;

      getSignatureStatusesMock.mockResolvedValue([
        { slot: 101n, confirmations: null, confirmationStatus: "finalized", err: null },
      ]);

      await trackPendingTransfers(env);

      const finalized = await getTransfer("xfr_regression_confirmed_at");
      expect(finalized?.status).toBe("finalized");
      expect(finalized?.confirmed_at).toBe(stampedAt);
    });

    it("running the reconciler twice against the same chain state is idempotent", async () => {
      getSignatureStatusesMock.mockResolvedValue([
        { slot: 200n, confirmations: null, confirmationStatus: "finalized", err: null },
      ]);

      await insertTransfer({
        id: "xfr_regression_double_fire",
        status: "confirmed",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(3),
        updatedAt: minutesAgo(2),
        confirmedAt: minutesAgo(2),
      });

      await trackPendingTransfers(env);
      const first = await getTransfer("xfr_regression_double_fire");

      await trackPendingTransfers(env);
      const second = await getTransfer("xfr_regression_double_fire");

      expect(first?.status).toBe("finalized");
      expect(second?.status).toBe("finalized");
      expect(second?.slot).toBe(first?.slot);
    });

    it("a late poll verdict never regresses a finalized or failed transfer", async () => {
      await insertTransfer({
        id: "xfr_regression_already_final",
        status: "finalized",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(3),
        updatedAt: minutesAgo(2),
        confirmedAt: minutesAgo(2),
      });
      await insertTransfer({
        id: "xfr_regression_already_failed",
        status: "failed",
        signature: String(TEST_SIG_2),
        createdAt: minutesAgo(3),
        updatedAt: minutesAgo(2),
        confirmedAt: minutesAgo(2),
      });

      const repo = createSystemPaymentsRepository(env);
      await repo.advanceConfirmedTransfers({
        polled: [
          {
            transferId: "xfr_regression_already_final",
            organizationId: TEST_ORG_ID,
            finalized: false,
            slot: null,
          },
          {
            transferId: "xfr_regression_already_failed",
            organizationId: TEST_ORG_ID,
            finalized: true,
            slot: 999,
          },
        ],
        updatedAt: new Date().toISOString(),
      });

      const stillFinal = await getTransfer("xfr_regression_already_final");
      const stillFailed = await getTransfer("xfr_regression_already_failed");
      expect(stillFinal?.status).toBe("finalized");
      expect(stillFinal?.finalization_last_polled_at).toBeNull();
      expect(stillFailed?.status).toBe("failed");
      expect(stillFailed?.slot).toBeNull();
    });

    it("a poll verdict scoped to the wrong organization touches nothing", async () => {
      await insertTransfer({
        id: "xfr_regression_wrong_org",
        status: "confirmed",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(3),
        updatedAt: minutesAgo(2),
        confirmedAt: minutesAgo(2),
      });

      const repo = createSystemPaymentsRepository(env);
      await repo.advanceConfirmedTransfers({
        polled: [
          {
            transferId: "xfr_regression_wrong_org",
            organizationId: "org_other",
            finalized: true,
            slot: 555,
          },
        ],
        updatedAt: new Date().toISOString(),
      });

      const untouched = await getTransfer("xfr_regression_wrong_org");
      expect(untouched?.status).toBe("confirmed");
      expect(untouched?.slot).toBeNull();
      expect(untouched?.finalization_last_polled_at).toBeNull();
    });
  });
});
