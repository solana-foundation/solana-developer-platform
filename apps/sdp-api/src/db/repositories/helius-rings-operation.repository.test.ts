import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type {
  HeliusRingsOperationRepository,
  ReserveHeliusRingsIntentInput,
} from "./helius-rings-operation.repository";
import { createPostgresHeliusRingsOperationRepository } from "./helius-rings-operation.repository.postgres";
import type { HeliusRingsWalletRepository } from "./helius-rings-wallet.repository";
import { createPostgresHeliusRingsWalletRepository } from "./helius-rings-wallet.repository.postgres";
import { createPostgresHeliusRingsZoneRepository } from "./helius-rings-zone.repository.postgres";

const TEST_PROJECT_ID = "prj_hro_repo_test";
const OTHER_PROJECT_ID = "prj_hro_repo_other";

let repo: HeliusRingsOperationRepository;
let walletRepo: HeliusRingsWalletRepository;
let walletId: string;

const scope = {
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT_ID,
};

function shieldIntent(
  overrides: Partial<ReserveHeliusRingsIntentInput> = {}
): ReserveHeliusRingsIntentInput {
  return {
    ...scope,
    walletId,
    opType: "shield",
    intentKey: "sha256:shield-1",
    assetMint: "So11111111111111111111111111111111111111112",
    amountRaw: "1000000",
    ...overrides,
  };
}

/** Pins created_at so ordering assertions do not depend on clock resolution. */
async function setCreatedAt(id: string, createdAt: string): Promise<void> {
  await getDb(env)
    .prepare("UPDATE helius_rings_operations SET created_at = ? WHERE id = ?")
    .bind(createdAt, id)
    .run();
}

/** Pins updated_at so the sweep's staleness window is deterministic. */
async function setUpdatedAt(id: string, updatedAt: string): Promise<void> {
  await getDb(env)
    .prepare("UPDATE helius_rings_operations SET updated_at = ? WHERE id = ?")
    .bind(updatedAt, id)
    .run();
}

