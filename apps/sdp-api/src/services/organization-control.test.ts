import type { OrganizationStatus } from "@sdp/types/organizations";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { assertMoneyStartAdmitted } from "@/lib/money-admission";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PRODUCTION_PROJECT, TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { changeOrganizationControl, getOrganizationControl } from "./organization-control";

const asSystem = <T>(work: () => Promise<T>) =>
  runWithSystemDatabaseIdentity("test:organization-control", work);
const metadata = {
  organizationId: TEST_ORG.id,
  operator: "github:incident-operator",
  reason: "Authorized stage drill",
  ticket: "PRO-2315",
};
const status = () => asSystem(() => getOrganizationControl(env, TEST_ORG.id));
const suspend = () =>
  asSystem(() => changeOrganizationControl(env, { ...metadata, operation: "suspend" }));
const resume = (expectedVersion: number) =>
  asSystem(() =>
    changeOrganizationControl(env, { ...metadata, operation: "resume", expectedVersion })
  );

describe("organization incident control", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status)
      .run();
    const db = getDb(env);
    await db
      .prepare("INSERT INTO users (id, email, status) VALUES (?, ?, 'active')")
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT.id },
    });
  });

  it("suspends and restores the organization with attributable audit events", async () => {
    await expect(status()).resolves.toMatchObject({ status: "active", version: 0 });
    await expect(suspend()).resolves.toMatchObject({ status: "suspended", version: 1 });
    await expect(resume(1)).resolves.toMatchObject({ status: "active", version: 2 });
    const events = await getDb(env)
      .prepare(
        "SELECT metadata FROM audit_logs WHERE resource_type = 'organization' AND resource_id = ? ORDER BY ledger_sequence"
      )
      .bind(TEST_ORG.id)
      .all<{ metadata: string }>();
    expect(events.results.map((event) => JSON.parse(event.metadata))).toEqual([
      expect.objectContaining({
        control: "organization_status",
        operation: "suspend",
        operator: metadata.operator,
        reason: metadata.reason,
        ticket: metadata.ticket,
        beforeStatus: "active",
        afterStatus: "suspended",
        beforeVersion: 0,
        afterVersion: 1,
      }),
      expect.objectContaining({
        operation: "resume",
        beforeStatus: "suspended",
        afterStatus: "active",
        beforeVersion: 1,
        afterVersion: 2,
      }),
    ]);
  });

  it("invalidates a pending restoration when another suspension arrives", async () => {
    await suspend();
    await expect(suspend()).resolves.toMatchObject({ status: "suspended", version: 2 });
    await expect(resume(1)).rejects.toThrow("current version 2");
    await expect(status()).resolves.toMatchObject({ status: "suspended", version: 2 });
  });

  it("allows only one concurrent restoration of the same revision", async () => {
    await suspend();
    const attempts = await Promise.allSettled([resume(1), resume(1)]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    await expect(status()).resolves.toMatchObject({ status: "active", version: 2 });
  });

  it("leaves the organization suspended when a new stop races a stale resume", async () => {
    await suspend();
    const attempts = await Promise.allSettled([suspend(), resume(1)]);
    expect(attempts[0]?.status).toBe("fulfilled");
    await expect(status()).resolves.toMatchObject({ status: "suspended" });
  });

  async function expectProtectedStatus(organizationStatus: OrganizationStatus): Promise<void> {
    await getDb(env)
      .prepare("UPDATE organizations SET status = ? WHERE id = ?")
      .bind(organizationStatus, TEST_ORG.id)
      .run();
    await expect(suspend()).rejects.toThrow();
    await expect(resume(0)).rejects.toThrow();
    await expect(status()).resolves.toMatchObject({ status: organizationStatus, version: 0 });
  }

  it("cannot suspend or reactivate a provisioning organization", () =>
    expectProtectedStatus("provisioning"));

  it("cannot suspend or reactivate a deleted organization", () => expectProtectedStatus("deleted"));

  it("refuses to resume an active organization", async () => {
    await expect(resume(0)).rejects.toThrow("Cannot resume");
  });

  it("does not modify another organization or project controls", async () => {
    const db = getDb(env);
    await db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES ('org_other', 'Other', 'other', 'individual', 'active')"
      )
      .run();
    await suspend();
    await expect(asSystem(() => getOrganizationControl(env, "org_other"))).resolves.toMatchObject({
      status: "active",
      version: 0,
    });
    await expect(asSystem(() => getOrganizationControl(env, "org_missing"))).rejects.toThrow(
      "not found"
    );
    const projects = await db
      .prepare(
        "SELECT disabled_movements, movement_control_version FROM projects WHERE organization_id = ?"
      )
      .bind(TEST_ORG.id)
      .all<{ disabled_movements: string[]; movement_control_version: number }>();
    expect(projects.results.length).toBeGreaterThan(0);
    for (const project of projects.results)
      expect(project).toEqual({ disabled_movements: [], movement_control_version: 0 });
  });

  it("refuses new starts for both project environments on the next admission read", async () => {
    await suspend();
    for (const project of [TEST_PROJECT, TEST_PRODUCTION_PROJECT]) {
      await expect(
        asSystem(() =>
          assertMoneyStartAdmitted(
            env,
            { organizationId: TEST_ORG.id, projectId: project.id },
            { surface: "job", movement: "recurring.collect", subjectId: "drill" },
            { custodyWalletId: null }
          )
        )
      ).rejects.toMatchObject({ reason: "organization_inactive" });
    }
  });

  it.each(["suspend", "resume"] as const)(
    "rolls back %s when its audit insert fails",
    async (operation) => {
      if (operation === "resume") await suspend();
      const before = await status();
      const db = getDb(env);
      await db.execute(
        "ALTER TABLE audit_logs ADD CONSTRAINT test_refuse_org_control_audit CHECK (resource_type <> 'organization') NOT VALID"
      );
      try {
        await expect(
          operation === "suspend" ? suspend() : resume(before.version)
        ).rejects.toThrow();
        await expect(status()).resolves.toEqual(before);
      } finally {
        await db.execute("ALTER TABLE audit_logs DROP CONSTRAINT test_refuse_org_control_audit");
      }
    }
  );
});
