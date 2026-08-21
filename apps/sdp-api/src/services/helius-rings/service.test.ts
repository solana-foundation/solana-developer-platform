import type { PrivateOperationInput } from "@sdp/helius-rings";
import { InMemoryRingsGateway } from "@sdp/helius-rings/testing";
import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import type { PolicyDecision } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createHeliusRingsWalletRepository } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { signedRingsTransaction } from "@/test/fixtures/rings-transactions";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { RingsAdapterError } from "./adapter-error";
import {
  computeIntentKey,
  createHeliusRingsService,
  type HeliusRingsServiceDependencies,
} from "./service";

const TEST_PROJECT_ID = "prj_hrs_service_test";
const tenant = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };

let walletId: string;

function policyStub(
  decision: PolicyDecision,
  overrides: { requiresApproval?: boolean; approvalRequestId?: string | null } = {}
): HeliusRingsServiceDependencies["enforcePolicy"] {
  return async () =>
    ({
      operation: { id: "wop_1" },
      evaluation: {
        id: "pev_1",
        decision,
        reason: decision === "deny" ? "denied by wallet policy" : null,
        requiresApproval: overrides.requiresApproval ?? false,
        approvalRequestId: overrides.approvalRequestId ?? null,
      },
    }) as unknown as WalletOperationPolicyEnforcement;
}

function operationInput(overrides: Partial<PrivateOperationInput> = {}): PrivateOperationInput {
  return {
    walletId,
    opType: "shield",
    asset: { mint: "So11111111111111111111111111111111111111112", amountRaw: "1000000" },
    clientNonce: "nonce-1",
    ...overrides,
  };
}

const actorContext = { apiKeyId: "key_1", actor: null, custodyWalletId: "cw_1" };

function service(deps: HeliusRingsServiceDependencies = {}) {
  return createHeliusRingsService(env, tenant, {
    enforcePolicy: policyStub("allow"),
    ...deps,
  });
}

const OUTER_TX = signedRingsTransaction(7);

/**
 * A service whose gateway succeeds and whose sign/submit adapters are stubbed.
 * The signer returns real wire bytes because the service derives the outer
 * signature from them before it broadcasts.
 */
function liveishService(deps: HeliusRingsServiceDependencies = {}) {
  return service({
    gateway: new InMemoryRingsGateway(),
    signOuterTransaction: async () => OUTER_TX.signedTxBase64,
    submitOuterTransaction: async () => OUTER_TX.signature,
    ...deps,
  });
}

