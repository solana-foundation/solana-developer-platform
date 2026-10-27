import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as feePayment from "@sdp/fee-payment";
import { createKoraAdapter } from "@sdp/fee-payment";
import { runInClusterScope } from "@sdp/rpc/scope";
import { type Address, address, getBase58Codec } from "@solana/kit";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectService } from "@/services/project.service";
import {
  createSponsorshipFeePayment,
  isKoraSponsorshipConfigured,
  resolveProjectSponsorshipScope,
  resolveRequestSponsorshipScope,
  type SponsorshipScope,
} from "@/services/sponsorship.service";
import { BudgetedFeePayment } from "@/services/sponsorship-budget.service";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { testClerkContext } from "@/test/helpers/clerk-context";
import { env as testEnv } from "@/test/helpers/env";
import type { Env } from "@/types/env";

const projectMocks = { getProject: vi.fn() };

const SANDBOX = { projectId: "project_1", environment: "sandbox" } as const;
const PRODUCTION = { projectId: "project_1", environment: "production" } as const;

const SPONSORED_WALLET: SponsorshipScope = {
  organizationId: "org_test_sponsorship",
  projectId: "project_1",
  actor: { type: "wallet", id: "cwlt_1" },
};

/** The custody wallet the sponsored transfer signs with. */
const SIGNING_WALLET = { custodyWalletId: "cwlt_1" } as const;

const KORA_URLS = {
  devnet: "https://kora-devnet.sponsorship.sdp.test",
  mainnet: "https://kora-mainnet.sponsorship.sdp.test",
} as const;

const BOTH_CLUSTERS_ENV: Env = {
  ...testEnv,
  KORA_DEVNET_URL: KORA_URLS.devnet,
  KORA_MAINNET_URL: KORA_URLS.mainnet,
};

