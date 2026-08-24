import { InMemoryRingsGateway } from "@sdp/helius-rings/testing";
import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  createHeliusRingsOperationRepository,
  createHeliusRingsWalletRepository,
} from "@/db/repositories";
import { createHeliusRingsService } from "@/services/helius-rings";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { signedRingsTransaction } from "@/test/fixtures/rings-transactions";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { pollRingsIndexing, RINGS_INDEXING_TIMEOUT_MS } from "./poll-rings-indexing";

const TEST_PROJECT_ID = "prj_hr_job_test";
const tenant = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };

const allowPolicy = async () =>
  ({
    operation: { id: "wop_1" },
    evaluation: {
      id: "pev_1",
      decision: "allow",
      reason: null,
      requiresApproval: false,
      approvalRequestId: null,
    },
  }) as unknown as WalletOperationPolicyEnforcement;

const OUTER_TX = signedRingsTransaction(9);

/**
 * The reconciliation sweep sits in front of the indexing poll and asks the chain
 * for its height. These tests are about the poll, so it is told the height is
 * unavailable — which the sweep treats as "judge nothing this tick".
 */
const NO_HEIGHT = async () => null;

let walletId: string;
let jobEnv: typeof env;

function serviceWith(gateway: InMemoryRingsGateway) {
  return createHeliusRingsService(env, tenant, {
    gateway,
    enforcePolicy: allowPolicy,
    signOuterTransaction: async () => OUTER_TX.signedTxBase64,
    submitOuterTransaction: async () => OUTER_TX.signature,
  });
}

