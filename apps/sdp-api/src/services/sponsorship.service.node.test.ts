import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createFeePaymentAdapter, type FeePaymentPort } from "@sdp/payments/fee-payment";
import {
  type Address,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Codec,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
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

const FEE_PAYER = "11111111111111111111111111111111" as Address;
const BLOCKHASH = getBase58Codec().decode(new Uint8Array(32).fill(7)) as Blockhash;

function buildTransaction(): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(FEE_PAYER, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
        current
      )
  );
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
}

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

  it("adapts self-hosted providers to the owned persist-before-marker lifecycle", async () => {
    const signedTransaction = buildTransaction();
    signedTransaction.fill(1, 1, 65);
    const provider: FeePaymentPort = {
      providerId: "kora",
      getFeePayer: vi.fn().mockResolvedValue(FEE_PAYER),
      signAsFeePayer: vi.fn().mockResolvedValue(signedTransaction),
      signAndSend: vi.fn(),
    };
    vi.mocked(createFeePaymentAdapter).mockReturnValueOnce(provider);
    const lifecycle = {
      persistSigned: vi.fn().mockResolvedValue(undefined),
      markStarted: vi.fn().mockResolvedValue(undefined),
      hasStarted: vi.fn(),
    };

    const feePayment = createSponsorshipFeePayment({ SDP_DEPLOYMENT_MODE: "self_hosted" } as Env, {
      environment: "sandbox",
      organizationId: "org_1",
      projectId: "project_1",
      actor: { type: "user", id: "user_1" },
    });
    const submission = await feePayment.prepareOwnedSubmission(buildTransaction(), lifecycle);

    expect(submission.signedTransaction).toBe(signedTransaction);
    expect(lifecycle.persistSigned).toHaveBeenCalledWith(submission);
    expect(lifecycle.persistSigned.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycle.markStarted.mock.invocationCallOrder[0]
    );
    expect(lifecycle.hasStarted).not.toHaveBeenCalled();
    await expect(submission.releaseDefinitelyUnbroadcast(new Error("preflight"))).resolves.toBe(
      undefined
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

  it("derives a user-scoped identity for authenticated dashboard sessions", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("session", {
        id: "session_trusted",
        userId: "user_trusted",
        organizationId: "org_trusted",
        permissions: ["wallets:write"],
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      c.set("projectId", "project_trusted");
      c.set("projectEnvironment", "sandbox");
      await next();
    });
    app.get("/probe", (c) => c.text(buildKoraUserId(resolveAuthenticatedSponsorshipScope(c))));

    const response = await app.request("/probe");

    expect(await response.text()).toBe(
      "sdp:v1:sandbox:org_trusted:project:project_trusted:user:user_trusted"
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
  const FEE_PAYMENT_CONSTRUCTORS = new Set([
    "createFeePaymentAdapter",
    "createKoraAdapter",
    "KoraAdapter",
  ]);
  const FEE_PAYMENT_SPECIFIER = `@sdp/payments/fee-payment(?:/[^"']*)?`;
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
    /(?:import|export)\s*{([^}]+)}\s*from\s*["']@sdp\/payments\/fee-payment(?:\/[^"']*)?["']/g;

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