describe("sponsorship identity boundary", () => {
  beforeEach(() => {
    vi.spyOn(feePayment, "createKoraAdapter");
    vi.spyOn(ProjectService.prototype, "getProject").mockImplementation(projectMocks.getProject);
    projectMocks.getProject.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());
  it("builds a versioned tenant and actor scoped Kora user_id", () => {
    runInClusterScope({ projectId: "project/one", environment: "production" }, () =>
      createSponsorshipFeePayment(
        BOTH_CLUSTERS_ENV,
        {
          organizationId: "org:alpha",
          projectId: "project/one",
          actor: { type: "api_key", id: "key:primary" },
        },
        "payments.transfer",
        SIGNING_WALLET
      )
    );
    expect(createKoraAdapter).toHaveBeenCalledWith(
      BOTH_CLUSTERS_ENV,
      "sdp:v1:production:org%3Aalpha:project:project%2Fone:api_key:key%3Aprimary"
    );
  });
  it("rejects an incomplete scope instead of emitting an unscoped identity", () => {
    expect(() =>
      runInClusterScope(SANDBOX, () =>
        createSponsorshipFeePayment(
          testEnv,
          {
            organizationId: "org_test_sponsorship",
            projectId: "project_1",
            actor: { type: "user", id: " " },
          },
          "payments.transfer",
          SIGNING_WALLET
        )
      )
    ).toThrow("Sponsorship actor id is required");
    expect(createKoraAdapter).not.toHaveBeenCalled();
  });
  it("reaches each concurrent scope's own cluster's Kora", async () => {
    const devnetSigner = address(getBase58Codec().decode(new Uint8Array(32).fill(1)));
    const mainnetSigner = address(getBase58Codec().decode(new Uint8Array(32).fill(2)));
    const signerByKoraUrl = new Map<string, Address>([
      [KORA_URLS.devnet, devnetSigner],
      [KORA_URLS.mainnet, mainnetSigner],
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { signer_address: signerByKoraUrl.get(String(input)) },
      })
    );
    const sponsorFor = (clusterScope: typeof SANDBOX | typeof PRODUCTION) =>
      runInClusterScope(clusterScope, () =>
        createSponsorshipFeePayment(
          BOTH_CLUSTERS_ENV,
          SPONSORED_WALLET,
          "payments.transfer",
          SIGNING_WALLET
        ).getFeePayer()
      );

    await expect(Promise.all([sponsorFor(SANDBOX), sponsorFor(PRODUCTION)])).resolves.toEqual([
      devnetSigner,
      mainnetSigner,
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("refuses a production scope before signing when the mainnet paymaster is not wired", () => {
    expect(() =>
      runInClusterScope(PRODUCTION, () =>
        createSponsorshipFeePayment(testEnv, SPONSORED_WALLET, "payments.transfer", SIGNING_WALLET)
      )
    ).toThrow(expect.objectContaining({ code: "PROVIDER_NOT_AVAILABLE" }));
  });
  it.each([
    { scope: SANDBOX, configured: true },
    { scope: PRODUCTION, configured: false },
  ])(
    "reports a $scope.environment scope's paymaster as configured: $configured",
    ({ scope, configured }) => {
      expect(runInClusterScope(scope, () => isKoraSponsorshipConfigured(testEnv))).toBe(configured);
    }
  );
  it("budgets a self-hosted deployment's sponsorship as it does a managed one", () => {
    const sponsor = runInClusterScope(SANDBOX, () =>
      createSponsorshipFeePayment(
        { ...testEnv, SDP_DEPLOYMENT_MODE: "self_hosted" },
        SPONSORED_WALLET,
        "payments.transfer",
        SIGNING_WALLET
      )
    );
    expect(sponsor).toBeInstanceOf(BudgetedFeePayment);
  });
  it("derives request actors from authenticated middleware state, not request input", async () => {
    const app = new Hono<{
      Bindings: Env;
    }>();
    app.use("*", async (c, next) => {
      c.set("apiKey", {
        id: "key_trusted",
        organizationId: "org_trusted",
        projectId: "project_stale",
        grants: ALL_API_KEY_GRANTS,
        environment: "sandbox",
        walletAccess: { scope: "all" } as const,
      });
      await runInClusterScope({ projectId: "project_trusted", environment: "production" }, next);
    });
    app.get("/probe", (c) => c.json(resolveRequestSponsorshipScope(c)));
    const response = await app.request(
      "/probe?user_id=attacker",
      { headers: { "x-project-id": "project_attacker" } },
      testEnv
    );
    expect(await response.json()).toEqual({
      organizationId: "org_trusted",
      projectId: "project_trusted",
      actor: { type: "api_key", id: "key_trusted" },
    });
  });
  it("derives a user-scoped identity for authenticated Clerk users", async () => {
    const app = new Hono<{
      Bindings: Env;
    }>();
    app.use("*", async (c, next) => {
      c.set("clerk", await testClerkContext(testEnv));
      c.set("projectId", "project_trusted");
      c.set("projectEnvironment", "sandbox");
      await runInClusterScope({ projectId: "project_trusted", environment: "sandbox" }, next);
    });
    app.get("/probe", (c) => c.json(resolveRequestSponsorshipScope(c)));
    const response = await app.request("/probe", {}, testEnv);
    expect(await response.json()).toEqual({
      organizationId: TEST_ORG.id,
      projectId: "project_trusted",
      actor: { type: "user", id: TEST_USER.id },
    });
  });
  it("refuses Clerk sponsorship outside a cluster scope", async () => {
    const app = new Hono<{
      Bindings: Env;
    }>();
    app.use("*", async (c, next) => {
      c.set("clerk", await testClerkContext(testEnv));
      await next();
    });
    app.get("/probe", (c) => {
      expect(() => resolveRequestSponsorshipScope(c)).toThrow(
        expect.objectContaining({ code: "CLUSTER_SCOPE_MISSING" })
      );
      return c.text("checked");
    });
    const response = await app.request("/probe", {}, testEnv);
    expect(response.status).toBe(200);
  });
  it("derives background and public scopes from persisted project ownership", async () => {
    projectMocks.getProject.mockResolvedValue({
      id: "project_stored",
      organizationId: "org_stored",
      environment: "production",
      status: "active",
    });
    const scope = await runInClusterScope(
      { projectId: "project_stored", environment: "production" },
      () =>
        resolveProjectSponsorshipScope(testEnv, {
          organizationId: "org_stored",
          projectId: "project_stored",
          actor: { type: "wallet", id: "wallet_stored" },
        })
    );
    expect(scope).toEqual({
      organizationId: "org_stored",
      projectId: "project_stored",
      actor: { type: "wallet", id: "wallet_stored" },
    });
  });
  it("refuses a persisted project from another environment than the open scope", async () => {
    projectMocks.getProject.mockResolvedValue({
      id: "project_stored",
      organizationId: "org_stored",
      environment: "production",
      status: "active",
    });
    await expect(
      runInClusterScope({ projectId: "project_stored", environment: "sandbox" }, () =>
        resolveProjectSponsorshipScope(testEnv, {
          organizationId: "org_stored",
          projectId: "project_stored",
          actor: { type: "wallet", id: "wallet_stored" },
        })
      )
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
  it.each([
    { label: "is missing", project: null },
    {
      label: "belongs to another organization",
      project: {
        id: "project_stored",
        organizationId: "org_other",
        environment: "production",
        status: "active",
      },
    },
    {
      label: "is archived",
      project: {
        id: "project_stored",
        organizationId: "org_claimed",
        environment: "production",
        status: "archived",
      },
    },
  ])("refuses a persisted project that $label", async ({ project }) => {
    projectMocks.getProject.mockResolvedValue(project);
    await expect(
      resolveProjectSponsorshipScope(testEnv, {
        organizationId: "org_claimed",
        projectId: "project_stored",
        actor: { type: "wallet", id: "wallet_stored" },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("sponsorship construction guard", () => {
  const FEE_PAYMENT_CONSTRUCTORS = new Set(["createKoraAdapter", "KoraAdapter"]);
  const FEE_PAYMENT_SPECIFIER = `@sdp/fee-payment(?:/[^"']*)?`;
  const OPAQUE_IMPORT_PATTERNS = [
    new RegExp(String.raw`import\s+\*\s+as\s+[\w$]+\s+from\s+["']${FEE_PAYMENT_SPECIFIER}["']`),
    new RegExp(String.raw`import\s+(?!type\b)[\w$]+\s+from\s+["']${FEE_PAYMENT_SPECIFIER}["']`),
    new RegExp(
      String.raw`import\s+(?!type\b)[\w$]+\s*,[^;]*\sfrom\s+["']${FEE_PAYMENT_SPECIFIER}["']`
    ),
    new RegExp(
      String.raw`export\s+\*(?:\s+as\s+[\w$]+)?\s+from\s+["']${FEE_PAYMENT_SPECIFIER}["']`
    ),
    new RegExp(String.raw`require\(\s*["']${FEE_PAYMENT_SPECIFIER}["']\s*\)`),
    new RegExp(String.raw`import\(\s*["']${FEE_PAYMENT_SPECIFIER}["']\s*\)`),
  ];
  const NAMED_IMPORT_PATTERN =
    /(?:import|export)\s*{([^}]+)}\s*from\s*["']@sdp\/fee-payment(?:\/[^"']*)?["']/g;
  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    });
  }
  function constructsFeePaymentAdapter(relativePath: string, source: string): boolean {
    if (
      relativePath === "services/sponsorship.service.ts" ||
      relativePath.startsWith("test/") ||
      relativePath.includes("/test/") ||
      relativePath.endsWith(".test.ts") ||
      relativePath.endsWith(".spec.ts")
    ) {
      return false;
    }
    if (OPAQUE_IMPORT_PATTERNS.some((pattern) => pattern.test(source))) {
      return true;
    }
    for (const match of source.matchAll(NAMED_IMPORT_PATTERN)) {
      const importedNames = match[1].split(",").map(
        (entry) =>
          entry
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)[0]
      );
      if (importedNames.some((name) => FEE_PAYMENT_CONSTRUCTORS.has(name))) {
        return true;
      }
    }
    return false;
  }
  it("keeps production Kora adapter construction behind the owned boundary", () => {
    const apiSourceRoot = path.resolve(import.meta.dirname, "..");
    const violations = sourceFiles(apiSourceRoot)
      .map((file) => path.relative(apiSourceRoot, file).split(path.sep).join("/"))
      .filter((relativePath) =>
        constructsFeePaymentAdapter(
          relativePath,
          readFileSync(path.join(apiSourceRoot, relativePath), "utf8")
        )
      );
    expect(violations).toEqual([]);
  });
});