describe("pollRingsIndexing", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    jobEnv = { ...env, HELIUS_RINGS_ENABLED: "true", HELIUS_RINGS_ADAPTER: "ts" };
    const db = getDb(env);

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id)
      .run();

    const wallets = createHeliusRingsWalletRepository(env);
    const wallet = await wallets.createWallet({
      ...tenant,
      sdpWalletId: "wal_hr_job_test",
      name: "Treasury",
      materialTag: "simulated",
    });
    if (!wallet) throw new Error("wallet fixture was not created");
    walletId = wallet.id;

    // Provisioned, because every operation here is a spend and the pipeline
    // needs the owner the shielded identity is published under.
    await wallets.markProvisioned({
      ...tenant,
      id: wallet.id,
      shieldedAddress: "rings1jobtestidentity",
      ownerAddress: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      materialTag: "simulated",
      expectedStatus: "pending",
    });
  });

  it("stays dormant unless the flag and the live adapter are both set", async () => {
    const gateway = new InMemoryRingsGateway({ indexingDelayMs: 0 });
    const operation = await serviceWith(gateway).prepareOperation(
      { walletId, opType: "shield", clientNonce: "job-dormant" },
      { apiKeyId: null, actor: null, custodyWalletId: null }
    );
    expect(operation.state).toBe("indexing");
    gateway.recordSubmission(OUTER_TX.signature);

    await pollRingsIndexing(
      { ...env, HELIUS_RINGS_ENABLED: "true" },
      { createService: () => serviceWith(gateway), readBlockHeight: NO_HEIGHT }
    );

    const row = await createHeliusRingsOperationRepository(env).getOperationById({
      ...tenant,
      id: operation.id,
    });
    expect(row?.state).toBe("indexing");
  });

  it("completes an indexing operation once Photon reports it", async () => {
    const gateway = new InMemoryRingsGateway({ indexingDelayMs: 0 });
    const operation = await serviceWith(gateway).prepareOperation(
      { walletId, opType: "shield", clientNonce: "job-complete" },
      { apiKeyId: null, actor: null, custodyWalletId: null }
    );
    expect(operation.state).toBe("indexing");
    gateway.recordSubmission(OUTER_TX.signature);

    await pollRingsIndexing(jobEnv, {
      createService: () => serviceWith(gateway),
      readBlockHeight: NO_HEIGHT,
    });

    const row = await createHeliusRingsOperationRepository(env).getOperationById({
      ...tenant,
      id: operation.id,
    });
    expect(row?.state).toBe("completed");
  });

  it("times out an operation stuck in indexing past the budget", async () => {
    const gateway = new InMemoryRingsGateway({ indexingDelayMs: 60 * 60 * 1000 });
    const operation = await serviceWith(gateway).prepareOperation(
      { walletId, opType: "shield", clientNonce: "job-timeout" },
      { apiKeyId: null, actor: null, custodyWalletId: null }
    );
    expect(operation.state).toBe("indexing");

    // Sweep from a clock beyond the budget: the poll fails it rather than
    // leaving it in limbo.
    await pollRingsIndexing(jobEnv, {
      createService: () => serviceWith(gateway),
      now: () => new Date(Date.now() + RINGS_INDEXING_TIMEOUT_MS + 60_000),
      readBlockHeight: NO_HEIGHT,
    });

    const row = await createHeliusRingsOperationRepository(env).getOperationById({
      ...tenant,
      id: operation.id,
    });
    expect(row?.state).toBe("failed");
    expect(row?.failure_code).toBe("indexing_timeout");
    expect(row?.retryable).toBe(true);
  });

  it("sweeps a broadcast stranded in submitted into reconciliation", async () => {
    const gateway = new InMemoryRingsGateway({ indexingDelayMs: 0 });
    const operation = await serviceWith(gateway).prepareOperation(
      { walletId, opType: "shield", clientNonce: "job-stranded" },
      { apiKeyId: null, actor: null, custodyWalletId: null }
    );
    expect(operation.state).toBe("indexing");
    gateway.recordSubmission(OUTER_TX.signature);

    // Exactly the row a process that died between the RPC broadcast and the
    // submitted → indexing commit leaves behind. Before the sweep covered
    // `submitted`, nothing in the system would ever look at this row again.
    await getDb(env)
      .prepare("UPDATE helius_rings_operations SET state = 'submitted' WHERE id = ?")
      .bind(operation.id)
      .run();

    await pollRingsIndexing(jobEnv, {
      createService: () => serviceWith(gateway),
      readBlockHeight: NO_HEIGHT,
    });

    const row = await createHeliusRingsOperationRepository(env).getOperationById({
      ...tenant,
      id: operation.id,
    });
    expect(row?.state).toBe("completed");
  });

  /**
   * What happens once signed bytes can no longer land. The distinction is not
   * how long it waited but what it consumed: a shield created notes and can be
   * re-attempted, a spend consumed them and might already have settled.
   */
  describe("reconciliation sweep", () => {
    /** Never reports indexed, so nothing completes out from under the sweep. */
    const stalled = () => new InMemoryRingsGateway({ indexingDelayMs: 60 * 60 * 1000 });

    async function strand(opType: "shield" | "withdraw", nonce: string): Promise<string> {
      const gateway = stalled();
      const operation = await serviceWith(gateway).prepareOperation(
        {
          walletId,
          opType,
          asset: { mint: "So11111111111111111111111111111111111111112", amountRaw: "1000" },
          ...(opType === "withdraw" ? { to: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" } : {}),
          clientNonce: nonce,
        },
        { apiKeyId: null, actor: null, custodyWalletId: null }
      );

      // The pipeline persists the expiry from the build; force it low so the
      // sweep sees bytes that can no longer land.
      await getDb(env)
        .prepare("UPDATE helius_rings_operations SET last_valid_block_height = 10 WHERE id = ?")
        .bind(operation.id)
        .run();

      return operation.id;
    }

    it("refuses to offer a retry for a stranded spend", async () => {
      const id = await strand("withdraw", "job-strand-spend");

      await pollRingsIndexing(jobEnv, {
        createService: () => serviceWith(stalled()),
        readBlockHeight: async () => "5000",
      });

      const row = await createHeliusRingsOperationRepository(env).getOperationById({
        ...tenant,
        id,
      });
      // A withdrawal consumed notes. If it landed, retrying pays twice; if it
      // did not, the notes are still there. Only a human can tell which.
      expect(row?.failure_code).toBe("manual_reconciliation_required");
      expect(row?.retryable).toBe(false);
    });

    it("lets a stranded shield be retried", async () => {
      const id = await strand("shield", "job-strand-shield");

      await pollRingsIndexing(jobEnv, {
        createService: () => serviceWith(stalled()),
        readBlockHeight: async () => "5000",
      });

      const row = await createHeliusRingsOperationRepository(env).getOperationById({
        ...tenant,
        id,
      });
      // A deposit consumes no notes, so a fresh attempt cannot double-spend.
      expect(row?.failure_code).toBe("indexing_timeout");
      expect(row?.retryable).toBe(true);
    });

    it("leaves everything alone when the chain height is unknown", async () => {
      const id = await strand("withdraw", "job-strand-unknown");

      await pollRingsIndexing(jobEnv, {
        createService: () => serviceWith(stalled()),
        readBlockHeight: NO_HEIGHT,
      });

      const row = await createHeliusRingsOperationRepository(env).getOperationById({
        ...tenant,
        id,
      });
      // Not knowing the height is a reason to wait, not a reason to escalate.
      expect(row?.state).toBe("indexing");
    });
  });
});
