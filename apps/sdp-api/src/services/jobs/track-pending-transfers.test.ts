import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  type Signature,
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_HISTORY_NOT_AVAILABLE,
} from "@solana/kit";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresPaymentTransferBatchesRepository } from "@/db/repositories/payment-transfer-batches.repository.postgres";
import * as paymentsRepositoryPostgres from "@/db/repositories/payments.repository.postgres";
import { createSystemPaymentsRepository } from "@/db/repositories/repository-factory";
import { runInEachClusterScope } from "@/runtime/cluster-scope-runs";
import { rootLogger } from "@/runtime/logger";
import {
  type ClusterRpcReply,
  type ClusterRpcRequest,
  epochInfoResult,
  installClusterRpcResponder,
  type JsonRpcResult,
  type SignatureStatusesRead,
  type StubSignatureStatus,
  signatureStatusesRead,
  signatureStatusesReply,
  signatureStatusesReplyAt,
} from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedProcessingBatchChunk } from "@/test/helpers/transfer-batches";
import { seedTestDatabase } from "@/test/mocks/db";
import { trackPendingTransfers } from "./track-pending-transfers";

const TEST_SIG_1 =
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as unknown as Signature;
const TEST_SIG_2 =
  "5hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as unknown as Signature;
const TEST_SIG_3 =
  "6hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as unknown as Signature;
const TEST_SIG_4 =
  "7hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as unknown as Signature;

const TEST_ORG_ID = "org_job_test_001";
const TEST_USER_ID = "usr_job_test_001";
const TEST_PROJECT_IDS = {
  sandbox: "prj_job_test_sandbox",
  production: "prj_job_test_production",
} as const satisfies Record<SdpEnvironment, string>;

const HISTORY_UNAVAILABLE: ClusterRpcReply = {
  error: {
    code: SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_HISTORY_NOT_AVAILABLE,
    message: "Transaction history is not available from this node",
  },
};
const NODE_UNHEALTHY: ClusterRpcReply = {
  error: {
    code: SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
    message: "Node is unhealthy",
  },
};
const INTERNAL_ERROR: ClusterRpcReply = {
  error: { code: SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, message: "Internal error" },
};

const FLOOR_SLOT = 5_000;
const LAST_VALID_BLOCK_HEIGHT = 100;
const HISTORY_HORIZON_BLOCKS = 9_000;
const SOURCE_ADDRESS = "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ";
const DESTINATION_ADDRESS = "9dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ";

function finalizedTipAt(blockHeight: number): JsonRpcResult {
  return epochInfoResult({ absoluteSlot: FLOOR_SLOT, blockHeight });
}

function trackSandboxTransfers(): Promise<void> {
  return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
    trackPendingTransfers(env)
  );
}

async function seedOrg(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG_ID, "Job Test Org", "job-test-org", "individual", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER_ID, "job-test@example.com"),
  ]);
  await seedDefaultProjects(db, {
    organizationId: TEST_ORG_ID,
    createdBy: TEST_USER_ID,
    members: [],
    ids: TEST_PROJECT_IDS,
  });
}

interface TransferSeed {
  id: string;
  status: string;
  signature?: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  signedTransaction?: string;
  lastValidBlockHeight?: string;
  submissionStartedAt?: string | null;
  type?: string;
}

function signedSubmission(seed: {
  id: string;
  signature: Signature;
  submissionStartedAt: string | null;
  updatedAt: string;
}): TransferSeed {
  return {
    id: seed.id,
    status: "processing",
    signature: String(seed.signature),
    signedTransaction: "AQ==",
    lastValidBlockHeight: String(LAST_VALID_BLOCK_HEIGHT),
    submissionStartedAt: seed.submissionStartedAt,
    createdAt: seed.updatedAt,
    updatedAt: seed.updatedAt,
  };
}

async function insertTransfer(params: TransferSeed): Promise<void> {
  await insertProjectTransfer(TEST_PROJECT_IDS.sandbox, params);
}

