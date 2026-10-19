import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as feePayment from "@sdp/fee-payment";
import { createFeePaymentAdapter } from "@sdp/fee-payment";
import type { FeePaymentPort } from "@sdp/fee-payment/port";
import { runInClusterScope } from "@sdp/rpc/scope";
import {
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectService } from "@/services/project.service";
import {
  createSponsorshipFeePayment,
  isKoraSponsorshipConfigured,
  resolveProjectSponsorshipScope,
  resolveRequestSponsorshipScope,
} from "@/services/sponsorship.service";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { testClerkContext } from "@/test/helpers/clerk-context";
import { env as testEnv } from "@/test/helpers/env";
import {
  garbageSignTestTransaction,
  sponsorSignTestTransaction,
  TEST_MOCK_FEE_PAYER,
} from "@/test/helpers/sponsor-signing";
import type { Env } from "@/types/env";

const projectMocks = { getProject: vi.fn() };

const readMoneyAdmissionFacts = vi.hoisted(() => vi.fn());

vi.mock("@/lib/money-admission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/money-admission")>()),
  readMoneyAdmissionFacts,
}));

const FEE_PAYER = TEST_MOCK_FEE_PAYER;

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

function otherTransaction(): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (current) => setTransactionMessageFeePayer(FEE_PAYER, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 200n },
        current
      )
  );
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
}

