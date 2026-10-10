import {
  MOVEMENTS,
  type MovementId,
  ORGANIZATION_STATUSES,
  type ProjectEnvironment,
} from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb, runWithSystemDatabaseIdentity } from "@/db";
import {
  assertMoneyStartAdmitted,
  decideMoneyStart,
  decideMovement,
  type MoneyAdmissionFacts,
  MoneyMovementRefusedError,
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

describe("MOVEMENTS exits", () => {
  // SECURITY REVIEW GATE: an exit is never refused, so this list changes only
  // with a named security reviewer (see packages/sdp-types/src/movements.ts).
  it("exempts exactly the reviewed exits from admission", () => {
    const exits = (Object.keys(MOVEMENTS) as MovementId[])
      .filter((movement) => MOVEMENTS[movement].kind === "exit")
      .sort();
    expect(exits).toEqual([
      "dvp.cancel",
      "dvp.reclaim",
      "earn.queued_withdraw_request",
      "earn.withdraw",
      "helius_rings.gateway_transaction",
      "helius_rings.key_derivation",
      "helius_rings.operation_exit",
      "issuance.control",
      "private_channels.withdraw",
      "recurring.cancel",
      "recurring.update_cancel_old",
    ]);
  });
});

describe("decideMovement", () => {
  const cases: [string, MoneyAdmissionFacts | null][] = [
    ["a deleted organization", facts({ organizationStatus: "deleted" })],
    ["a suspended organization", facts({ organizationStatus: "suspended" })],
    ["a production project without the entitlement", facts({ rawSettings: null })],
    ["a project it cannot find", null],
    ["an active, entitled organization", facts()],
  ];

  it.each(
    (Object.keys(MOVEMENTS) as MovementId[]).flatMap((movement) =>
      cases.map(([label, subject]) => [movement, label, subject] as const)
    )
  )("decides %s for %s", (movement, _label, subject) => {
    // An exit always passes (ADR 0002); a start is exactly the start decision.
    expect(decideMovement(movement, subject)).toEqual(
      MOVEMENTS[movement].kind === "exit" ? { admitted: true } : decideMoneyStart(subject)
    );
  });
});

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
      operation: "recurring_payment.collect",
      subjectId: "prp_test",
    } as const;
    await getDb(env)
      .prepare("UPDATE organizations SET status = 'deleted' WHERE id = ?")
      .bind(TEST_ORG.id)
      .run();

    const refusal = await asSystem(() => assertMoneyStartAdmitted(env, scope, context)).catch(
      (error: unknown) => error
    );

    expect(refusal).toBeInstanceOf(MoneyMovementRefusedError);
    expect(refusal).toMatchObject({
      code: "FORBIDDEN",
      reason: "organization_inactive",
      message: "Organization is not active",
    });
  });

  it("refuses a production project on the next movement once its organization loses production access, uncached", async () => {
    const scope = { organizationId: TEST_ORG.id, projectId: TEST_PRODUCTION_PROJECT.id };
    const context = {
      surface: "job",
      operation: "recurring_payment.collect",
      subjectId: "prp_test",
    } as const;
    const setSettings = (settings: string) =>
      getDb(env)
        .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
        .bind(settings, TEST_ORG.id)
        .run();

    await setSettings(ENTITLED);
    await expect(
      asSystem(() => assertMoneyStartAdmitted(env, scope, context))
    ).resolves.toBeUndefined();

    await setSettings(JSON.stringify({}));
    const refusal = await asSystem(() => assertMoneyStartAdmitted(env, scope, context)).catch(
      (error: unknown) => error
    );

    expect(refusal).toBeInstanceOf(MoneyMovementRefusedError);
    expect(refusal).toMatchObject({
      code: "FORBIDDEN",
      reason: "production_not_enabled",
      message: "Production is not enabled for this organization",
    });
    await expect(
      asSystem(() =>
        assertMoneyStartAdmitted(
          env,
          { organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id },
          context
        )
      )
    ).resolves.toBeUndefined();
  });
});