describe("HeliusRingsService", () => {
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
      sdpWalletId: "wal_hrs_service_test",
      name: "Treasury",
      materialTag: "simulated",
    });
    if (!wallet) throw new Error("wallet fixture was not created");
    walletId = wallet.id;
  });

  describe("devnet guard", () => {
    it("refuses to construct outside devnet", () => {
      expect(() =>
        createHeliusRingsService({ ...env, SOLANA_NETWORK: "mainnet-beta" }, tenant)
      ).toThrow(AppError);
    });
  });

  describe("provisionPrivateWallet", () => {
    it("provisions through the gateway and marks the wallet ready", async () => {
      const wallet = await service({ gateway: new InMemoryRingsGateway() }).provisionPrivateWallet({
        sdpWalletId: "wal_prov_1",
        sdpAddress: "addr1",
        name: "Ops",
      });

      expect(wallet.status).toBe("ready");
      expect(wallet.shieldedAddress).toMatch(/^rings1/);
    });

    it("leaves the wallet pending when the gateway is not implemented", async () => {
      const result = await service()
        .provisionPrivateWallet({ sdpWalletId: "wal_prov_2", sdpAddress: "addr2", name: "Ops" })
        .then(
          () => null,
          (error: unknown) => error
        );

      // The route maps this to a 503; the wizard renders the pending state.
      expect(result).toMatchObject({ code: "gateway_unavailable" });
      const rows = await createHeliusRingsWalletRepository(env).getWalletBySdpWalletId({
        ...tenant,
        sdpWalletId: "wal_prov_2",
      });
      expect(rows?.status).toBe("pending");
    });
  });

  describe("prepareOperation", () => {
    it("is idempotent: the same client nonce returns the same operation", async () => {
      const svc = service();
      const first = await svc.prepareOperation(operationInput(), actorContext);
      const replay = await svc.prepareOperation(operationInput(), actorContext);

      expect(replay.id).toBe(first.id);
      expect(replay.intentKey).toBe(computeIntentKey(operationInput()));
    });

    it("ends in failed:policy_denied when the policy denies", async () => {
      const operation = await service({ enforcePolicy: policyStub("deny") }).prepareOperation(
        operationInput({ clientNonce: "nonce-deny" }),
        actorContext
      );

      expect(operation.state).toBe("failed");
      expect(operation.failure).toMatchObject({ code: "policy_denied", retryable: false });
    });

    it("pauses at approval_required and records the approval request", async () => {
      const operation = await service({
        enforcePolicy: policyStub("approval_required", {
          requiresApproval: true,
          approvalRequestId: "apr_1",
        }),
      }).prepareOperation(operationInput({ clientNonce: "nonce-approval" }), actorContext);

      expect(operation.state).toBe("approval_required");
      expect(operation.approvalRequestId).toBe("apr_1");
      expect(operation.policyEvaluationId).toBe("pev_1");
    });

    it("fails honestly at the port when the gateway is not implemented", async () => {
      const operation = await service().prepareOperation(
        operationInput({ clientNonce: "nonce-notimpl" }),
        actorContext
      );

      expect(operation.state).toBe("failed");
      expect(operation.failure).toMatchObject({ code: "gateway_unavailable", retryable: true });
    });

    it("drives an allowed operation through sign and submit to indexing", async () => {
      const operation = await liveishService().prepareOperation(
        operationInput({ clientNonce: "nonce-live" }),
        actorContext
      );

      expect(operation.state).toBe("indexing");
      expect(operation.outerTxSignature).toBe(OUTER_TX.signature);
    });

    it("persists the outer signature before broadcasting", async () => {
      const operation = await liveishService({
        submitOuterTransaction: async () => {
          throw new RingsAdapterError("submit_failed", "rpc down", { retryable: true });
        },
      }).prepareOperation(operationInput({ clientNonce: "nonce-submit" }), actorContext);

      expect(operation.state).toBe("failed");
      expect(operation.failure).toMatchObject({ code: "submit_failed", retryable: true });
      // The signature was durable before the RPC call, so a transaction that
      // landed anyway is still recoverable from the row.
      expect(operation.outerTxSignature).toBe(OUTER_TX.signature);
    });

    it("fails as signer_failed when the signer returns undecodable bytes", async () => {
      const operation = await liveishService({
        signOuterTransaction: async () => "c2lnbmVk",
      }).prepareOperation(operationInput({ clientNonce: "nonce-garbage" }), actorContext);

      expect(operation.state).toBe("failed");
      expect(operation.failure).toMatchObject({ code: "signer_failed", retryable: false });
    });

    it("takes the signer's fail edge when custody signing fails", async () => {
      const operation = await liveishService({
        signOuterTransaction: async () => {
          throw new RingsAdapterError("signer_failed", "signer down", { retryable: true });
        },
      }).prepareOperation(operationInput({ clientNonce: "nonce-signer" }), actorContext);

      expect(operation.state).toBe("failed");
      expect(operation.failure).toMatchObject({ code: "signer_failed", retryable: true });
    });
  });

  describe("executeOperation", () => {
    it("advances only once the stored approval reads approved", async () => {
      let approvalStatus: "pending" | "approved" = "pending";
      const svc = liveishService({
        enforcePolicy: policyStub("approval_required", {
          requiresApproval: true,
          approvalRequestId: "apr_1",
        }),
        getApprovalStatus: async () => approvalStatus,
      });
      const paused = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-exec" }),
        actorContext
      );
      expect(paused.state).toBe("approval_required");

      // The verdict comes from the approval request, never the caller: while
      // it reads pending, execute is inert no matter how often it is called.
      const stillPaused = await svc.executeOperation(paused.id);
      expect(stillPaused.state).toBe("approval_required");

      approvalStatus = "approved";
      const advanced = await svc.executeOperation(paused.id);
      expect(advanced.state).toBe("indexing");
    });

    it("fails a rejected approval as non-retryable", async () => {
      const svc = liveishService({
        enforcePolicy: policyStub("approval_required", {
          requiresApproval: true,
          approvalRequestId: "apr_1",
        }),
        getApprovalStatus: async () => "rejected",
      });
      const paused = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-reject" }),
        actorContext
      );

      const rejected = await svc.executeOperation(paused.id);
      expect(rejected.state).toBe("failed");
      expect(rejected.failure).toMatchObject({ code: "approval_rejected", retryable: false });
    });

    it("polls indexing idempotently and completes on the Photon hit", async () => {
      let now = "2026-08-18T00:00:00.000Z";
      const gateway = new InMemoryRingsGateway({ now: () => now, indexingDelayMs: 1000 });
      const svc = liveishService({ gateway });
      const operation = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-index" }),
        actorContext
      );
      expect(operation.state).toBe("indexing");

      gateway.recordSubmission(OUTER_TX.signature);
      // Photon has not indexed yet: repeated polls change nothing.
      expect((await svc.executeOperation(operation.id)).state).toBe("indexing");
      expect((await svc.executeOperation(operation.id)).state).toBe("indexing");

      now = "2026-08-18T00:00:02.000Z";
      const completed = await svc.executeOperation(operation.id);
      expect(completed.state).toBe("completed");
      expect(completed.photonIndexedAt).toBe(now);

      // Executing a terminal operation is a no-op.
      expect((await svc.executeOperation(operation.id)).state).toBe("completed");
    });

    it("resumes a broadcast stranded in submitted", async () => {
      const gateway = new InMemoryRingsGateway({ indexingDelayMs: 0 });
      const svc = liveishService({ gateway });
      const operation = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-stranded" }),
        actorContext
      );
      expect(operation.state).toBe("indexing");

      // Exactly the row a process that died between the RPC broadcast and the
      // submitted → indexing commit leaves behind: the signature is durable,
      // the state never moved on.
      await getDb(env)
        .prepare("UPDATE helius_rings_operations SET state = 'submitted' WHERE id = ?")
        .bind(operation.id)
        .run();
      gateway.recordSubmission(OUTER_TX.signature);

      // One execute both advances it out of `submitted` and polls Photon, so a
      // stranded broadcast lands in reconciliation instead of sitting forever.
      const resumed = await svc.executeOperation(operation.id);
      expect(resumed.state).toBe("completed");
    });
  });

  describe("retryOperation", () => {
    it("files a linked retry and leaves the failed original untouched", async () => {
      const svc = service();
      const failed = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-retry" }),
        actorContext
      );
      expect(failed.state).toBe("failed");

      const retry = await svc.retryOperation(failed.id, "nonce-retry-2", actorContext);

      expect(retry.id).not.toBe(failed.id);
      expect(retry.intentKey).not.toBe(failed.intentKey);
      const original = await svc.getOperation(failed.id);
      expect(original.state).toBe("failed");

      const detail = await svc.getOperationWithEvents(retry.id);
      expect(detail.events.map((event) => event.kind)).toContain("operation.retried");
    });

    it("refuses to retry a non-retryable failure", async () => {
      const svc = service({ enforcePolicy: policyStub("deny") });
      const denied = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-noretry" }),
        actorContext
      );

      await expect(
        svc.retryOperation(denied.id, "nonce-noretry-2", actorContext)
      ).rejects.toMatchObject({
        code: "CONFLICT",
      });
    });

    it("caps the retry lineage depth", async () => {
      const svc = service();
      let current = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-depth-0" }),
        actorContext
      );
      expect(current.state).toBe("failed");

      // Depth 1 is the original; four retries reach the cap of five.
      for (let attempt = 1; attempt < 5; attempt++) {
        current = await svc.retryOperation(current.id, `nonce-depth-${attempt}`, actorContext);
        expect(current.state).toBe("failed");
      }

      await expect(
        svc.retryOperation(current.id, "nonce-depth-5", actorContext)
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining("retry limit"),
      });
    });

    it("refuses to retry an operation that has not failed", async () => {
      const svc = liveishService();
      const inFlight = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-inflight" }),
        actorContext
      );
      expect(inFlight.state).toBe("indexing");

      await expect(svc.retryOperation(inFlight.id, "again", actorContext)).rejects.toMatchObject({
        code: "CONFLICT",
      });
    });
  });

  describe("probeHealth", () => {
    it("records gateway red when the port is not implemented", async () => {
      const health = await service().probeHealth();

      expect(health.gateway).toBe("red");
      // Unobserved components read red, not green.
      expect(health.prover).toBe("red");
    });

    it("records the gateway's component statuses when reachable", async () => {
      const health = await service({
        gateway: new InMemoryRingsGateway({
          health: { rpc: "green", prover: "amber", photon: "green", gateway: "green" },
        }),
      }).probeHealth();

      expect(health).toMatchObject({ rpc: "green", prover: "amber", gateway: "green" });
    });
  });

  describe("event feed", () => {
    it("records the full lifecycle on the timeline", async () => {
      const svc = liveishService();
      const operation = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-events" }),
        actorContext
      );

      const detail = await svc.getOperationWithEvents(operation.id);
      const kinds = detail.events.map((event) => event.kind);
      expect(kinds).toContain("operation.created");
      expect(kinds).toContain("policy.evaluated");
      expect(kinds).toContain("proof.received");
      expect(kinds).toContain("transaction.submitted");
    });
  });
});

describe("computeIntentKey", () => {
  it("is deterministic and nonce-sensitive", () => {
    const base: PrivateOperationInput = {
      walletId: "hrw_1",
      opType: "shield",
      clientNonce: "n1",
    };

    expect(computeIntentKey(base)).toBe(computeIntentKey({ ...base }));
    expect(computeIntentKey(base)).not.toBe(computeIntentKey({ ...base, clientNonce: "n2" }));
    expect(computeIntentKey(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
