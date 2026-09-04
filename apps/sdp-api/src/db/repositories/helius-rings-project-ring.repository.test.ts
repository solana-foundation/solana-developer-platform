import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type {
  HeliusRingsProjectRingRepository,
  HeliusRingsProjectRingRow,
} from "./helius-rings-project-ring.repository";
import { mapHeliusRingsProjectRingRow } from "./helius-rings-project-ring.repository";
import { createPostgresHeliusRingsProjectRingRepository } from "./helius-rings-project-ring.repository.postgres";

const TEST_PROJECT_ID = "prj_hrr_repo_test";
const OTHER_PROJECT_ID = "prj_hrr_repo_other";

const RING_PROGRAM = "RingProgram1111111111111111111111111111111";
const OTHER_RING_PROGRAM = "RingProgram2111111111111111111111111111111";
const LOOKUP_TABLE = "LookupTab1e11111111111111111111111111111111";

const scope = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };
const key = { ...scope, name: "treasury" };

let repo: HeliusRingsProjectRingRepository;

async function reserve(
  overrides: { name?: string; ringProgramId?: string } = {}
): Promise<HeliusRingsProjectRingRow> {
  const ring = await repo.reserveRing({
    ...scope,
    name: overrides.name ?? key.name,
    ringProgramId: overrides.ringProgramId ?? RING_PROGRAM,
  });
  if (!ring || ring === "program_in_use") throw new Error("ring fixture was not created");
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

  it("reserves a pending ring with no auditor key or lookup table", async () => {
    const ring = await reserve();

    expect(ring).toMatchObject({
      name: "treasury",
      ring_program_id: RING_PROGRAM,
      status: "pending",
      auditor_public_key: null,
      lookup_table_address: null,
      failure_code: null,
      failure_message: null,
    });
  });

  it("returns the existing row on a replay of the name, program id and all", async () => {
    const first = await reserve();
    // The caller tells a resume from a re-point by comparing program ids, so
    // the row that already exists must come back unchanged.
    const replay = await reserve({ ringProgramId: OTHER_RING_PROGRAM });

    expect(replay.id).toBe(first.id);
    expect(replay.ring_program_id).toBe(RING_PROGRAM);
  });

  it("keeps rings with distinct names side by side", async () => {
    await reserve();
    const second = await reserve({ name: "payroll", ringProgramId: OTHER_RING_PROGRAM });

    expect(second.name).toBe("payroll");
    const listed = await repo.listByProject(scope);
    expect(listed.map((ring) => ring.name)).toEqual(["treasury", "payroll"]);
  });

  it("surfaces a program already registered under another name as a value", async () => {
    await reserve();

    // One on-chain pool under two rows would split its audit trail; the caller
    // turns this into a 409, so it must not arrive as a thrown 500.
    expect(await repo.reserveRing({ ...scope, name: "payroll", ringProgramId: RING_PROGRAM })).toBe(
      "program_in_use"
    );
  });

  it("scopes reads to the project", async () => {
    await reserve();

    expect(await repo.getByName(key)).not.toBeNull();
    expect(
      await repo.getByName({
        organizationId: TEST_ORG.id,
        projectId: OTHER_PROJECT_ID,
        name: key.name,
      })
    ).toBeNull();
    expect(
      await repo.listByProject({ organizationId: TEST_ORG.id, projectId: OTHER_PROJECT_ID })
    ).toEqual([]);
  });

  it("finds a ring by its program id inside the project", async () => {
    await reserve();

    expect((await repo.getByProgramId({ ...scope, ringProgramId: RING_PROGRAM }))?.name).toBe(
      "treasury"
    );
    expect(await repo.getByProgramId({ ...scope, ringProgramId: OTHER_RING_PROGRAM })).toBeNull();
  });

  describe("repointRing", () => {
    it("replaces the program id of a never-active ring and resets it to pending", async () => {
      await reserve();
      await repo.recordLookupTable({
        ...key,
        ringProgramId: RING_PROGRAM,
        lookupTableAddress: LOOKUP_TABLE,
      });
      await repo.markFailed({
        ...key,
        ringProgramId: RING_PROGRAM,
        failureCode: "invalid_input",
        failureMessage: "not a deployed program",
      });

      const repointed = await repo.repointRing({ ...key, ringProgramId: OTHER_RING_PROGRAM });

      expect(repointed).toMatchObject({
        ring_program_id: OTHER_RING_PROGRAM,
        status: "pending",
        auditor_public_key: null,
        // A new program means a new table; keeping the old one would aim
        // spends at the old program's PDAs.
        lookup_table_address: null,
        failure_code: null,
        failure_message: null,
      });
    });

    it("never re-points an active ring", async () => {
      await reserve();
      await repo.markActive({
        ...key,
        ringProgramId: RING_PROGRAM,
        auditorPublicKey: "04abc",
        lookupTableAddress: LOOKUP_TABLE,
      });

      expect(await repo.repointRing({ ...key, ringProgramId: OTHER_RING_PROGRAM })).toBeNull();
      expect((await repo.getByName(key))?.ring_program_id).toBe(RING_PROGRAM);
    });

    it("only touches the named ring", async () => {
      await reserve();
      await reserve({ name: "payroll", ringProgramId: OTHER_RING_PROGRAM });

      const repointed = await repo.repointRing({
        ...scope,
        name: "payroll",
        ringProgramId: "RingProgram3111111111111111111111111111111",
      });

      if (!repointed || repointed === "program_in_use")
        throw new Error("repoint did not return a row");
      expect(repointed.name).toBe("payroll");
      expect((await repo.getByName(key))?.ring_program_id).toBe(RING_PROGRAM);
    });
  });

  describe("recordLookupTable", () => {
    it("persists the table on a still-pending row", async () => {
      await reserve();

      const recorded = await repo.recordLookupTable({
        ...key,
        ringProgramId: RING_PROGRAM,
        lookupTableAddress: LOOKUP_TABLE,
      });

      expect(recorded?.lookup_table_address).toBe(LOOKUP_TABLE);
      expect(recorded?.status).toBe("pending");
    });

    it("matches nothing after a re-point took the row", async () => {
      await reserve();
      await repo.repointRing({ ...key, ringProgramId: OTHER_RING_PROGRAM });

      expect(
        await repo.recordLookupTable({
          ...key,
          ringProgramId: RING_PROGRAM,
          lookupTableAddress: LOOKUP_TABLE,
        })
      ).toBeNull();
    });
  });

  describe("markActive", () => {
    it("records the auditor key and lookup table and clears any earlier failure", async () => {
      await reserve();
      await repo.markFailed({
        ...key,
        ringProgramId: RING_PROGRAM,
        failureCode: "gateway_unavailable",
        failureMessage: "boom",
      });

      const active = await repo.markActive({
        ...key,
        ringProgramId: RING_PROGRAM,
        auditorPublicKey: "04abc123",
        lookupTableAddress: LOOKUP_TABLE,
      });

      expect(active).toMatchObject({
        status: "active",
        auditor_public_key: "04abc123",
        lookup_table_address: LOOKUP_TABLE,
        failure_code: null,
        failure_message: null,
      });
    });

    it("matches nothing under a different program id", async () => {
      await reserve();

      expect(
        await repo.markActive({
          ...key,
          ringProgramId: OTHER_RING_PROGRAM,
          auditorPublicKey: "04abc123",
          lookupTableAddress: LOOKUP_TABLE,
        })
      ).toBeNull();
    });
  });

  describe("markFailed", () => {
    it("records the failure on the row", async () => {
      await reserve();

      const failed = await repo.markFailed({
        ...key,
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
      await repo.markActive({
        ...key,
        ringProgramId: RING_PROGRAM,
        auditorPublicKey: "04abc",
        lookupTableAddress: LOOKUP_TABLE,
      });

      const failed = await repo.markFailed({
        ...key,
        ringProgramId: RING_PROGRAM,
        failureCode: "gateway_unavailable",
        failureMessage: "late failure from a lost race",
      });

      expect(failed).toBeNull();
      expect((await repo.getByName(key))?.status).toBe("active");
    });
  });

  it("maps a row to the domain shape", async () => {
    await reserve();
    const failed = await repo.markFailed({
      ...key,
      ringProgramId: RING_PROGRAM,
      failureCode: "config_error",
      failureMessage: "ring bring-up failed",
    });
    if (!failed) throw new Error("failure fixture was not recorded");

    expect(mapHeliusRingsProjectRingRow(failed)).toEqual({
      id: failed.id,
      name: "treasury",
      ringProgramId: RING_PROGRAM,
      status: "failed",
      auditorPublicKeyHex: null,
      lookupTableAddress: null,
      failure: { code: "config_error", message: "ring bring-up failed" },
      createdAt: failed.created_at,
      updatedAt: failed.updated_at,
    });
  });
});
