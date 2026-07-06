import type { Signature } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import * as solanaRpc from "@/services/solana/rpc";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { trackPendingTransfers } from "./track-pending-transfers";

const createRpcMock = vi.spyOn(solanaRpc, "createRpc");
const getSignatureStatusesMock = vi.spyOn(solanaRpc, "getSignatureStatuses");

const TEST_SIG_1 =
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as unknown as Signature;
const TEST_SIG_2 =
  "5hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as unknown as Signature;

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
}): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers
       (id, organization_id, wallet_id, source_address, destination_address,
        token, amount, type, direction, status, signature, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.id,
      TEST_ORG_ID,
      "wal_test",
      "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
      "9dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
      "SOL",
      "1.0",
      "transfer",
      "outbound",
      params.status,
      params.signature ?? null,
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
  }>();
}

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

describe("trackPendingTransfers", () => {
  beforeEach(async () => {
    await clearTestDatabase(env);
    await seedTestDatabase(env);
    await seedOrg();
    vi.clearAllMocks();
    createRpcMock.mockReturnValue({} as ReturnType<typeof solanaRpc.createRpc>);
    getSignatureStatusesMock.mockResolvedValue([]);
  });

  afterEach(async () => {
    await clearTestDatabase(env);
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
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

      await trackPendingTransfers(env);

      const updated = await getTransfer("xfr_processing_finalized");
      expect(updated?.status).toBe("finalized");
      expect(updated?.slot).toBe(99999);
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

    it("does not update processing transfers in 'processed' confirmation status", async () => {
      getSignatureStatusesMock.mockResolvedValueOnce([
        {
          slot: 11111n,
          confirmations: 1n,
          confirmationStatus: "processed",
          err: null,
        },
      ]);

      await insertTransfer({
        id: "xfr_processing_only_processed",
        status: "processing",
        signature: String(TEST_SIG_1),
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      });

      await trackPendingTransfers(env);

      const unchanged = await getTransfer("xfr_processing_only_processed");
      expect(unchanged?.status).toBe("processing");
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
});