async function insertProjectTransfer(projectId: string, params: TransferSeed): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers
       (id, organization_id, project_id, wallet_id, source_address, destination_address,
        token, amount, type, direction, status, signature, signed_transaction,
        last_valid_block_height, submission_started_at, confirmed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?, ?, ?, ?)`
    )
    .bind(
      params.id,
      TEST_ORG_ID,
      projectId,
      "wal_test",
      SOURCE_ADDRESS,
      DESTINATION_ADDRESS,
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

function spyOnLog(level: "warn" | "error") {
  const log = vi.spyOn(rootLogger, level).mockImplementation(() => undefined);
  onTestFinished(() => log.mockRestore());
  return log;
}

function verdictBySignature(
  statuses: ReadonlyMap<string, StubSignatureStatus | null>
): (signature: string) => StubSignatureStatus | null {
  return (signature) => {
    const status = statuses.get(signature);
    if (status === undefined) {
      throw new Error(`No stubbed status for ${signature}`);
    }
    return status;
  };
}

function failHistoryReads(request: ClusterRpcRequest): ClusterRpcReply {
  const read = signatureStatusesRead(request);
  return read.searchTransactionHistory
    ? HISTORY_UNAVAILABLE
    : signatureStatusesReply(read.signatures.map(() => null));
}

describe("trackPendingTransfers", () => {
  const rpc = installClusterRpcResponder();

  function statusReads(): SignatureStatusesRead[] {
    return rpc.requests
      .filter((request) => request.method === "getSignatureStatuses")
      .map(signatureStatusesRead);
  }

  function epochInfoReads(): number {
    return rpc.calls.filter((call) => call.method === "getEpochInfo").length;
  }

  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedOrg();
    rpc.answer("getEpochInfo", finalizedTipAt(1_000));
    rpc.respondSignatureStatusesAt(FLOOR_SLOT, () => null);
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

      await trackSandboxTransfers();

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

      await trackSandboxTransfers();

      const unchanged = await getTransfer("xfr_recent_processing");
      expect(unchanged?.status).toBe("processing");
    });
  });

  describe("syncProcessingTransfersOnChain", () => {
    it("updates processing transfer to confirmed when signature is confirmed on-chain", async () => {
      rpc.respondSignatureStatuses(() => ({
        slot: 12345,
        confirmations: 10,
        confirmationStatus: "confirmed",
        err: null,
      }));

      await insertTransfer(
        signedSubmission({
          id: "xfr_processing_confirmed",
          signature: TEST_SIG_1,
          submissionStartedAt: minutesAgo(1),
          updatedAt: minutesAgo(1),
        })
      );

      await trackSandboxTransfers();

      const updated = await getTransfer("xfr_processing_confirmed");
      expect(updated?.status).toBe("confirmed");
      expect(updated?.slot).toBe(12345);
    });

    it("updates processing transfer to finalized when signature is finalized on-chain", async () => {
      rpc.respondSignatureStatuses(() => ({
        slot: 99999,
        confirmations: null,
        confirmationStatus: "finalized",
        err: null,
      }));

      await insertTransfer(
        signedSubmission({
          id: "xfr_processing_finalized",
          signature: TEST_SIG_2,
          submissionStartedAt: minutesAgo(1),
          updatedAt: minutesAgo(1),
        })
      );

      await trackSandboxTransfers();

      const updated = await getTransfer("xfr_processing_finalized");
      expect(updated?.status).toBe("finalized");
      expect(updated?.slot).toBe(99999);
      expect(epochInfoReads()).toBe(0);
    });

    it.each([
      { confirmationStatus: "processed", reason: "processed_only" },
      { confirmationStatus: "confirmed", reason: "error_unfinalized" },
    ] as const)(
      "keeps and rotates a transfer whose on-chain error is seen only at $confirmationStatus (APE SOLA9-708)",
      async ({ confirmationStatus, reason }) => {
        rpc.respondSignatureStatuses(() => ({
          slot: 55556,
          confirmations: 0,
          confirmationStatus,
          err: { InstructionError: [0, "InsufficientFunds"] },
        }));
        const warn = spyOnLog("warn");
        const staleAt = minutesAgo(1);

        await insertTransfer(
          signedSubmission({
            id: "xfr_processing_unfinalized_error",
            signature: TEST_SIG_1,
            submissionStartedAt: staleAt,
            updatedAt: staleAt,
          })
        );

        await trackSandboxTransfers();

        const unchanged = await getTransfer("xfr_processing_unfinalized_error");
        expect(unchanged?.status).toBe("processing");
        expect(unchanged?.error).toBeNull();
        expect(unchanged?.updated_at).not.toBe(staleAt);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "sdp_api_payment_submission_unresolved",
            reason,
            transfer_id: "xfr_processing_unfinalized_error",
          }),
          "sdp_api_payment_submission_unresolved"
        );
      }
    );

    it("retries a transient finalized-height failure instead of rotating the row", async () => {
      let epochInfoAttempts = 0;
      rpc.respond("getEpochInfo", () => {
        epochInfoAttempts += 1;
        return epochInfoAttempts === 1
          ? NODE_UNHEALTHY
          : { result: finalizedTipAt(LAST_VALID_BLOCK_HEIGHT + 1) };
      });

      await insertTransfer(
        signedSubmission({
          id: "xfr_epoch_info_transient",
          signature: TEST_SIG_1,
          submissionStartedAt: null,
          updatedAt: minutesAgo(1),
        })
      );

      await trackSandboxTransfers();

      const failed = await getTransfer("xfr_epoch_info_transient");
      expect(failed?.status).toBe("failed");
      expect(epochInfoReads()).toBe(2);
    });

    it("fails an expired signed submission whose broadcast never started without reading history", async () => {
      await insertTransfer(
        signedSubmission({
          id: "xfr_unstarted_outbox_expired",
          signature: TEST_SIG_1,
          submissionStartedAt: null,
          updatedAt: minutesAgo(1),
        })
      );

      await trackSandboxTransfers();

      const failed = await getTransfer("xfr_unstarted_outbox_expired");
      expect(failed?.status).toBe("failed");
      expect(failed?.error).toBe("Transaction not found on chain");
      expect(statusReads()).toEqual([
        { cluster: "devnet", signatures: [TEST_SIG_1], searchTransactionHistory: false },
      ]);
    });

    it("proves expiry from the finalized height and floors the history read at its slot", async () => {
      await insertTransfer(
        signedSubmission({
          id: "xfr_started_outbox_floored",
          signature: TEST_SIG_1,
          submissionStartedAt: minutesAgo(10),
          updatedAt: minutesAgo(10),
        })
      );

      await trackSandboxTransfers();

      expect(
        rpc.requests
          .filter(({ method }) => method !== "getGenesisHash")
          .map(({ method, params }) => ({ method, params }))
      ).toEqual([
        { method: "getSignatureStatuses", params: [[TEST_SIG_1]] },
        { method: "getEpochInfo", params: [] },
        {
          method: "getSignatureStatuses",
          params: [
            [TEST_SIG_1],
            { searchTransactionHistory: true, minContextSlot: FLOOR_SLOT, commitment: "finalized" },
          ],
        },
      ]);
    });

    it.each([
      {
        refusal: "an answer from below the floor",
        historyReply: signatureStatusesReplyAt(FLOOR_SLOT - 10, [null]),
      },
      {
        refusal: "a served -32016",
        historyReply: {
          error: {
            code: SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
            message: "Minimum context slot has not been reached",
            data: { contextSlot: FLOOR_SLOT - 10 },
          },
        },
      },
    ] satisfies readonly { refusal: string; historyReply: ClusterRpcReply }[])(
      "keeps and rotates an expired started submission on $refusal, logging both slots",
      async ({ historyReply }) => {
        rpc.respond("getSignatureStatuses", (request) =>
          signatureStatusesRead(request).searchTransactionHistory
            ? historyReply
            : signatureStatusesReply([null])
        );
        const warn = spyOnLog("warn");
        const staleAt = minutesAgo(10);

        await insertTransfer(
          signedSubmission({
            id: "xfr_started_outbox_node_behind",
            signature: TEST_SIG_1,
            submissionStartedAt: staleAt,
            updatedAt: staleAt,
          })
        );

        await trackSandboxTransfers();

        const unresolved = await getTransfer("xfr_started_outbox_node_behind");
        expect(unresolved?.status).toBe("processing");
        expect(unresolved?.updated_at).not.toBe(staleAt);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "sdp_api_payment_submission_unresolved",
            reason: "node_behind_floor",
            transfer_id: "xfr_started_outbox_node_behind",
            context_slot: String(FLOOR_SLOT - 10),
            min_context_slot: String(FLOOR_SLOT),
          }),
          "sdp_api_payment_submission_unresolved"
        );
      }
    );

    it("fails an expired started submission absent from history at the floor at the horizon's edge", async () => {
      rpc.answer("getEpochInfo", finalizedTipAt(LAST_VALID_BLOCK_HEIGHT + HISTORY_HORIZON_BLOCKS));
      const warn = spyOnLog("warn");
      const startedAt = minutesAgo(10);

      await insertTransfer(
        signedSubmission({
          id: "xfr_started_outbox_not_landed",
          signature: TEST_SIG_1,
          submissionStartedAt: startedAt,
          updatedAt: startedAt,
        })
      );

      await trackSandboxTransfers();

      const failed = await getTransfer("xfr_started_outbox_not_landed");
      expect(failed?.status).toBe("failed");
      expect(failed?.error).toBe("Transaction not found on chain");
      expect(warn).toHaveBeenCalledWith(
        {
          event: "sdp_api_payment_submission_not_landed",
          flow: "reconciler",
          organization_id: TEST_ORG_ID,
          project_id: TEST_PROJECT_IDS.sandbox,
          transfer_id: "xfr_started_outbox_not_landed",
          transfer_type: "transfer",
          signature: TEST_SIG_1,
          last_valid_block_height: String(LAST_VALID_BLOCK_HEIGHT),
          submission_started_at: startedAt,
          finalized_block_height: String(LAST_VALID_BLOCK_HEIGHT + HISTORY_HORIZON_BLOCKS),
          min_context_slot: String(FLOOR_SLOT),
        },
        "sdp_api_payment_submission_not_landed"
      );
    });

    it("fails an expired, unseen batch chunk with its recipients and recomputes the batch", async () => {
      await insertTransfer({
        ...signedSubmission({
          id: "xfr_batch_chunk_not_landed",
          signature: TEST_SIG_1,
          submissionStartedAt: minutesAgo(10),
          updatedAt: minutesAgo(10),
        }),
        type: "transfer_batch",
      });
      const batchId = await seedProcessingBatchChunk(env, {
        organizationId: TEST_ORG_ID,
        projectId: TEST_PROJECT_IDS.sandbox,
        createdBy: TEST_USER_ID,
        transferId: "xfr_batch_chunk_not_landed",
        sourceAddress: SOURCE_ADDRESS,
        destinationAddress: DESTINATION_ADDRESS,
      });

      await trackSandboxTransfers();

      const batches = createPostgresPaymentTransferBatchesRepository(getDb(env));
      const batchKey = {
        batchId,
        organizationId: TEST_ORG_ID,
        projectId: TEST_PROJECT_IDS.sandbox,
      };
      await expect(getTransfer("xfr_batch_chunk_not_landed")).resolves.toMatchObject({
        status: "failed",
      });
      await expect(batches.getTransferBatchById(batchKey)).resolves.toMatchObject({
        status: "failed",
      });
      await expect(
        batches.listTransferRecipientsByBatch({ ...batchKey, limit: 10, offset: 0 })
      ).resolves.toMatchObject({
        rows: [{ status: "failed", error: "Transaction not found on chain" }],
      });
    });

    it("keeps an expired started submission absent from history past the horizon and alerts", async () => {
      rpc.answer(
        "getEpochInfo",
        finalizedTipAt(LAST_VALID_BLOCK_HEIGHT + HISTORY_HORIZON_BLOCKS + 1)
      );
      const error = spyOnLog("error");
      const startedAt = minutesAgo(10);

      await insertTransfer(
        signedSubmission({
          id: "xfr_started_outbox_unprovable",
          signature: TEST_SIG_1,
          submissionStartedAt: startedAt,
          updatedAt: startedAt,
        })
      );

      await trackSandboxTransfers();

      const kept = await getTransfer("xfr_started_outbox_unprovable");
      expect(kept?.status).toBe("processing");
      expect(kept?.error).toBeNull();
      expect(kept?.updated_at).not.toBe(startedAt);
      expect(error).toHaveBeenCalledWith(
        {
          event: "sdp_api_payment_verdict_unprovable",
          flow: "reconciler",
          organization_id: TEST_ORG_ID,
          project_id: TEST_PROJECT_IDS.sandbox,
          transfer_id: "xfr_started_outbox_unprovable",
          transfer_type: "transfer",
          signature: TEST_SIG_1,
          last_valid_block_height: String(LAST_VALID_BLOCK_HEIGHT),
          submission_started_at: startedAt,
          finalized_block_height: String(LAST_VALID_BLOCK_HEIGHT + HISTORY_HORIZON_BLOCKS + 1),
          min_context_slot: String(FLOOR_SLOT),
        },
        "sdp_api_payment_verdict_unprovable"
      );
    });

    it("leaves alone a row a request confirmed after the tracker listed it", async () => {
      const createRepository = paymentsRepositoryPostgres.createPostgresPaymentsRepository;
      const repositorySpy = vi
        .spyOn(paymentsRepositoryPostgres, "createPostgresPaymentsRepository")
        .mockImplementation((db, scope) => {
          const repository = createRepository(db, scope);
          return {
            ...repository,
            listProcessingSignedSubmissions: async (params) => {
              const queue = await repository.listProcessingSignedSubmissions(params);
              await getDb(env)
                .prepare("UPDATE payment_transfers SET status = 'confirmed', slot = ? WHERE id = ?")
                .bind(4321, "xfr_confirmed_mid_pass")
                .run();
              return queue;
            },
          };
        });
      onTestFinished(() => repositorySpy.mockRestore());

      await insertTransfer(
        signedSubmission({
          id: "xfr_confirmed_mid_pass",
          signature: TEST_SIG_1,
          submissionStartedAt: minutesAgo(10),
          updatedAt: minutesAgo(10),
        })
      );

      await trackSandboxTransfers();

      await expect(getTransfer("xfr_confirmed_mid_pass")).resolves.toMatchObject({
        status: "confirmed",
        slot: 4321,
        error: null,
      });
    });

    it("keeps and rotates expired submissions when archival history is unavailable", async () => {
      rpc.respond("getSignatureStatuses", failHistoryReads);
      const warn = spyOnLog("warn");
      const staleAt = minutesAgo(10);

      await insertTransfer(
        signedSubmission({
          id: "xfr_started_outbox_archive_unavailable",
          signature: TEST_SIG_1,
          submissionStartedAt: staleAt,
          updatedAt: staleAt,
        })
      );

      await trackSandboxTransfers();

      const unresolved = await getTransfer("xfr_started_outbox_archive_unavailable");
      expect(unresolved?.status).toBe("processing");
      expect(unresolved?.updated_at).not.toBe(staleAt);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "sdp_api_payment_submission_unresolved",
          reason: "history_unavailable",
          transfer_id: "xfr_started_outbox_archive_unavailable",
        }),
        "sdp_api_payment_submission_unresolved"
      );
    });

    it("keeps and rotates signed submissions when the finalized height is unavailable", async () => {
      rpc.respond("getEpochInfo", () => INTERNAL_ERROR);
      const staleAt = minutesAgo(10);

      await insertTransfer(
        signedSubmission({
          id: "xfr_started_outbox_height_unavailable",
          signature: TEST_SIG_1,
          submissionStartedAt: staleAt,
          updatedAt: staleAt,
        })
      );

      await trackSandboxTransfers();

      const unresolved = await getTransfer("xfr_started_outbox_height_unavailable");
      expect(unresolved?.status).toBe("processing");
      expect(unresolved?.updated_at).not.toBe(staleAt);
      expect(statusReads()).toHaveLength(1);
    });

    it("applies archival verdicts to the matching signatures", async () => {
      const archived = verdictBySignature(
        new Map<string, StubSignatureStatus | null>([
          [
            String(TEST_SIG_1),
            { slot: 301, confirmations: 1, confirmationStatus: "confirmed", err: null },
          ],
          [
            String(TEST_SIG_2),
            { slot: 302, confirmations: null, confirmationStatus: "finalized", err: null },
          ],
          [
            String(TEST_SIG_3),
            {
              slot: 303,
              confirmations: null,
              confirmationStatus: "finalized",
              err: { InstructionError: [0, "InsufficientFunds"] },
            },
          ],
          [
            String(TEST_SIG_4),
            { slot: 304, confirmations: 1, confirmationStatus: "processed", err: null },
          ],
        ])
      );
      rpc.respondSignatureStatusesAt(FLOOR_SLOT, (signature, read) =>
        read.searchTransactionHistory ? archived(signature) : null
      );
      const staleAt = minutesAgo(10);
      const rows = [
        ["xfr_archive_a_confirmed", TEST_SIG_1],
        ["xfr_archive_b_finalized", TEST_SIG_2],
        ["xfr_archive_c_failed", TEST_SIG_3],
        ["xfr_archive_d_processed", TEST_SIG_4],
      ] as const;
      for (const [id, signature] of rows) {
        await insertTransfer(
          signedSubmission({ id, signature, submissionStartedAt: staleAt, updatedAt: staleAt })
        );
      }

      await trackSandboxTransfers();

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
      rpc.respondSignatureStatuses(() => ({
        slot: 401,
        confirmations: 1,
        confirmationStatus: "confirmed",
        err: null,
      }));
      const staleAt = minutesAgo(10);

      await insertTransfer({
        ...signedSubmission({
          id: "xfr_batch_verdict_write_failed",
          signature: TEST_SIG_1,
          submissionStartedAt: staleAt,
          updatedAt: staleAt,
        }),
        type: "transfer_batch",
      });

      await trackSandboxTransfers();

      const unresolved = await getTransfer("xfr_batch_verdict_write_failed");
      expect(unresolved?.status).toBe("processing");
      expect(unresolved?.updated_at).not.toBe(staleAt);
    });

    it("uses the finalized height rather than row age to expire a signed submission", async () => {
      rpc.answer("getEpochInfo", finalizedTipAt(LAST_VALID_BLOCK_HEIGHT));

      await insertTransfer(
        signedSubmission({
          id: "xfr_started_outbox_not_expired",
          signature: TEST_SIG_1,
          submissionStartedAt: minutesAgo(10),
          updatedAt: minutesAgo(10),
        })
      );

      await trackSandboxTransfers();

      const unchanged = await getTransfer("xfr_started_outbox_not_expired");
      expect(unchanged?.status).toBe("processing");
      expect(statusReads()).toHaveLength(1);
    });

    it("reconciles mixed processing rows in one Postgres-backed run", async () => {
      rpc.respondSignatureStatuses(() => ({
        slot: 22222,
        confirmations: 3,
        confirmationStatus: "confirmed",
        err: null,
      }));

      await insertTransfer(
        signedSubmission({
          id: "xfr_batch_processing_confirmed",
          signature: TEST_SIG_1,
          submissionStartedAt: minutesAgo(2),
          updatedAt: minutesAgo(2),
        })
      );
      await insertTransfer({
        id: "xfr_batch_processing_stuck",
        status: "processing",
        signature: null,
        createdAt: minutesAgo(7),
        updatedAt: minutesAgo(7),
      });

      await trackSandboxTransfers();

      const [confirmed, stuck] = await Promise.all([
        getTransfer("xfr_batch_processing_confirmed"),
        getTransfer("xfr_batch_processing_stuck"),
      ]);

      expect(confirmed?.status).toBe("confirmed");
      expect(confirmed?.slot).toBe(22222);
      expect(stuck?.status).toBe("failed");
      expect(stuck?.error).toBe("Transfer processing timed out");
    });

    it("does not call getSignatureStatuses when there are no processing transfers with signatures", async () => {
      await insertTransfer({
        id: "xfr_processing_without_sig",
        status: "processing",
        signature: null,
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

      await trackSandboxTransfers();

      expect(statusReads()).toEqual([]);
    });

    it("reads each project's processing transfers on its environment's cluster in one tick", async () => {
      rpc.respondSignatureStatuses((_signature, read) =>
        read.cluster === "mainnet-beta"
          ? { slot: 501, confirmations: 1, confirmationStatus: "confirmed", err: null }
          : { slot: 502, confirmations: null, confirmationStatus: "finalized", err: null }
      );

      await insertProjectTransfer(
        TEST_PROJECT_IDS.production,
        signedSubmission({
          id: "xfr_production_processing",
          signature: TEST_SIG_1,
          submissionStartedAt: minutesAgo(1),
          updatedAt: minutesAgo(1),
        })
      );
      await insertTransfer(
        signedSubmission({
          id: "xfr_sandbox_processing",
          signature: TEST_SIG_2,
          submissionStartedAt: minutesAgo(1),
          updatedAt: minutesAgo(1),
        })
      );

      await runInEachClusterScope(() => trackPendingTransfers(env));

      expect(statusReads()).toContainEqual({
        cluster: "mainnet-beta",
        signatures: [TEST_SIG_1],
        searchTransactionHistory: false,
      });
      expect(statusReads()).toContainEqual({
        cluster: "devnet",
        signatures: [TEST_SIG_2],
        searchTransactionHistory: false,
      });
      await expect(getTransfer("xfr_production_processing")).resolves.toMatchObject({
        status: "confirmed",
        slot: 501,
      });
      await expect(getTransfer("xfr_sandbox_processing")).resolves.toMatchObject({
        status: "finalized",
        slot: 502,
      });
    });

    it("applies one cluster's verdicts when the other cluster's status read fails", async () => {
      rpc.respond("getSignatureStatuses", (request) => {
        const read = signatureStatusesRead(request);
        return read.cluster === "mainnet-beta"
          ? INTERNAL_ERROR
          : signatureStatusesReply(
              read.signatures.map(
                (): StubSignatureStatus => ({
                  slot: 701,
                  confirmations: 1,
                  confirmationStatus: "confirmed",
                  err: null,
                })
              )
            );
      });
      const updatedAt = minutesAgo(1);

      await insertProjectTransfer(
        TEST_PROJECT_IDS.production,
        signedSubmission({
          id: "xfr_production_read_failed",
          signature: TEST_SIG_1,
          submissionStartedAt: updatedAt,
          updatedAt,
        })
      );
      await insertTransfer(
        signedSubmission({
          id: "xfr_sandbox_read_succeeded",
          signature: TEST_SIG_2,
          submissionStartedAt: updatedAt,
          updatedAt,
        })
      );

      await runInEachClusterScope(() => trackPendingTransfers(env));

      await expect(getTransfer("xfr_production_read_failed")).resolves.toMatchObject({
        status: "processing",
        updated_at: updatedAt,
      });
      await expect(getTransfer("xfr_sandbox_read_succeeded")).resolves.toMatchObject({
        status: "confirmed",
        slot: 701,
      });
    });
  });

  describe("finalizeConfirmedTransfers", () => {
    it("upgrades confirmed transfer to finalized, polling with searchTransactionHistory", async () => {
      rpc.respondSignatureStatuses(() => ({
        slot: 77777,
        confirmations: null,
        confirmationStatus: "finalized",
        err: null,
      }));

      await insertTransfer({
        id: "xfr_confirmed_finalizing",
        status: "confirmed",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(3),
        updatedAt: minutesAgo(2),
        confirmedAt: minutesAgo(2),
      });

      await trackSandboxTransfers();

      const updated = await getTransfer("xfr_confirmed_finalizing");
      expect(updated?.status).toBe("finalized");
      expect(updated?.slot).toBe(77777);
      expect(updated?.finalization_last_polled_at).not.toBeNull();
      expect(statusReads()).toContainEqual({
        cluster: "devnet",
        signatures: [TEST_SIG_1],
        searchTransactionHistory: true,
      });
    });

    it("rotates and logs a confirmed transfer whose signature status reads null without touching its status", async () => {
      const warn = spyOnLog("warn");
      await insertTransfer({
        id: "xfr_confirmed_no_status",
        status: "confirmed",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(10),
        updatedAt: minutesAgo(10),
        confirmedAt: minutesAgo(10),
      });

      await trackSandboxTransfers();

      const rotated = await getTransfer("xfr_confirmed_no_status");
      expect(rotated?.status).toBe("confirmed");
      expect(rotated?.finalization_last_polled_at).not.toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "sdp_api_payment_finalization_unproven",
          reason: "status_missing",
          transfer_id: "xfr_confirmed_no_status",
          transaction_error: null,
        }),
        "sdp_api_payment_finalization_unproven"
      );
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

      await trackSandboxTransfers();

      expect(statusReads()).toEqual([]);
      const unchanged = await getTransfer("xfr_confirmed_aged_out");
      expect(unchanged?.status).toBe("confirmed");
    });

    it("rotates the polled page even when the RPC batch call fails", async () => {
      rpc.respond("getSignatureStatuses", () => INTERNAL_ERROR);

      await insertTransfer({
        id: "xfr_confirmed_rpc_failed",
        status: "confirmed",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(3),
        updatedAt: minutesAgo(2),
        confirmedAt: minutesAgo(2),
      });

      await trackSandboxTransfers();

      const rotated = await getTransfer("xfr_confirmed_rpc_failed");
      expect(rotated?.status).toBe("confirmed");
      expect(rotated?.finalization_last_polled_at).not.toBeNull();

      rpc.respondSignatureStatuses(() => ({
        slot: 44444,
        confirmations: null,
        confirmationStatus: "finalized",
        err: null,
      }));

      await trackSandboxTransfers();

      const upgraded = await getTransfer("xfr_confirmed_rpc_failed");
      expect(upgraded?.status).toBe("finalized");
      expect(upgraded?.slot).toBe(44444);
    });

    it("leaves and logs a confirmed transfer whose finalized status carries an error", async () => {
      const warn = spyOnLog("warn");
      rpc.respondSignatureStatuses(() => ({
        slot: 88888,
        confirmations: null,
        confirmationStatus: "finalized",
        err: { InstructionError: [0, { Custom: 1 }] },
      }));

      await insertTransfer({
        id: "xfr_confirmed_errored",
        status: "confirmed",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(3),
        updatedAt: minutesAgo(2),
        confirmedAt: minutesAgo(2),
      });

      await trackSandboxTransfers();

      const unchanged = await getTransfer("xfr_confirmed_errored");
      expect(unchanged?.status).toBe("confirmed");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "sdp_api_payment_finalization_unproven",
          reason: "transaction_error",
          transfer_id: "xfr_confirmed_errored",
          transaction_error: JSON.stringify({ InstructionError: [0, { Custom: 1 }] }),
        }),
        "sdp_api_payment_finalization_unproven"
      );
    });

    it("polls each project's confirmed transfers for finality on its environment's cluster", async () => {
      rpc.respondSignatureStatuses((_signature, read) =>
        read.cluster === "mainnet-beta"
          ? { slot: 601, confirmations: null, confirmationStatus: "finalized", err: null }
          : { slot: 602, confirmations: 1, confirmationStatus: "confirmed", err: null }
      );

      await insertProjectTransfer(TEST_PROJECT_IDS.production, {
        id: "xfr_production_confirmed",
        status: "confirmed",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(3),
        updatedAt: minutesAgo(2),
        confirmedAt: minutesAgo(2),
      });
      await insertTransfer({
        id: "xfr_sandbox_confirmed",
        status: "confirmed",
        signature: String(TEST_SIG_2),
        createdAt: minutesAgo(3),
        updatedAt: minutesAgo(2),
        confirmedAt: minutesAgo(2),
      });

      await runInEachClusterScope(() => trackPendingTransfers(env));

      expect(statusReads()).toContainEqual({
        cluster: "mainnet-beta",
        signatures: [TEST_SIG_1],
        searchTransactionHistory: true,
      });
      expect(statusReads()).toContainEqual({
        cluster: "devnet",
        signatures: [TEST_SIG_2],
        searchTransactionHistory: true,
      });
      await expect(getTransfer("xfr_production_confirmed")).resolves.toMatchObject({
        status: "finalized",
        slot: 601,
      });
      await expect(getTransfer("xfr_sandbox_confirmed")).resolves.toMatchObject({
        status: "confirmed",
        finalization_last_polled_at: expect.any(String),
      });
    });
  });

  describe("cron state regressions", () => {
    it("stamps confirmed_at when the sync pass confirms, and never re-stamps it", async () => {
      rpc.respondSignatureStatuses(() => ({
        slot: 100,
        confirmations: 3,
        confirmationStatus: "confirmed",
        err: null,
      }));

      await insertTransfer(
        signedSubmission({
          id: "xfr_regression_confirmed_at",
          signature: TEST_SIG_1,
          submissionStartedAt: minutesAgo(1),
          updatedAt: minutesAgo(1),
        })
      );

      await trackSandboxTransfers();

      const confirmed = await getTransfer("xfr_regression_confirmed_at");
      expect(confirmed?.status).toBe("confirmed");
      expect(confirmed?.confirmed_at).not.toBeNull();
      const stampedAt = confirmed?.confirmed_at;

      rpc.respondSignatureStatuses(() => ({
        slot: 101,
        confirmations: null,
        confirmationStatus: "finalized",
        err: null,
      }));

      await trackSandboxTransfers();

      const finalized = await getTransfer("xfr_regression_confirmed_at");
      expect(finalized?.status).toBe("finalized");
      expect(finalized?.confirmed_at).toBe(stampedAt);
    });

    it("running the reconciler twice against the same chain state is idempotent", async () => {
      rpc.respondSignatureStatuses(() => ({
        slot: 200,
        confirmations: null,
        confirmationStatus: "finalized",
        err: null,
      }));

      await insertTransfer({
        id: "xfr_regression_double_fire",
        status: "confirmed",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(3),
        updatedAt: minutesAgo(2),
        confirmedAt: minutesAgo(2),
      });

      await trackSandboxTransfers();
      const first = await getTransfer("xfr_regression_double_fire");

      await trackSandboxTransfers();
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