describe("sponsorship identity boundary", () => {
  beforeEach(() => {
    readMoneyAdmissionFacts.mockResolvedValue({
      organizationStatus: "active",
      projectEnvironment: "sandbox",
      rawSettings: null,
    });
    vi.spyOn(feePayment, "createFeePaymentAdapter").mockReturnValue({
      providerId: "kora",
      getFeePayer: vi.fn(),
      signAsFeePayer: vi.fn(),
      signAndSend: vi.fn(),
    });
    vi.spyOn(feePayment, "resolveFeePaymentProvider").mockReturnValue("kora");
    vi.spyOn(ProjectService.prototype, "getProject").mockImplementation(projectMocks.getProject);
    projectMocks.getProject.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());
  it("builds a versioned tenant and actor scoped Kora user_id", () => {
    const env: Env = { ...testEnv, FEE_PAYMENT_PROVIDER: "kora" };
    createSponsorshipFeePayment(
      env,
      {
        environment: "production",
        organizationId: "org:alpha",
        projectId: "project/one",
        actor: { type: "api_key", id: "key:primary" },
      },
      "payments.transfer"
    );
    expect(createFeePaymentAdapter).toHaveBeenCalledWith(
      env,
      "sdp:v1:production:org%3Aalpha:project:project%2Fone:api_key:key%3Aprimary",
      "mainnet-beta"
    );
  });
  it("rejects an incomplete scope instead of emitting an unscoped identity", () => {
    expect(() =>
      createSponsorshipFeePayment(
        { ...testEnv, FEE_PAYMENT_PROVIDER: "kora" },
        {
          environment: "sandbox",
          organizationId: "org_test_sponsorship",
          projectId: "project_1",
          actor: { type: "user", id: " " },
        },
        "payments.transfer"
      )
    ).toThrow("Sponsorship actor id is required");
    expect(createFeePaymentAdapter).not.toHaveBeenCalled();
  });
  it("is the owned boundary that forwards the trusted scope to Kora", () => {
    const env: Env = { ...testEnv, FEE_PAYMENT_PROVIDER: "kora" };
    createSponsorshipFeePayment(
      env,
      {
        environment: "sandbox",
        organizationId: "org_test_sponsorship",
        projectId: "project_1",
        actor: { type: "user", id: "usr_test_sponsorship" },
      },
      "payments.transfer"
    );
    expect(createFeePaymentAdapter).toHaveBeenCalledWith(
      env,
      "sdp:v1:sandbox:org_test_sponsorship:project:project_1:user:usr_test_sponsorship",
      "devnet"
    );
  });
  it("selects the mainnet paymaster for a production project's sponsorship", () => {
    const env: Env = { ...testEnv, FEE_PAYMENT_PROVIDER: "kora" };
    createSponsorshipFeePayment(
      env,
      {
        environment: "production",
        organizationId: "org_test_sponsorship",
        projectId: "project_1",
        actor: { type: "wallet", id: "cwlt_1" },
      },
      "payments.transfer"
    );
    expect(createFeePaymentAdapter).toHaveBeenCalledWith(
      env,
      "sdp:v1:production:org_test_sponsorship:project:project_1:wallet:cwlt_1",
      "mainnet-beta"
    );
  });
  it("refuses a production scope before signing when the mainnet paymaster is not wired", () => {
    vi.mocked(createFeePaymentAdapter).mockRestore();
    expect(() =>
      createSponsorshipFeePayment(
        { ...testEnv, FEE_PAYMENT_PROVIDER: "kora" },
        {
          environment: "production",
          organizationId: "org_test_sponsorship",
          projectId: "project_1",
          actor: { type: "wallet", id: "cwlt_1" },
        },
        "payments.transfer"
      )
    ).toThrow(expect.objectContaining({ code: "PROVIDER_NOT_AVAILABLE" }));
  });
  it.each([
    { environment: "sandbox", configured: true },
    { environment: "production", configured: false },
  ] as const)(
    "reports a $environment scope's paymaster as configured: $configured",
    ({ environment, configured }) => {
      expect(
        isKoraSponsorshipConfigured(testEnv, {
          environment,
          organizationId: "org_test_sponsorship",
          projectId: "project_1",
          actor: { type: "wallet", id: "cwlt_1" },
        })
      ).toBe(configured);
    }
  );
  function selfHostedFeePayment(signAsFeePayer: (transaction: Uint8Array) => Promise<Uint8Array>) {
    const provider: FeePaymentPort = {
      providerId: "kora",
      getFeePayer: vi.fn().mockResolvedValue(FEE_PAYER),
      signAsFeePayer: vi.fn().mockImplementation(signAsFeePayer),
      signAndSend: vi.fn(),
    };
    vi.mocked(createFeePaymentAdapter).mockReturnValueOnce(provider);
    return createSponsorshipFeePayment(
      { ...testEnv, SDP_DEPLOYMENT_MODE: "self_hosted" },
      {
        environment: "sandbox",
        organizationId: "org_test_sponsorship",
        projectId: "project_1",
        actor: { type: "user", id: "usr_test_sponsorship" },
      },
      "payments.transfer"
    );
  }
  it("refuses a self-hosted sponsor signature for a start the organization may not make", async () => {
    readMoneyAdmissionFacts.mockResolvedValue({
      organizationStatus: "deleted",
      projectEnvironment: "sandbox",
      rawSettings: null,
    });
    const signAsFeePayer = vi.fn(async (transaction: Uint8Array) => transaction);
    const feePayment = selfHostedFeePayment(signAsFeePayer);

    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "FORBIDDEN",
      reason: "organization_inactive",
    });
    expect(signAsFeePayer).not.toHaveBeenCalled();
  });
  it("refuses self-hosted sponsor bytes without the sponsor signature", async () => {
    const feePayment = selfHostedFeePayment(async (transaction) => transaction);
    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toThrow(
      "missing the sponsor fee-payer signature"
    );
  });
  it("refuses self-hosted sponsor bytes whose signature does not verify", async () => {
    const feePayment = selfHostedFeePayment(async (transaction) =>
      garbageSignTestTransaction(transaction)
    );
    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toThrow(
      "invalid sponsor fee-payer signature"
    );
  });
  it("refuses self-hosted sponsor bytes returned over a different message", async () => {
    const feePayment = selfHostedFeePayment(() => sponsorSignTestTransaction(otherTransaction()));
    const lifecycle = {
      persistSigned: vi.fn(),
      markStarted: vi.fn(),
      hasStarted: vi.fn(),
    };
    await expect(feePayment.prepareOwnedSubmission(buildTransaction(), lifecycle)).rejects.toThrow(
      "came back over a different message"
    );
    expect(lifecycle.persistSigned).not.toHaveBeenCalled();
  });
  it("adapts self-hosted providers to the owned persist-before-marker lifecycle", async () => {
    const signedTransaction = await sponsorSignTestTransaction(buildTransaction());
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
    const feePayment = createSponsorshipFeePayment(
      { ...testEnv, SDP_DEPLOYMENT_MODE: "self_hosted" },
      {
        environment: "sandbox",
        organizationId: "org_test_sponsorship",
        projectId: "project_1",
        actor: { type: "user", id: "usr_test_sponsorship" },
      },
      "payments.transfer"
    );
    const submission = await feePayment.prepareOwnedSubmission(buildTransaction(), lifecycle);
    expect(submission.signedTransaction).toStrictEqual(signedTransaction);
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
    const app = new Hono<{
      Bindings: Env;
    }>();
    app.use("*", async (c, next) => {
      c.set("apiKey", {
        id: "key_trusted",
        organizationId: "org_trusted",
        projectId: "project_stale",
        role: "api_admin",
        permissions: ["*"],
        environment: "sandbox",
        signingWalletId: null,
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
      environment: "production",
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
      environment: "sandbox",
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
    const env: Env = { ...testEnv, FEE_PAYMENT_PROVIDER: "kora" };
    const scope = await resolveProjectSponsorshipScope(env, {
      organizationId: "org_stored",
      projectId: "project_stored",
      actor: { type: "wallet", id: "wallet_stored" },
    });
    expect(scope).toEqual({
      environment: "production",
      organizationId: "org_stored",
      projectId: "project_stored",
      actor: { type: "wallet", id: "wallet_stored" },
    });
    createSponsorshipFeePayment(env, scope, "recurring.collect");
    expect(createFeePaymentAdapter).toHaveBeenCalledWith(
      env,
      "sdp:v1:production:org_stored:project:project_stored:wallet:wallet_stored",
      "mainnet-beta"
    );
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
  const FEE_PAYMENT_CONSTRUCTORS = new Set([
    "createFeePaymentAdapter",
    "createKoraAdapter",
    "KoraAdapter",
  ]);
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
