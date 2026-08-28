import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { HeliusRingsProjectRingRepository } from "./helius-rings-project-ring.repository";
import { mapHeliusRingsProjectRingRow } from "./helius-rings-project-ring.repository";
import { createPostgresHeliusRingsProjectRingRepository } from "./helius-rings-project-ring.repository.postgres";

const TEST_PROJECT_ID = "prj_hrr_repo_test";
const OTHER_PROJECT_ID = "prj_hrr_repo_other";

const RING_PROGRAM = "RingProgram1111111111111111111111111111111";
const OTHER_RING_PROGRAM = "RingProgram2111111111111111111111111111111";

const scope = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };

let repo: HeliusRingsProjectRingRepository;

async function reserve(ringProgramId = RING_PROGRAM) {
  const ring = await repo.reserveRing({ ...scope, ringProgramId });
  if (!ring) throw new Error("ring fixture was not created");
  return ring;
}

describe("HeliusRingsProjectRingRepository (postgres)", () => {
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

    repo = createPostgresHeliusRingsProjectRingRepository(db);
  });

  it("reserves a pending ring with no auditor key", async () => {
    const ring = await reserve();

    expect(ring).toMatchObject({
      ring_program_id: RING_PROGRAM,
      status: "pending",
      auditor_public_key: null,
      failure_code: null,
      failure_message: null,
    });
  });

  it("returns the existing row on a replay, program id and all", async () => {
    const first = await reserve();
    // The caller tells a resume from a re-point by comparing program ids, so
    // the row that already exists must come back unchanged.
    const replay = await reserve(OTHER_RING_PROGRAM);

    expect(replay.id).toBe(first.id);
    expect(replay.ring_program_id).toBe(RING_PROGRAM);
  });

  it("scopes reads to the project", async () => {
    await reserve();

    expect(await repo.getByProject(scope)).not.toBeNull();
    expect(
      await repo.getByProject({ organizationId: TEST_ORG.id, projectId: OTHER_PROJECT_ID })
    ).toBeNull();
  });

  describe("repointRing", () => {
    it("replaces the program id of a never-active ring and resets it to pending", async () => {
      await reserve();
      await repo.markFailed({
        ...scope,
        ringProgramId: RING_PROGRAM,
        failureCode: "invalid_input",
        failureMessage: "not a deployed program",
      });

      const repointed = await repo.repointRing({ ...scope, ringProgramId: OTHER_RING_PROGRAM });

      expect(repointed).toMatchObject({
        ring_program_id: OTHER_RING_PROGRAM,
        status: "pending",
        auditor_public_key: null,
        failure_code: null,
        failure_message: null,
      });
    });

    it("never re-points an active ring", async () => {
      await reserve();
      await repo.markActive({ ...scope, ringProgramId: RING_PROGRAM, auditorPublicKey: "04abc" });

      expect(await repo.repointRing({ ...scope, ringProgramId: OTHER_RING_PROGRAM })).toBeNull();
      expect((await repo.getByProject(scope))?.ring_program_id).toBe(RING_PROGRAM);
    });
  });

  describe("markActive", () => {
    it("records the published auditor key and clears any earlier failure", async () => {
      await reserve();
      await repo.markFailed({
        ...scope,
        ringProgramId: RING_PROGRAM,
        failureCode: "gateway_unavailable",
        failureMessage: "boom",
      });

      const active = await repo.markActive({
        ...scope,
        ringProgramId: RING_PROGRAM,
        auditorPublicKey: "04abc123",
      });

      expect(active).toMatchObject({
        status: "active",
        auditor_public_key: "04abc123",
        failure_code: null,
        failure_message: null,
      });
    });

    it("matches nothing under a different program id", async () => {
      await reserve();

      expect(
        await repo.markActive({
          ...scope,
          ringProgramId: OTHER_RING_PROGRAM,
          auditorPublicKey: "04abc123",
        })
      ).toBeNull();
    });
  });

  describe("markFailed", () => {
    it("records the failure on the row", async () => {
      await reserve();

      const failed = await repo.markFailed({
        ...scope,
        ringProgramId: RING_PROGRAM,
        failureCode: "config_error",
        failureMessage: "ring bring-up failed",
      });

      expect(failed).toMatchObject({
        status: "failed",
        failure_code: "config_error",
        failure_message: "ring bring-up failed",
      });
    });

    it("never un-activates a ring whose bring-up already confirmed", async () => {
      await reserve();
      await repo.markActive({ ...scope, ringProgramId: RING_PROGRAM, auditorPublicKey: "04abc" });

      const failed = await repo.markFailed({
        ...scope,
        ringProgramId: RING_PROGRAM,
        failureCode: "gateway_unavailable",
        failureMessage: "late failure from a lost race",
      });

      expect(failed).toBeNull();
      expect((await repo.getByProject(scope))?.status).toBe("active");
    });
  });

  it("maps a row to the domain shape", async () => {
    await reserve();
    const failed = await repo.markFailed({
      ...scope,
      ringProgramId: RING_PROGRAM,
      failureCode: "config_error",
      failureMessage: "ring bring-up failed",
    });
    if (!failed) throw new Error("failure fixture was not recorded");

    expect(mapHeliusRingsProjectRingRow(failed)).toEqual({
      ringProgramId: RING_PROGRAM,
      status: "failed",
      auditorPublicKeyHex: null,
      failure: { code: "config_error", message: "ring bring-up failed" },
      createdAt: failed.created_at,
      updatedAt: failed.updated_at,
    });
  });
});
