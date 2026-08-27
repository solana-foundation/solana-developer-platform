import type { RingsGatewayPort } from "@sdp/helius-rings";
import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  createHeliusRingsOperationRepository,
  createHeliusRingsWalletRepository,
} from "@/db/repositories";
import { createHeliusRingsService } from "@/services/helius-rings";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { pipelineGateway } from "@/test/fixtures/rings-gateway";
import { signedRingsTransaction } from "@/test/fixtures/rings-transactions";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  pollRingsIndexing,
  RINGS_INDEXING_TIMEOUT_MS,
  RINGS_SIGNING_TIMEOUT_MS,
} from "./poll-rings-indexing";

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

/** A fully configured deployment: what the poll needs to wake up at all. */
const CONFIGURED_ENV = {
  ...env,
  HELIUS_RINGS_ENABLED: "true",
  HELIUS_RINGS_RPC_URL: "https://rpc.invalid/?api-key=key",
  HELIUS_RINGS_INDEXER_URL: "https://indexer.invalid",
  HELIUS_RINGS_PROVER_URL: "https://prover.invalid",
};

let walletId: string;

/**
 * The port calls the pipeline makes before custody, plus whatever indexing
 * answer the test is about.
 */
function serviceWith(overrides: Partial<RingsGatewayPort>) {
  return createHeliusRingsService(env, tenant, {
    gateway: pipelineGateway(overrides),
    enforcePolicy: allowPolicy,
    signOuterTransaction: async () => OUTER_TX.signedTxBase64,
    submitOuterTransaction: async () => OUTER_TX.signature,
  });
}

/** Photon has the transaction. */
const indexed: Partial<RingsGatewayPort> = {
  verifyIndexed: async () => ({
    indexedAt: "2026-08-18T00:00:00.000Z",
    photonRef: "photon:job",
  }),
};

/** Photon does not have it yet, and will not within this test. */
const notIndexed: Partial<RingsGatewayPort> = { verifyIndexed: async () => null };

describe("pollRingsIndexing", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
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

    const wallet = await createHeliusRingsWalletRepository(env).createWallet({
      ...tenant,
      sdpWalletId: "wal_hr_job_test",
      name: "Treasury",
      materialTag: "simulated",
    });
    if (!wallet) throw new Error("wallet fixture was not created");
    walletId = wallet.id;
  });

  it("does not call Photon when the flag is on but upstreams are unset", async () => {
    const service = serviceWith(indexed);
    const operation = await service.prepareOperation(
      { walletId, opType: "shield", clientNonce: "job-dormant" },
      { apiKeyId: null, actor: null, custodyWalletId: null }
    );
    expect(operation.state).toBe("indexing");

    // Timeouts still run; Photon execute does not.
    await pollRingsIndexing(
      { ...env, HELIUS_RINGS_ENABLED: "true" },
      { createService: () => service }
    );

    const row = await createHeliusRingsOperationRepository(env).getOperationById({
      ...tenant,
      id: operation.id,
    });
    expect(row?.state).toBe("indexing");
  });

  it("ages out indexing even when upstreams are unset", async () => {
    const service = serviceWith(notIndexed);
    const operation = await service.prepareOperation(
      { walletId, opType: "shield", clientNonce: "job-timeout-no-upstreams" },
      { apiKeyId: null, actor: null, custodyWalletId: null }
    );
    expect(operation.state).toBe("indexing");

    await pollRingsIndexing(
      { ...env, HELIUS_RINGS_ENABLED: "true" },
      {
        createService: () => service,
        now: () => new Date(Date.now() + RINGS_INDEXING_TIMEOUT_MS + 60_000),
      }
    );

    const row = await createHeliusRingsOperationRepository(env).getOperationById({
      ...tenant,
      id: operation.id,
    });
    expect(row?.state).toBe("failed");
    expect(row?.failure_code).toBe("indexing_timeout");
    expect(row?.retryable).toBe(true);
  });

  it("completes an indexing operation once Photon reports it", async () => {
    const service = serviceWith(indexed);
    const operation = await service.prepareOperation(
      { walletId, opType: "shield", clientNonce: "job-complete" },
      { apiKeyId: null, actor: null, custodyWalletId: null }
    );
    expect(operation.state).toBe("indexing");

    await pollRingsIndexing(CONFIGURED_ENV, { createService: () => service });

    const row = await createHeliusRingsOperationRepository(env).getOperationById({
      ...tenant,
      id: operation.id,
    });
    expect(row?.state).toBe("completed");
  });

  it("times out an operation stuck in indexing past the budget", async () => {
    const service = serviceWith(notIndexed);
    const operation = await service.prepareOperation(
      { walletId, opType: "shield", clientNonce: "job-timeout" },
      { apiKeyId: null, actor: null, custodyWalletId: null }
    );
    expect(operation.state).toBe("indexing");

    // Sweep from a clock beyond the budget.
    await pollRingsIndexing(CONFIGURED_ENV, {
      createService: () => service,
      now: () => new Date(Date.now() + RINGS_INDEXING_TIMEOUT_MS + 60_000),
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
    const service = serviceWith(indexed);
    const operation = await service.prepareOperation(
      { walletId, opType: "shield", clientNonce: "job-stranded" },
      { apiKeyId: null, actor: null, custodyWalletId: null }
    );
    expect(operation.state).toBe("indexing");

    // The row a process that died between the RPC broadcast and the
    // submitted → indexing commit leaves behind.
    await getDb(env)
      .prepare("UPDATE helius_rings_operations SET state = 'submitted' WHERE id = ?")
      .bind(operation.id)
      .run();

    await pollRingsIndexing(CONFIGURED_ENV, { createService: () => service });

    const row = await createHeliusRingsOperationRepository(env).getOperationById({
      ...tenant,
      id: operation.id,
    });
    expect(row?.state).toBe("completed");
  });

  describe("ready_to_sign", () => {
    /** The row a process that died before recording its signature leaves. */
    async function strandAtReadyToSign(clientNonce: string): Promise<string> {
      const service = serviceWith(notIndexed);
      const operation = await service.prepareOperation(
        { walletId, opType: "shield", clientNonce },
        { apiKeyId: null, actor: null, custodyWalletId: null }
      );
      await getDb(env)
        .prepare(
          "UPDATE helius_rings_operations SET state = 'ready_to_sign', outer_tx_signature = NULL WHERE id = ?"
        )
        .bind(operation.id)
        .run();
      return operation.id;
    }

    // Safe to fail outright, unlike `submitted`: nothing here reached an RPC, so
    // retrying cannot duplicate a payment.
    it("ages out a row abandoned before its signature was recorded", async () => {
      const id = await strandAtReadyToSign("job-unsigned");

      await pollRingsIndexing(CONFIGURED_ENV, {
        createService: () => serviceWith(notIndexed),
        now: () => new Date(Date.now() + RINGS_SIGNING_TIMEOUT_MS + 60_000),
      });

      const row = await createHeliusRingsOperationRepository(env).getOperationById({
        ...tenant,
        id,
      });
      expect(row?.state).toBe("failed");
      expect(row?.failure_code).toBe("signer_failed");
      expect(row?.retryable).toBe(true);
    });

    it("leaves one still inside the budget alone", async () => {
      const id = await strandAtReadyToSign("job-signing");

      await pollRingsIndexing(CONFIGURED_ENV, { createService: () => serviceWith(notIndexed) });

      const row = await createHeliusRingsOperationRepository(env).getOperationById({
        ...tenant,
        id,
      });
      expect(row?.state).toBe("ready_to_sign");
    });
  });
});
