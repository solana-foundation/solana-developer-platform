import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  type Signature,
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_HISTORY_NOT_AVAILABLE,
} from "@solana/kit";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getDb } from "@/db/client";
import { createSystemPaymentsRepository } from "@/db/repositories/repository-factory";
import { runInEachClusterScope } from "@/runtime/cluster-scope-runs";
import { rootLogger } from "@/runtime/logger";
import {
  type ClusterRpcReply,
  type ClusterRpcRequest,
  installClusterRpcResponder,
  type SignatureStatusesRead,
  type StubSignatureStatus,
  signatureStatusesRead,
  signatureStatusesReply,
} from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
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
  submissionStartedAt?: string;
  type?: string;
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

  function blockHeightReads(): number {
    return rpc.calls.filter((call) => call.method === "getBlockHeight").length;
  }

  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedOrg();
    rpc.answer("getBlockHeight", 1_000);
    rpc.respondSignatureStatuses(() => null);
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

      await insertTransfer({
        id: "xfr_processing_confirmed",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

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

      await trackSandboxTransfers();

      const updated = await getTransfer("xfr_processing_finalized");
      expect(updated?.status).toBe("finalized");
      expect(updated?.slot).toBe(99999);
      expect(blockHeightReads()).toBe(0);
    });

    it("marks processing transfer as failed when on-chain status has an error", async () => {
      rpc.respondSignatureStatuses(() => ({
        slot: 55555,
        confirmations: 0,
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, "InsufficientFunds"] },
      }));

      await insertTransfer({
        id: "xfr_processing_errored",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

      await trackSandboxTransfers();

      const updated = await getTransfer("xfr_processing_errored");
      expect(updated?.status).toBe("failed");
      expect(updated?.slot).toBe(55555);
      expect(updated?.error).toContain("InsufficientFunds");
    });

    it("marks old processing transfer as failed when signature is absent from transaction history", async () => {
      await insertTransfer({
        id: "xfr_processing_not_found",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(10),
        updatedAt: minutesAgo(10),
      });

      await trackSandboxTransfers();

      const updated = await getTransfer("xfr_processing_not_found");
      expect(updated?.status).toBe("failed");
      expect(updated?.error).toBe("Transaction not found on chain");
      expect(statusReads()).toEqual([
        { cluster: "devnet", signatures: [TEST_SIG_1], searchTransactionHistory: false },
        { cluster: "devnet", signatures: [TEST_SIG_1], searchTransactionHistory: true },
      ]);
    });

    it("finalizes an old processing transfer found in transaction history instead of failing it", async () => {
      rpc.respondSignatureStatuses((_signature, read) =>
        read.searchTransactionHistory
          ? { slot: 77777, confirmations: null, confirmationStatus: "finalized", err: null }
          : null
      );

      await insertTransfer({
        id: "xfr_legacy_in_history",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(10),
        updatedAt: minutesAgo(10),
      });

      await trackSandboxTransfers();

      const updated = await getTransfer("xfr_legacy_in_history");
      expect(updated?.status).toBe("finalized");
      expect(updated?.slot).toBe(77777);
    });

    it("applies archival verdicts to matching legacy transfers in one batch", async () => {
      const archived = verdictBySignature(
        new Map<string, StubSignatureStatus | null>([
          [
            String(TEST_SIG_1),
            { slot: 11111, confirmations: null, confirmationStatus: "finalized", err: null },
          ],
          [String(TEST_SIG_2), null],
          [
            String(TEST_SIG_3),
            {
              slot: 22222,
              confirmations: 0,
              confirmationStatus: "confirmed",
              err: { InstructionError: [0, { Custom: 1 }] },
            },
          ],
        ])
      );
      rpc.respondSignatureStatuses((signature, read) =>
        read.searchTransactionHistory ? archived(signature) : null
      );

      await insertTransfer({
        id: "xfr_legacy_batch_finalized",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(10),
        updatedAt: minutesAgo(10),
      });
      await insertTransfer({
        id: "xfr_legacy_batch_absent",
        status: "processing",
        signature: String(TEST_SIG_2),
        createdAt: minutesAgo(10),
        updatedAt: minutesAgo(10),
      });
      await insertTransfer({
        id: "xfr_legacy_batch_errored",
        status: "processing",
        signature: String(TEST_SIG_3),
        createdAt: minutesAgo(10),
        updatedAt: minutesAgo(10),
      });

      await trackSandboxTransfers();

      const finalized = await getTransfer("xfr_legacy_batch_finalized");
      expect(finalized?.status).toBe("finalized");
      expect(finalized?.slot).toBe(11111);
      const absent = await getTransfer("xfr_legacy_batch_absent");
      expect(absent?.status).toBe("failed");
      expect(absent?.error).toBe("Transaction not found on chain");
      const errored = await getTransfer("xfr_legacy_batch_errored");
      expect(errored?.status).toBe("failed");
      expect(errored?.error).toContain("Custom");
      expect(errored?.slot).toBe(22222);
    });

    it("keeps and rotates an old processing transfer when the transaction-history lookup is unavailable", async () => {
      rpc.respond("getSignatureStatuses", failHistoryReads);
      const staleAt = minutesAgo(10);
      const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => undefined);

      try {
        await insertTransfer({
          id: "xfr_legacy_history_down",
          status: "processing",
          signature: String(TEST_SIG_1),
          createdAt: staleAt,
          updatedAt: staleAt,
        });

        await trackSandboxTransfers();

        const kept = await getTransfer("xfr_legacy_history_down");
        expect(kept?.status).toBe("processing");
        expect(kept?.error).toBeNull();
        expect(kept?.updated_at).not.toBe(staleAt);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "sdp_api_payment_submission_unresolved",
            flow: "reconciler",
            reason: "history_unavailable",
            transfer_id: "xfr_legacy_history_down",
          }),
          expect.any(String)
        );
      } finally {
        warn.mockRestore();
      }
    });

    it("retries a transient getBlockHeight failure instead of rotating the row", async () => {
      let blockHeightAttempts = 0;
      rpc.respond("getBlockHeight", () => {
        blockHeightAttempts += 1;
        return blockHeightAttempts === 1 ? NODE_UNHEALTHY : { result: 101 };
      });

      await insertTransfer({
        id: "xfr_blockheight_transient",
        status: "processing",
        signature: String(TEST_SIG_1),
        signedTransaction: "AQ==",
        lastValidBlockHeight: "100",
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

      await trackSandboxTransfers();

      const failed = await getTransfer("xfr_blockheight_transient");
      expect(failed?.status).toBe("failed");
      expect(blockHeightReads()).toBe(2);
    });

    it("fails an expired signed submission whose broadcast never started", async () => {
      rpc.answer("getBlockHeight", 101);

      await insertTransfer({
        id: "xfr_unstarted_outbox_expired",
        status: "processing",
        signature: String(TEST_SIG_1),
        signedTransaction: "AQ==",
        lastValidBlockHeight: "100",
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

      await trackSandboxTransfers();

      const failed = await getTransfer("xfr_unstarted_outbox_expired");
      expect(failed?.status).toBe("failed");
      expect(failed?.error).toBe("Transaction not found on chain");
      expect(statusReads()).toHaveLength(1);
    });

    it("keeps and rotates an expired started submission when history is inconclusive", async () => {
      rpc.answer("getBlockHeight", 101);
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

        await trackSandboxTransfers();

        const unresolved = await getTransfer("xfr_started_outbox_not_found");
        expect(unresolved?.status).toBe("processing");
        expect(unresolved?.error).toBeNull();
        expect(unresolved?.updated_at).not.toBe(staleAt);
        expect(statusReads().at(-1)).toEqual({
          cluster: "devnet",
          signatures: [TEST_SIG_1],
          searchTransactionHistory: true,
        });
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "sdp_api_payment_submission_unresolved",
            flow: "reconciler",
            reason: "history_absent",
            organization_id: TEST_ORG_ID,
            project_id: TEST_PROJECT_IDS.sandbox,
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
      rpc.respond("getSignatureStatuses", failHistoryReads);
      rpc.answer("getBlockHeight", 101);
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

      await trackSandboxTransfers();

      const unresolved = await getTransfer("xfr_started_outbox_archive_unavailable");
      expect(unresolved?.status).toBe("processing");
      expect(unresolved?.updated_at).not.toBe(staleAt);
    });

    it("keeps and rotates signed submissions when block height is unavailable", async () => {
      rpc.respond("getBlockHeight", () => INTERNAL_ERROR);
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
              confirmations: 0,
              confirmationStatus: "confirmed",
              err: { InstructionError: [0, "InsufficientFunds"] },
            },
          ],
          [
            String(TEST_SIG_4),
            { slot: 304, confirmations: 1, confirmationStatus: "processed", err: null },
          ],
        ])
      );
      rpc.respondSignatureStatuses((signature, read) =>
        read.searchTransactionHistory ? archived(signature) : null
      );
      rpc.answer("getBlockHeight", 101);
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
        id: "xfr_batch_verdict_write_failed",
        type: "transfer_batch",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: staleAt,
        updatedAt: staleAt,
      });

      await trackSandboxTransfers();

      const unresolved = await getTransfer("xfr_batch_verdict_write_failed");
      expect(unresolved?.status).toBe("processing");
      expect(unresolved?.updated_at).not.toBe(staleAt);
    });

    it("uses block height rather than row age to expire a signed submission", async () => {
      rpc.answer("getBlockHeight", 100);

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

      await trackSandboxTransfers();

      const unchanged = await getTransfer("xfr_started_outbox_not_expired");
      expect(unchanged?.status).toBe("processing");
      expect(statusReads()).toHaveLength(1);
    });

    it("leaves processing transfer alone when signature not found but transfer is recent", async () => {
      await insertTransfer({
        id: "xfr_processing_recent_not_found",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

      await trackSandboxTransfers();

      const unchanged = await getTransfer("xfr_processing_recent_not_found");
      expect(unchanged?.status).toBe("processing");
    });

    it("does not rotate a legacy transfer in 'processed' confirmation status", async () => {
      rpc.respondSignatureStatuses(() => ({
        slot: 11111,
        confirmations: 1,
        confirmationStatus: "processed",
        err: null,
      }));
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

        await trackSandboxTransfers();

        const unchanged = await getTransfer("xfr_processing_only_processed");
        expect(unchanged?.status).toBe("processing");
        expect(unchanged?.updated_at).toBe(updatedAt);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it("reconciles mixed processing rows in one Postgres-backed run", async () => {
      rpc.respondSignatureStatuses(() => ({
        slot: 22222,
        confirmations: 3,
        confirmationStatus: "confirmed",
        err: null,
      }));

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

      await insertProjectTransfer(TEST_PROJECT_IDS.production, {
        id: "xfr_production_processing",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });
      await insertTransfer({
        id: "xfr_sandbox_processing",
        status: "processing",
        signature: String(TEST_SIG_2),
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

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

      await insertProjectTransfer(TEST_PROJECT_IDS.production, {
        id: "xfr_production_read_failed",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: updatedAt,
        updatedAt,
      });
      await insertTransfer({
        id: "xfr_sandbox_read_succeeded",
        status: "processing",
        signature: String(TEST_SIG_2),
        createdAt: updatedAt,
        updatedAt,
      });

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

    function spyOnWarn() {
      const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => undefined);
      onTestFinished(() => warn.mockRestore());
      return warn;
    }

    it("rotates and logs a confirmed transfer whose signature status reads null without touching its status", async () => {
      const warn = spyOnWarn();
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
      const warn = spyOnWarn();
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

      await insertTransfer({
        id: "xfr_regression_confirmed_at",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

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
