import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createFeePaymentAdapter } from "@sdp/payments/fee-payment";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKoraUserId,
  createProjectSponsorshipFeePayment,
  createSponsorshipFeePayment,
  resolveAuthenticatedSponsorshipScope,
  resolveRequestSponsorshipScope,
} from "@/services/sponsorship.service";
import type { Env } from "@/types/env";

const projectMocks = vi.hoisted(() => ({
  getProject: vi.fn(),
}));

vi.mock("@sdp/payments/fee-payment", () => ({
  createFeePaymentAdapter: vi.fn(() => ({ providerId: "kora" })),
}));

vi.mock("@/db", () => ({
  getDb: vi.fn(() => ({})),
}));

vi.mock("@/services/project.service", () => ({
  ProjectService: class {
    getProject = projectMocks.getProject;
  },
}));

describe("sponsorship identity boundary", () => {
  beforeEach(() => {
    vi.mocked(createFeePaymentAdapter).mockClear();
    projectMocks.getProject.mockReset();
  });

  it("builds a versioned tenant and actor scoped Kora user_id", () => {
    expect(
      buildKoraUserId({
        environment: "production",
        organizationId: "org:alpha",
        projectId: "project/one",
        actor: { type: "api_key", id: "key:primary" },
      })
    ).toBe("sdp:v1:production:org%3Aalpha:project:project%2Fone:api_key:key%3Aprimary");
  });

  it("rejects an incomplete scope instead of emitting an unscoped identity", () => {
    expect(() =>
      buildKoraUserId({
        environment: "sandbox",
        organizationId: "org_1",
        projectId: "project_1",
        actor: { type: "user", id: " " },
      })
    ).toThrow("Sponsorship actor id is required");
  });

  it("is the owned boundary that forwards the trusted scope to Kora", () => {
    const env = { FEE_PAYMENT_PROVIDER: "kora" } as Env;
    createSponsorshipFeePayment(env, {
      environment: "sandbox",
      organizationId: "org_1",
      projectId: "project_1",
      actor: { type: "user", id: "user_1" },
    });

    expect(createFeePaymentAdapter).toHaveBeenCalledWith(
      env,
      "sdp:v1:sandbox:org_1:project:project_1:user:user_1"
    );
  });

  it("derives request actors from authenticated middleware state, not request input", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("apiKey", {
        id: "key_trusted",
        organizationId: "org_trusted",
        projectId: "project_trusted",
        role: "api_admin",
        permissions: ["*"],
        environment: "production",
        signingWalletId: null,
      });
      c.set("projectId", "project_trusted");
      c.set("projectEnvironment", "production");
      await next();
    });
    app.get("/probe", (c) => c.text(buildKoraUserId(resolveRequestSponsorshipScope(c))));

    const response = await app.request(
      "/probe?user_id=attacker",
      { headers: { "x-project-id": "project_attacker" } },
      {} as Env
    );

    expect(await response.text()).toBe(
      "sdp:v1:production:org_trusted:project:project_trusted:api_key:key_trusted"
    );
  });

  it("derives an organization-scoped identity for an API key without a project", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("apiKey", {
        id: "key_org",
        organizationId: "org_trusted",
        projectId: null as never,
        role: "api_admin",
        permissions: ["*"],
        environment: "production",
        signingWalletId: "wallet_trusted",
      });
      await next();
    });
    app.get("/probe", (c) => c.text(buildKoraUserId(resolveAuthenticatedSponsorshipScope(c))));

    const response = await app.request("/probe", {}, {} as Env);

    expect(await response.text()).toBe(
      "sdp:v1:production:org_trusted:organization:api_key:key_org"
    );
  });

  it("keeps project-required request sponsorship fail closed", async () => {
    const app = new Hono<{ Bindings: Env }>();
    let sponsorshipError: unknown;
    app.use("*", async (c, next) => {
      c.set("apiKey", {
        id: "key_org",
        organizationId: "org_trusted",
        projectId: null as never,
        role: "api_admin",
        permissions: ["*"],
        environment: "production",
        signingWalletId: "wallet_trusted",
      });
      await next();
    });
    app.get("/probe", (c) => {
      try {
        resolveRequestSponsorshipScope(c);
      } catch (error) {
        sponsorshipError = error;
      }
      return c.text("checked");
    });

    await app.request("/probe", {}, {} as Env);

    expect(sponsorshipError).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("derives background and public scopes from persisted project ownership", async () => {
    projectMocks.getProject.mockResolvedValue({
      id: "project_stored",
      organizationId: "org_stored",
      environment: "production",
      status: "active",
    });
    const env = { FEE_PAYMENT_PROVIDER: "kora" } as Env;

    await createProjectSponsorshipFeePayment(env, {
      organizationId: "org_stored",
      projectId: "project_stored",
      actor: { type: "wallet", id: "wallet_stored" },
    });

    expect(createFeePaymentAdapter).toHaveBeenCalledWith(
      env,
      "sdp:v1:production:org_stored:project:project_stored:wallet:wallet_stored"
    );
  });

  it("rejects a persisted project that does not belong to the claimed organization", async () => {
    projectMocks.getProject.mockResolvedValue({
      id: "project_stored",
      organizationId: "org_other",
      environment: "production",
      status: "active",
    });

    await expect(
      createProjectSponsorshipFeePayment({} as Env, {
        organizationId: "org_claimed",
        projectId: "project_stored",
        actor: { type: "wallet", id: "wallet_stored" },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("sponsorship construction guard", () => {
  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    });
  }

  it("keeps production Kora adapter construction behind the owned boundary", () => {
    const sourceRoot = path.resolve(import.meta.dirname, "..");
    const violations = sourceFiles(sourceRoot)
      .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".spec.ts"))
      .filter((file) => !file.startsWith(path.join(sourceRoot, "test") + path.sep))
      .filter((file) => !file.endsWith("/services/sponsorship.service.ts"))
      .filter((file) => !file.endsWith("/services/adapters/index.ts"))
      .filter((file) => readFileSync(file, "utf8").includes('from "@sdp/payments/fee-payment"'))
      .map((file) => path.relative(sourceRoot, file));

    expect(violations).toEqual([]);
  });
});
