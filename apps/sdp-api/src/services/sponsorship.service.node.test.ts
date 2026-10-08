import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as feePayment from "@sdp/payments/fee-payment";
import { createFeePaymentAdapter, type FeePaymentPort } from "@sdp/payments/fee-payment";
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
import { type AdmittedMovement, mintAdmittedMovementForTests } from "@/lib/admit-movement";
import { ProjectService } from "@/services/project.service";
import {
  buildKoraUserId,
  createProjectSponsorshipFeePayment,
  createSponsorshipFeePayment,
  resolveAuthenticatedSponsorshipScope,
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
        organizationId: "org_test_sponsorship",
        projectId: "project_1",
        actor: { type: "user", id: " " },
      })
    ).toThrow("Sponsorship actor id is required");
  });
  it("is the owned boundary that forwards the trusted scope to Kora", () => {
    const env: Env = { ...testEnv, FEE_PAYMENT_PROVIDER: "kora" };
    createSponsorshipFeePayment(env, {
      environment: "sandbox",
      organizationId: "org_test_sponsorship",
      projectId: "project_1",
      actor: { type: "user", id: "usr_test_sponsorship" },
    });
    expect(createFeePaymentAdapter).toHaveBeenCalledWith(
      env,
      "sdp:v1:sandbox:org_test_sponsorship:project:project_1:user:usr_test_sponsorship",
      undefined
    );
  });
  it("selects the paymaster by the scope's cluster when a flow names one", () => {
    const env: Env = { ...testEnv, FEE_PAYMENT_PROVIDER: "kora" };
    createSponsorshipFeePayment(env, {
      environment: "production",
      organizationId: "org_test_sponsorship",
      projectId: "project_1",
      actor: { type: "wallet", id: "cwlt_1" },
      cluster: "mainnet-beta",
    });
    expect(createFeePaymentAdapter).toHaveBeenCalledWith(
      env,
      "sdp:v1:production:org_test_sponsorship:project:project_1:wallet:cwlt_1",
      "mainnet-beta"
    );
  });
  function selfHostedFeePayment(signAsFeePayer: (transaction: Uint8Array) => Promise<Uint8Array>) {
    const provider: FeePaymentPort = {
      providerId: "kora",
      getFeePayer: vi.fn().mockResolvedValue(FEE_PAYER),
      signAsFeePayer: vi.fn().mockImplementation(signAsFeePayer),
      signAndSend: vi.fn(),
    };
    vi.mocked(createFeePaymentAdapter).mockReturnValueOnce(provider);
    return createSponsorshipFeePayment({ SDP_DEPLOYMENT_MODE: "self_hosted" } as Env, {
      environment: "sandbox",
      organizationId: "org_test_sponsorship",
      projectId: "project_1",
      actor: { type: "user", id: "usr_test_sponsorship" },
    });
  }
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
    const feePayment = createSponsorshipFeePayment({ SDP_DEPLOYMENT_MODE: "self_hosted" } as Env, {
      environment: "sandbox",
      organizationId: "org_test_sponsorship",
      projectId: "project_1",
      actor: { type: "user", id: "usr_test_sponsorship" },
    });
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
  it("derives a user-scoped identity for authenticated Clerk users", async () => {
    const app = new Hono<{
      Bindings: Env;
    }>();
    app.use("*", async (c, next) => {
      c.set("clerk", await testClerkContext(testEnv));
      c.set("projectId", "project_trusted");
      c.set("projectEnvironment", "sandbox");
      await next();
    });
    app.get("/probe", (c) => c.text(buildKoraUserId(resolveAuthenticatedSponsorshipScope(c))));
    const response = await app.request("/probe");
    expect(await response.text()).toBe(
      `sdp:v1:sandbox:${TEST_ORG.id}:project:project_trusted:user:${TEST_USER.id}`
    );
  });
  it("rejects Clerk sponsorship without a project environment", async () => {
    const app = new Hono<{
      Bindings: Env;
    }>();
    app.use("*", async (c, next) => {
      c.set("clerk", await testClerkContext(testEnv));
      await next();
    });
    app.get("/probe", (c) => {
      expect(() => resolveRequestSponsorshipScope(c)).toThrow(
        "Request environment could not be resolved"
      );
      return c.text("checked");
    });
    const response = await app.request("/probe", {}, testEnv);
    expect(response.status).toBe(200);
  });
  // HOO-1955: the admitted movement carries the persisted project's environment
  // and status from the admission join, so sponsorship no longer re-reads the
  // project. An organization/project mismatch cannot be admitted at all (see
  // admit-movement.test.ts), so the old cross-organization case is covered there.
  it("derives the sponsored scope from the admitted movement without a project read", () => {
    const env: Env = { ...testEnv, FEE_PAYMENT_PROVIDER: "kora" };
    createProjectSponsorshipFeePayment(
      env,
      mintAdmittedMovementForTests({
        organizationId: "org_stored",
        projectId: "project_stored",
        environment: "production",
      }),
      { actor: { type: "wallet", id: "wallet_stored" } }
    );
    expect(createFeePaymentAdapter).toHaveBeenCalledWith(
      env,
      "sdp:v1:production:org_stored:project:project_stored:wallet:wallet_stored",
      undefined
    );
    expect(projectMocks.getProject).not.toHaveBeenCalled();
  });
  it("refuses a movement admitted for a project that is not active", () => {
    expect(() =>
      createProjectSponsorshipFeePayment(
        testEnv,
        mintAdmittedMovementForTests({
          organizationId: "org_stored",
          projectId: "project_stored",
          projectStatus: "archived",
        }),
        { actor: { type: "wallet", id: "wallet_stored" } }
      )
    ).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(createFeePaymentAdapter).not.toHaveBeenCalled();
  });
  it("refuses a movement that was not minted by admission", () => {
    const forged = {
      organizationId: "org_claimed",
      projectId: "project_stored",
      environment: "production",
      projectStatus: "active",
    } as unknown as AdmittedMovement;
    expect(() =>
      createProjectSponsorshipFeePayment(testEnv, forged, {
        actor: { type: "wallet", id: "wallet_stored" },
      })
    ).toThrow("Value movement was not admitted");
    expect(createFeePaymentAdapter).not.toHaveBeenCalled();
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
