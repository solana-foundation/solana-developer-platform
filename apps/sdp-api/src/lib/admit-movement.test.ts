import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AdmittedMovement,
  admitMovement,
  assertAdmittedMovement,
  type MovementPurpose,
  MovementRefusedError,
  tryAdmitMovement,
} from "@/lib/admit-movement";
import type { Env } from "@/types/env";

interface AdmissionRow {
  environment: "sandbox" | "production";
  project_status: "active" | "archived";
  organization_status: string;
  tier: string;
  settings: string | null;
}

const db = vi.hoisted(() => {
  const state: { row: unknown } = { row: null };
  const first = vi.fn(async () => state.row);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn((_sql: string) => ({ bind }));
  return { state, first, bind, prepare };
});

vi.mock("@/db", () => ({ getDb: () => ({ prepare: db.prepare }) }));

const env = { SDP_RELEASE_CHANNEL: "experimental" } as Env;
const scope = { organizationId: "org_1", projectId: "prj_1" };
const ENTITLED = JSON.stringify({ enableProductionProject: true });

function row(overrides: Partial<AdmissionRow> = {}): AdmissionRow {
  return {
    environment: "production",
    project_status: "active",
    organization_status: "active",
    tier: "individual",
    settings: ENTITLED,
    ...overrides,
  };
}

function refusal(purpose: MovementPurpose, testEnv: Env = env) {
  return admitMovement(testEnv, scope, purpose).then(
    () => null,
    (error: unknown) => (error instanceof MovementRefusedError ? error.refusal : error)
  );
}

describe("admitMovement", () => {
  beforeEach(() => {
    db.state.row = null;
    db.first.mockClear();
    db.bind.mockClear();
    db.prepare.mockClear();
  });

  it("admits a start in an entitled production project from one scoped read", async () => {
    db.state.row = row();

    const movement = await admitMovement(env, scope, "payments.transfer");

    expect(movement).toMatchObject({
      organizationId: "org_1",
      projectId: "prj_1",
      purpose: "payments.transfer",
      kind: "start",
      environment: "production",
      projectStatus: "active",
      organization: { tier: "individual", settings: { enableProductionProject: true } },
    });
    expect(db.prepare).toHaveBeenCalledOnce();
    expect(db.prepare.mock.calls[0]?.[0]).toMatch(
      /JOIN organizations o ON o\.id = p\.organization_id/
    );
    expect(db.bind).toHaveBeenCalledWith("prj_1", "org_1");
    expect(db.first).toHaveBeenCalledOnce();
  });

  describe("after production access is revoked", () => {
    beforeEach(() => {
      db.state.row = row({ settings: JSON.stringify({ enableProductionProject: false }) });
    });

    it("refuses a start", async () => {
      await expect(refusal("payments.transfer")).resolves.toBe("production_not_enabled");
    });

    it("admits an exit", async () => {
      await expect(admitMovement(env, scope, "earn.withdraw")).resolves.toMatchObject({
        kind: "exit",
      });
    });

    it("admits an already-funded BVNK payout", async () => {
      await expect(admitMovement(env, scope, "ramps.bvnk_onramp_payout")).resolves.toMatchObject({
        kind: "funded_payout",
      });
    });
  });

  describe.each(["sandbox", "production"] as const)(
    "for a deleted organization in %s",
    (environment) => {
      beforeEach(() => {
        db.state.row = row({ environment, organization_status: "deleted" });
      });

      it("refuses a start", async () => {
        await expect(refusal("payments.transfer")).resolves.toBe("organization_inactive");
      });

      it("admits an exit", async () => {
        await expect(admitMovement(env, scope, "recurring.cancel")).resolves.toMatchObject({
          kind: "exit",
        });
      });

      it("holds an already-funded BVNK payout", async () => {
        await expect(refusal("ramps.bvnk_onramp_payout")).resolves.toBe("organization_inactive");
      });
    }
  );

  it("admits a sandbox start for an organization without production access", async () => {
    db.state.row = row({ environment: "sandbox", settings: null });

    await expect(admitMovement(env, scope, "payments.transfer")).resolves.toMatchObject({
      environment: "sandbox",
      kind: "start",
    });
  });

  it("refuses a project that is not in the claimed organization", async () => {
    db.state.row = null;

    const error = await admitMovement(env, scope, "payments.transfer").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MovementRefusedError);
    expect(error).toMatchObject({ refusal: "project_not_found", code: "NOT_FOUND" });
  });

  it("refuses a module outside the release channel before reading the database", async () => {
    db.state.row = row();

    await expect(refusal("dvp.fund", { SDP_RELEASE_CHANNEL: "stable" } as Env)).resolves.toBe(
      "module_not_in_release_channel"
    );
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("returns a frozen token, including its organization facts", async () => {
    db.state.row = row();

    const movement = await admitMovement(env, scope, "payments.transfer");

    expect(Object.isFrozen(movement)).toBe(true);
    expect(Object.isFrozen(movement.organization)).toBe(true);
    expect(() => {
      (movement as { projectId: string }).projectId = "prj_other";
    }).toThrow(TypeError);
  });
});

describe("assertAdmittedMovement", () => {
  it("accepts a minted token within its scope", async () => {
    db.state.row = row();
    const movement = await admitMovement(env, scope, "payments.transfer");

    expect(() => assertAdmittedMovement(movement, scope)).not.toThrow();
    expect(() =>
      assertAdmittedMovement(movement, { organizationId: "org_1", projectId: "prj_other" })
    ).toThrow("Value movement was admitted for a different scope");
  });

  it("rejects a forged object cast as a token", () => {
    const forged = {
      ...scope,
      purpose: "payments.transfer",
      kind: "start",
      environment: "production",
      projectStatus: "active",
      organization: { tier: "individual", settings: null },
    } as unknown as AdmittedMovement;

    expect(() => assertAdmittedMovement(forged)).toThrow("Value movement was not admitted");
  });

  it("rejects a copy of a minted token", async () => {
    db.state.row = row();
    const movement = await admitMovement(env, scope, "payments.transfer");

    expect(() => assertAdmittedMovement({ ...movement })).toThrow(
      "Value movement was not admitted"
    );
  });
});

describe("tryAdmitMovement", () => {
  const context = { job: "test-job", subjectId: "subject_1" };

  it("returns the refusal instead of throwing", async () => {
    db.state.row = row({ organization_status: "deleted" });

    const result = await tryAdmitMovement(env, scope, "recurring.collect", context);

    expect(result).toMatchObject({ admitted: false, reason: "organization_inactive" });
    expect(result.admitted === false && result.error).toBeInstanceOf(MovementRefusedError);
  });

  it("returns the movement when admitted", async () => {
    db.state.row = row();

    const result = await tryAdmitMovement(env, scope, "recurring.collect", context);

    expect(result).toMatchObject({
      admitted: true,
      movement: { purpose: "recurring.collect", organizationId: "org_1" },
    });
  });

  it("rethrows failures that are not refusals", async () => {
    db.first.mockRejectedValueOnce(new Error("connection reset"));

    await expect(tryAdmitMovement(env, scope, "recurring.collect", context)).rejects.toThrow(
      "connection reset"
    );
  });
});
