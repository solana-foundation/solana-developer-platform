import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, runWithSystemDatabaseIdentity } from "@/db";
import {
  AdmittedMovement,
  admitMovement,
  mintAdmittedMovementForTests,
  readAdmittedMovement,
  uncheckedLegacyMovement,
} from "@/lib/admit-movement";
import { MoneyMovementRefusedError } from "@/lib/money-admission";
import { rootLogger } from "@/runtime/logger";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PRODUCTION_PROJECT, TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

// Jobs and `/pay` read under the system identity; the reads here do too.
const asSystem = <T>(read: () => Promise<T>) =>
  runWithSystemDatabaseIdentity("test:admit-movement", read);

const production = { organizationId: TEST_ORG.id, projectId: TEST_PRODUCTION_PROJECT.id };
const context = { surface: "job", subjectId: "prp_test" } as const;

async function setOrganization(column: "status" | "settings", value: string | null) {
  await getDb(env)
    .prepare(`UPDATE organizations SET ${column} = ? WHERE id = ?`)
    .bind(value, TEST_ORG.id)
    .run();
}

describe("admitMovement", () => {
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

  it("mints a token carrying the facts it read, for an entitled production project", async () => {
    const token = await asSystem(() =>
      admitMovement(env, production, "payments.transfer", context)
    );

    expect(readAdmittedMovement(token, production)).toMatchObject({
      ...production,
      movement: "payments.transfer",
      kind: "start",
      environment: "production",
      projectStatus: "active",
      organization: { settings: expect.objectContaining({ enableProductionProject: true }) },
    });
    expect(Object.isFrozen(token)).toBe(true);
  });

  it.each([
    ["a deleted organization", "status", "deleted", "organization_inactive"],
    ["revoked production access", "settings", null, "production_not_enabled"],
  ] as const)("refuses a start for %s and logs it", async (_label, column, value, reason) => {
    const warn = vi.spyOn(rootLogger, "warn");
    await setOrganization(column, value);

    const refusal = await asSystem(() =>
      admitMovement(env, production, "recurring.collect", context)
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(MoneyMovementRefusedError);
    expect(refusal).toMatchObject({ code: "FORBIDDEN", reason });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sdp_money_refused",
        movement: "recurring.collect",
        kind: "start",
        reason,
      }),
      "sdp_money_refused"
    );
    warn.mockRestore();
  });

  it("admits an exit for a deleted organization", async () => {
    await setOrganization("status", "deleted");

    const token = await asSystem(() => admitMovement(env, production, "recurring.cancel", context));

    expect(readAdmittedMovement(token)).toMatchObject({
      movement: "recurring.cancel",
      kind: "exit",
    });
  });

  it("refuses a project that is not in the organization, even for an exit", async () => {
    await expect(
      asSystem(() =>
        admitMovement(
          env,
          { organizationId: "org_other", projectId: TEST_PROJECT.id },
          "recurring.cancel",
          context
        )
      )
    ).rejects.toMatchObject({ reason: "project_not_found" });
  });

  it("mints through the escape hatch without refusing, and logs what it would refuse", async () => {
    const warn = vi.spyOn(rootLogger, "warn");
    await setOrganization("status", "deleted");

    const token = await asSystem(() => uncheckedLegacyMovement(env, production, "dvp"));

    expect(readAdmittedMovement(token)).toMatchObject({ movement: "legacy.dvp", kind: "start" });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sdp_money_refused",
        decision: "would_refuse",
        movement: "legacy.dvp",
        reason: "organization_inactive",
      }),
      "sdp_money_refused"
    );
    warn.mockRestore();
  });
});

describe("readAdmittedMovement", () => {
  const scope = { organizationId: "org_1", projectId: "prj_1" };

  it("rejects an object that was not minted by admission", () => {
    // SAFETY: both deliberately forged, to prove the sink check rejects them.
    const forged = Object.create(AdmittedMovement.prototype) as AdmittedMovement;
    const literal = { ...scope, movement: "payments.transfer" } as unknown as AdmittedMovement;

    expect(() => readAdmittedMovement(forged)).toThrow("Value movement was not admitted");
    expect(() => readAdmittedMovement(literal)).toThrow("Value movement was not admitted");
  });

  it("rejects a token admitted for a different organization or project", () => {
    const token = mintAdmittedMovementForTests(scope);

    expect(() => readAdmittedMovement(token, scope)).not.toThrow();
    expect(() => readAdmittedMovement(token, { ...scope, organizationId: "org_2" })).toThrow(
      "Value movement was admitted for a different scope"
    );
    expect(() => readAdmittedMovement(token, { ...scope, projectId: "prj_2" })).toThrow(
      "Value movement was admitted for a different scope"
    );
  });
});
