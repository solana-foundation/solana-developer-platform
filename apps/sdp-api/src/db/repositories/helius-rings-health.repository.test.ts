import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type {
  HeliusRingsHealthRepository,
  HeliusRingsRuntimeHealthRow,
} from "./helius-rings-health.repository";
import { mapHeliusRingsHealthRows } from "./helius-rings-health.repository";
import { createPostgresHeliusRingsHealthRepository } from "./helius-rings-health.repository.postgres";

const TEST_PROJECT_ID = "prj_hrh_repo_test";

function row(overrides: Partial<HeliusRingsRuntimeHealthRow> = {}): HeliusRingsRuntimeHealthRow {
  return {
    project_id: TEST_PROJECT_ID,
    component: "rpc",
    status: "green",
    observed_at: "2026-08-17T00:00:00.000Z",
    detail: null,
    ...overrides,
  };
}

describe("mapHeliusRingsHealthRows", () => {
  it("reads an unobserved component as red, not green", () => {
    // Never having checked an upstream is not evidence that it is healthy, and
    // the action gate keys off this value.
    expect(mapHeliusRingsHealthRows([])).toEqual({
      rpc: "red",
      prover: "red",
      photon: "red",
    });
  });

  it("reports each observed component's stored status", () => {
    const health = mapHeliusRingsHealthRows([
      row({ component: "rpc", status: "green" }),
      row({ component: "prover", status: "amber" }),
      row({ component: "photon", status: "red" }),
    ]);

    expect(health).toEqual({
      rpc: "green",
      prover: "amber",
      photon: "red",
    });
  });

  it("prefixes detail keys with their component so they cannot collide", () => {
    const health = mapHeliusRingsHealthRows([
      row({ component: "rpc", detail: { reason: "slow" } }),
      row({ component: "prover", detail: { reason: "queue depth" } }),
    ]);

    expect(health.detail).toEqual({
      "rpc.reason": "slow",
      "prover.reason": "queue depth",
    });
  });

  it("omits detail entirely when no row carries any", () => {
    expect(mapHeliusRingsHealthRows([row()])).not.toHaveProperty("detail");
  });
});

describe("HeliusRingsHealthRepository (postgres)", () => {
  let repo: HeliusRingsHealthRepository;

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

    repo = createPostgresHeliusRingsHealthRepository(db);
  });

  it("records an observation with its detail", async () => {
    const recorded = await repo.recordHealth({
      projectId: TEST_PROJECT_ID,
      component: "prover",
      status: "amber",
      detail: { reason: "queue depth 40" },
    });

    expect(recorded).toMatchObject({
      component: "prover",
      status: "amber",
      detail: { reason: "queue depth 40" },
    });
    expect(recorded.observed_at).toBeTruthy();
  });

  it("overwrites in place rather than appending a history", async () => {
    await repo.recordHealth({ projectId: TEST_PROJECT_ID, component: "rpc", status: "red" });
    const updated = await repo.recordHealth({
      projectId: TEST_PROJECT_ID,
      component: "rpc",
      status: "green",
    });

    expect(updated.status).toBe("green");
    const rows = await repo.listHealthByProject({ projectId: TEST_PROJECT_ID });
    expect(rows).toHaveLength(1);
  });

  it("clears stale detail when a later observation carries none", async () => {
    await repo.recordHealth({
      projectId: TEST_PROJECT_ID,
      component: "rpc",
      status: "red",
      detail: { reason: "timeout" },
    });
    const recovered = await repo.recordHealth({
      projectId: TEST_PROJECT_ID,
      component: "rpc",
      status: "green",
    });

    // A green row still carrying the old failure text misreports a healthy
    // upstream as broken.
    expect(recovered.detail).toBeNull();
  });

  it("keeps components independent", async () => {
    await repo.recordHealth({ projectId: TEST_PROJECT_ID, component: "rpc", status: "green" });
    await repo.recordHealth({ projectId: TEST_PROJECT_ID, component: "photon", status: "amber" });

    const health = mapHeliusRingsHealthRows(
      await repo.listHealthByProject({ projectId: TEST_PROJECT_ID })
    );
    expect(health).toMatchObject({ rpc: "green", photon: "amber", prover: "red" });
  });

  it("rejects a component outside the known set", async () => {
    await expect(
      repo.recordHealth({
        projectId: TEST_PROJECT_ID,
        // Deliberately outside RUNTIME_HEALTH_COMPONENTS: the DB CHECK is the
        // backstop for a component added in code but not in a migration.
        component: "sidecar" as never,
        status: "green",
      })
    ).rejects.toMatchObject({ message: expect.stringContaining("component_check") });
  });
});
