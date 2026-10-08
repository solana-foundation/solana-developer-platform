import { ORGANIZATION_STATUSES, type ProjectEnvironment } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb, runWithSystemDatabaseIdentity } from "@/db";
import {
  checkMoneyStart,
  decideMoneyStart,
  type MoneyAdmissionFacts,
  readMoneyAdmissionFacts,
} from "@/lib/money-admission";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PRODUCTION_PROJECT, TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const ENTITLED = JSON.stringify({ enableProductionProject: true });

function facts(overrides: Partial<MoneyAdmissionFacts> = {}): MoneyAdmissionFacts {
  return {
    organizationStatus: "active",
    projectEnvironment: "production",
    projectStatus: "active",
    organizationTier: "individual",
    rawSettings: ENTITLED,
    ...overrides,
  };
}

describe("decideMoneyStart", () => {
  it.each<[string, Partial<MoneyAdmissionFacts>]>([
    ["an entitled production project", {}],
    [
      "a sandbox project without the entitlement",
      { projectEnvironment: "sandbox", rawSettings: null },
    ],
  ])("admits %s of an active organization", (_label, overrides) => {
    expect(decideMoneyStart(facts(overrides))).toEqual({ admitted: true });
  });

  it.each<[string, string | null]>([
    ["no settings", null],
    ["the entitlement off", JSON.stringify({ enableProductionProject: false })],
    ["other settings only", JSON.stringify({ defaultEnvironment: "production" })],
  ])("refuses a production project with %s", (_label, rawSettings) => {
    expect(decideMoneyStart(facts({ rawSettings }))).toEqual({
      admitted: false,
      reason: "production_not_enabled",
    });
  });

  it.each(
    ORGANIZATION_STATUSES.filter((status) => status !== "active").flatMap((status) =>
      (["sandbox", "production"] as const satisfies readonly ProjectEnvironment[]).map(
        (projectEnvironment) => [status, projectEnvironment] as const
      )
    )
  )("refuses a %s organization's %s project", (organizationStatus, projectEnvironment) => {
    expect(decideMoneyStart(facts({ organizationStatus, projectEnvironment }))).toEqual({
      admitted: false,
      reason: "organization_inactive",
    });
  });

  it("refuses an organization status it does not know", () => {
    expect(decideMoneyStart(facts({ organizationStatus: "archived" }))).toEqual({
      admitted: false,
      reason: "organization_inactive",
    });
  });

  it("refuses a project that is not in the organization", () => {
    expect(decideMoneyStart(null)).toEqual({ admitted: false, reason: "project_not_found" });
  });

  it("fails closed on settings that do not parse, and only where it reads them", () => {
    expect(() => decideMoneyStart(facts({ rawSettings: "{not json" }))).toThrow();
    expect(
      decideMoneyStart(facts({ projectEnvironment: "sandbox", rawSettings: "{not json" }))
    ).toEqual({ admitted: true });
  });
});

// Jobs and `/pay` read under the system identity (cron/runner.ts, job.ts,
// middleware/database-identity.ts); the reads here do too.
const asSystem = <T>(read: () => Promise<T>) =>
  runWithSystemDatabaseIdentity("test:money-admission", read);

describe("money admission reads", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.batch([
      db
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status),
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(TEST_USER.id, TEST_USER.email),
    ]);
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [TEST_USER.id],
      ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT.id },
    });
  });

  it("reads the project's environment and its organization's status and settings in one join", async () => {
    await expect(
      asSystem(() =>
        readMoneyAdmissionFacts(env, { organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
      )
    ).resolves.toMatchObject({ organizationStatus: "active", projectEnvironment: "sandbox" });
    await expect(
      asSystem(() =>
        readMoneyAdmissionFacts(env, { organizationId: "org_other", projectId: TEST_PROJECT.id })
      )
    ).resolves.toBeNull();
  });

  it("refuses a deleted organization on the next movement, uncached", async () => {
    const scope = { organizationId: TEST_ORG.id, projectId: TEST_PRODUCTION_PROJECT.id };
    const context = {
      surface: "job",
      movement: "recurring.collect",
      subjectId: "prp_test",
    } as const;
    await expect(asSystem(() => checkMoneyStart(env, scope, context))).resolves.toEqual({
      admitted: true,
    });
    await getDb(env)
      .prepare("UPDATE organizations SET status = 'deleted' WHERE id = ?")
      .bind(TEST_ORG.id)
      .run();

    await expect(asSystem(() => checkMoneyStart(env, scope, context))).resolves.toEqual({
      admitted: false,
      reason: "organization_inactive",
    });
  });
});