describe("HeliusRingsOperationRepository (postgres)", () => {
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

    for (const projectId of [TEST_PROJECT_ID, OTHER_PROJECT_ID]) {
      await db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
        )
        .bind(projectId, TEST_ORG.id, projectId, TEST_USER.id)
        .run();
    }

    walletRepo = createPostgresHeliusRingsWalletRepository(db);
    repo = createPostgresHeliusRingsOperationRepository(db);

    const wallet = await walletRepo.createWallet({
      ...scope,
      sdpWalletId: "wal_hro_repo_test",
      name: "Treasury",
      materialTag: "simulated",
    });
    if (!wallet) throw new Error("wallet fixture was not created");
    walletId = wallet.id;
  });

  describe("reserveIntent", () => {
    it("inserts a draft operation and reports it as reserved", async () => {
      const result = await repo.reserveIntent(shieldIntent());

      expect(result.reserved).toBe(true);
      expect(result.operation).toMatchObject({
        wallet_id: walletId,
        op_type: "shield",
        state: "draft",
        intent_key: "sha256:shield-1",
        amount_raw: "1000000",
        failure_code: null,
      });
    });

    it("returns the existing operation on a replay instead of opening a second one", async () => {
      const first = await repo.reserveIntent(shieldIntent());
      // Same intent key, different everything else: a replay must be decided by
      // the key alone, or a retried request with a jittered payload would slip
      // through and move funds twice.
      const replay = await repo.reserveIntent(
        shieldIntent({ amountRaw: "999", toAddr: "somewhere-else" })
      );

      expect(replay.reserved).toBe(false);
      expect(replay.operation.id).toBe(first.operation.id);
      expect(replay.operation.amount_raw).toBe("1000000");
      expect(replay.operation.to_addr).toBeNull();

      const all = await repo.listOperationsByWallet({ ...scope, walletId });
      expect(all).toHaveLength(1);
    });

    it("does not let a replay overwrite work the first attempt already recorded", async () => {
      const first = await repo.reserveIntent(shieldIntent());
      await repo.transitionState({
        ...scope,
        id: first.operation.id,
        expectedState: "draft",
        nextState: "preparing",
        patch: { policyEvaluationId: "pev_1" },
      });

      const replay = await repo.reserveIntent(shieldIntent());

      expect(replay.operation.state).toBe("preparing");
      expect(replay.operation.policy_evaluation_id).toBe("pev_1");
    });

    it("keeps distinct intent keys as distinct operations", async () => {
      await repo.reserveIntent(shieldIntent({ intentKey: "sha256:shield-1" }));
      const second = await repo.reserveIntent(shieldIntent({ intentKey: "sha256:shield-2" }));

      expect(second.reserved).toBe(true);
      const all = await repo.listOperationsByWallet({ ...scope, walletId });
      expect(all).toHaveLength(2);
    });

    it("writes the escrow row and the denormalized unlock time for a timelock", async () => {
      const result = await repo.reserveIntent(
        shieldIntent({
          opType: "timelock_create",
          intentKey: "sha256:timelock-1",
          timelock: { unlockAt: "2026-12-01T00:00:00.000Z", beneficiaryAddr: "beneficiary-1" },
        })
      );

      expect(result.operation.timelock_unlock_at).toBe("2026-12-01T00:00:00.000Z");
      const timelock = await repo.getTimelock({ operationId: result.operation.id });
      expect(timelock).toMatchObject({
        unlock_at: "2026-12-01T00:00:00.000Z",
        beneficiary_addr: "beneficiary-1",
        released_at: null,
      });
    });

    it("pins transfer_mode to the op type", async () => {
      const result = await repo.reserveIntent(
        shieldIntent({
          opType: "transfer_anonymous",
          intentKey: "sha256:transfer-1",
          transferMode: "anonymous",
          toAddr: "recipient-1",
        })
      );

      expect(result.operation.transfer_mode).toBe("anonymous");

      // The DB refuses the pairing that would misreport disclosure.
      await expect(
        repo.reserveIntent(
          shieldIntent({
            opType: "transfer_anonymous",
            intentKey: "sha256:transfer-2",
            transferMode: "registered",
          })
        )
      ).rejects.toMatchObject({ message: expect.stringContaining("transfer_mode") });
    });
  });

  describe("transitionState", () => {
    it("advances when the expected state still holds", async () => {
      const { operation } = await repo.reserveIntent(shieldIntent());

      const moved = await repo.transitionState({
        ...scope,
        id: operation.id,
        expectedState: "draft",
        nextState: "preparing",
      });

      expect(moved?.state).toBe("preparing");
    });

    it("refuses and leaves the row alone when the expectation is stale", async () => {
      const { operation } = await repo.reserveIntent(shieldIntent());
      await repo.transitionState({
        ...scope,
        id: operation.id,
        expectedState: "draft",
        nextState: "preparing",
      });

      // The second worker still believes the operation is a draft.
      const loser = await repo.transitionState({
        ...scope,
        id: operation.id,
        expectedState: "draft",
        nextState: "preparing",
      });

      expect(loser).toBeNull();
      const current = await repo.getOperationById({ ...scope, id: operation.id });
      expect(current?.state).toBe("preparing");
    });

    it("writes only the patched columns and preserves the rest", async () => {
      const { operation } = await repo.reserveIntent(shieldIntent());

      await repo.transitionState({
        ...scope,
        id: operation.id,
        expectedState: "draft",
        nextState: "approval_required",
        patch: { approvalRequestId: "apr_1", policyEvaluationId: "pev_1" },
      });
      const later = await repo.transitionState({
        ...scope,
        id: operation.id,
        expectedState: "approval_required",
        nextState: "proving",
        patch: { proofSource: "simulated" },
      });

      expect(later).toMatchObject({
        state: "proving",
        approval_request_id: "apr_1",
        policy_evaluation_id: "pev_1",
        proof_source: "simulated",
      });
    });

    it("will not transition an operation belonging to another project", async () => {
      const { operation } = await repo.reserveIntent(shieldIntent());

      const crossTenant = await repo.transitionState({
        organizationId: TEST_ORG.id,
        projectId: OTHER_PROJECT_ID,
        id: operation.id,
        expectedState: "draft",
        nextState: "preparing",
      });

      expect(crossTenant).toBeNull();
    });
  });

  describe("failOperation", () => {
    it("records the whole failure triple", async () => {
      const { operation } = await repo.reserveIntent(shieldIntent());
      await repo.transitionState({
        ...scope,
        id: operation.id,
        expectedState: "draft",
        nextState: "preparing",
      });

      const failed = await repo.failOperation({
        ...scope,
        id: operation.id,
        expectedState: "preparing",
        code: "gateway_unavailable",
        message: "rings gateway is not implemented",
        retryable: true,
      });

      expect(failed).toMatchObject({
        state: "failed",
        failure_code: "gateway_unavailable",
        failure_message: "rings gateway is not implemented",
        retryable: true,
      });
    });

    it("refuses when the expected state is stale", async () => {
      const { operation } = await repo.reserveIntent(shieldIntent());

      const result = await repo.failOperation({
        ...scope,
        id: operation.id,
        expectedState: "submitted",
        code: "submit_failed",
        message: "nope",
        retryable: false,
      });

      expect(result).toBeNull();
    });
  });

  describe("zone destinations", () => {
    it("rejects a zone owned by another wallet", async () => {
      const other = await walletRepo.createWallet({
        ...scope,
        sdpWalletId: "wal_hro_zone_other",
        name: "Operations",
        materialTag: "simulated",
      });
      if (!other) throw new Error("wallet fixture was not created");
      const zone = await createPostgresHeliusRingsZoneRepository(getDb(env)).createZone({
        walletId: other.id,
        name: "Payroll",
        kind: "treasury",
      });
      if (!zone) throw new Error("zone fixture was not created");

      // The composite (zone_id, wallet_id) FK refuses the cross-wallet reference.
      await expect(
        repo.reserveIntent(shieldIntent({ intentKey: "sha256:cross-zone", zoneId: zone.id }))
      ).rejects.toMatchObject({ message: expect.stringContaining("zone") });
    });
  });

  describe("retry lineage", () => {
    it("links a retry to the operation it replaces", async () => {
      const first = await repo.reserveIntent(shieldIntent());
      const retry = await repo.reserveIntent(
        shieldIntent({ intentKey: "sha256:shield-retry", retryOfOperationId: first.operation.id })
      );

      expect(retry.operation.retry_of_operation_id).toBe(first.operation.id);
    });
  });

  describe("reads", () => {
    it("scopes lookups to the tenant that owns the operation", async () => {
      const { operation } = await repo.reserveIntent(shieldIntent());

      expect(
        await repo.getOperationById({
          organizationId: TEST_ORG.id,
          projectId: OTHER_PROJECT_ID,
          id: operation.id,
        })
      ).toBeNull();
      expect(
        await repo.getOperationByIntentKey({
          organizationId: TEST_ORG.id,
          projectId: OTHER_PROJECT_ID,
          intentKey: "sha256:shield-1",
        })
      ).toBeNull();
      expect(
        await repo.getOperationByIntentKey({ ...scope, intentKey: "sha256:shield-1" })
      ).toMatchObject({ id: operation.id });
    });

    it("lists newest first", async () => {
      const older = await repo.reserveIntent(shieldIntent({ intentKey: "sha256:older" }));
      const newer = await repo.reserveIntent(shieldIntent({ intentKey: "sha256:newer" }));
      await setCreatedAt(older.operation.id, "2026-01-01T00:00:00.000Z");
      await setCreatedAt(newer.operation.id, "2026-02-01T00:00:00.000Z");

      const listed = await repo.listOperationsByProject(scope);
      expect(listed.map((row) => row.id)).toEqual([newer.operation.id, older.operation.id]);
    });

    it("honours the list limit", async () => {
      await repo.reserveIntent(shieldIntent({ intentKey: "sha256:a" }));
      await repo.reserveIntent(shieldIntent({ intentKey: "sha256:b" }));

      expect(await repo.listOperationsByWallet({ ...scope, walletId, limit: 1 })).toHaveLength(1);
    });
  });

  describe("listInFlightOperations", () => {
    it("returns only non-terminal operations older than the staleness cutoff", async () => {
      const inFlight = await repo.reserveIntent(shieldIntent({ intentKey: "sha256:in-flight" }));
      const draft = await repo.reserveIntent(shieldIntent({ intentKey: "sha256:draft" }));
      const done = await repo.reserveIntent(shieldIntent({ intentKey: "sha256:done" }));
      const fresh = await repo.reserveIntent(shieldIntent({ intentKey: "sha256:fresh" }));

      for (const id of [inFlight.operation.id, done.operation.id, fresh.operation.id]) {
        await repo.transitionState({
          ...scope,
          id,
          expectedState: "draft",
          nextState: "submitted",
        });
      }
      await repo.transitionState({
        ...scope,
        id: done.operation.id,
        expectedState: "submitted",
        nextState: "completed",
      });

      await setUpdatedAt(inFlight.operation.id, "2026-01-01T00:00:00.000Z");
      await setUpdatedAt(draft.operation.id, "2026-01-01T00:00:00.000Z");
      await setUpdatedAt(done.operation.id, "2026-01-01T00:00:00.000Z");

      const swept = await repo.listInFlightOperations({ staleBefore: "2026-06-01T00:00:00.000Z" });

      // `draft` is excluded because nothing is in flight yet, `completed`
      // because it is terminal, and the fresh row because it was just touched.
      expect(swept.map((row) => row.id)).toEqual([inFlight.operation.id]);
    });
  });

  describe("timelocks", () => {
    async function reserveTimelock(key: string, unlockAt: string): Promise<string> {
      const result = await repo.reserveIntent(
        shieldIntent({
          opType: "timelock_create",
          intentKey: key,
          timelock: { unlockAt, beneficiaryAddr: "beneficiary-1" },
        })
      );
      return result.operation.id;
    }

    it("lists only escrows whose unlock time has passed and that are still held", async () => {
      const due = await reserveTimelock("sha256:due", "2026-01-01T00:00:00.000Z");
      const notDue = await reserveTimelock("sha256:not-due", "2027-01-01T00:00:00.000Z");
      const released = await reserveTimelock("sha256:released", "2026-01-01T00:00:00.000Z");
      await repo.releaseTimelock({
        operationId: released,
        releasedAt: "2026-02-01T00:00:00.000Z",
      });

      const releasable = await repo.listReleasableTimelocks({ asOf: "2026-06-01T00:00:00.000Z" });

      expect(releasable.map((row) => row.operation_id)).toEqual([due]);
      expect(releasable.map((row) => row.operation_id)).not.toContain(notDue);
    });

    it("releases once, so a double sweep cannot pay a beneficiary twice", async () => {
      const operationId = await reserveTimelock("sha256:once", "2026-01-01T00:00:00.000Z");

      const first = await repo.releaseTimelock({
        operationId,
        releasedAt: "2026-02-01T00:00:00.000Z",
      });
      const second = await repo.releaseTimelock({
        operationId,
        releasedAt: "2026-03-01T00:00:00.000Z",
      });

      expect(first?.released_at).toBe("2026-02-01T00:00:00.000Z");
      expect(second).toBeNull();
      const stored = await repo.getTimelock({ operationId });
      expect(stored?.released_at).toBe("2026-02-01T00:00:00.000Z");
    });

    it("refuses a release dated before the unlock time", async () => {
      const operationId = await reserveTimelock("sha256:early", "2026-06-01T00:00:00.000Z");

      await expect(
        repo.releaseTimelock({ operationId, releasedAt: "2026-01-01T00:00:00.000Z" })
      ).rejects.toMatchObject({ message: expect.stringContaining("released_after_unlock") });
    });
  });
});
