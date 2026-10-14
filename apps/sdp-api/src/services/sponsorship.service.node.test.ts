import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as feePayment from "@sdp/fee-payment";
import { createFeePaymentAdapter, type FeePaymentPort } from "@sdp/fee-payment";
import * as solanaRpc from "@sdp/rpc/solana";
import {
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Codec,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { SponsorshipBudgetRepository } from "@/db/repositories/sponsorship-budget.repository";
import { ProjectService } from "@/services/project.service";
import {
  buildKoraUserId,
  createProjectSponsorshipFeePayment,
  createSponsorshipFeePayment,
  resolveAuthenticatedSponsorshipScope,
  resolveRequestSponsorshipScope,
  type SponsorshipAccountingIdentity,
} from "@/services/sponsorship.service";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { testClerkContext } from "@/test/helpers/clerk-context";
import { env as testEnv } from "@/test/helpers/env";
import {
  garbageSignTestTransaction,
  sponsorSignTestTransaction,
  TEST_MOCK_FEE_PAYER,
} from "@/test/helpers/sponsor-signing";
import { seedTestDatabase } from "@/test/mocks/db";
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
      movement: "payments.transfer",
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
      movement: "payments.transfer",
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
  it("continues a real legacy reservation and its Kora identity without admitting the exact actor again", async () => {
    await seedTestDatabase(testEnv);
    const getNetworkFee = vi.spyOn(solanaRpc, "getTransactionNetworkFee").mockResolvedValue(5_000n);
    const provider: FeePaymentPort = {
      providerId: "kora",
      getFeePayer: vi.fn().mockResolvedValue(FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue({
        signerAddress: FEE_PAYER,
        maxAllowedLamports: 1_000_000n,
        feePayerMayTransferLamports: false,
        feePayerPolicy: { system: { allow_transfer: false } },
      }),
      signAsFeePayer: vi.fn().mockImplementation(sponsorSignTestTransaction),
      signAndSend: vi.fn(),
    };
    // Distinct ports expose actor-specific transport work as well as construction.
    const payerReads: Array<string | undefined> = [];
    vi.mocked(createFeePaymentAdapter).mockImplementation((_env, userId) => ({
      ...provider,
      getFeePayer: () => {
        payerReads.push(userId);
        return provider.getFeePayer();
      },
    }));
    const scope = {
      environment: "sandbox" as const,
      organizationId: "org_test_sponsorship",
      projectId: "project_1",
      movement: "payments.transfer" as const,
      actor: { type: "wallet" as const, id: "provider_recipient" },
    };
    const legacy = createSponsorshipFeePayment(testEnv, scope);
    const original = await legacy.signAsFeePayer(buildTransaction());
    const [retained] = await new SponsorshipBudgetRepository(
      getDb(testEnv)
    ).findReservationEvidence({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      transactionDigest: createHash("sha256")
        .update(new Uint8Array(getTransactionDecoder().decode(buildTransaction()).messageBytes))
        .digest("hex"),
    });
    if (!retained) throw new Error("Legacy reservation is missing");
    const persistAccountingIdentity = vi.fn().mockResolvedValue(undefined);
    const continued = createSponsorshipFeePayment(testEnv, {
      ...scope,
      actor: { type: "wallet", id: "cwlt_recipient" },
      continuity: {
        deploymentMode: "managed",
        legacyActor: scope.actor,
        exactActor: { type: "wallet", id: "cwlt_recipient" },
        admission: "continue_only",
        reservationId: retained.id,
        persistAccountingIdentity,
      },
    });

    await expect(continued.getFeePayer()).resolves.toBe(FEE_PAYER);
    await expect(continued.signAsFeePayer(buildTransaction())).resolves.toEqual(original);
    await expect(continued.signAsFeePayer(buildTransaction())).resolves.toEqual(original);
    expect(createFeePaymentAdapter).toHaveBeenCalledTimes(2);
    expect(payerReads).toEqual([
      "sdp:v1:sandbox:org_test_sponsorship:project:project_1:wallet:provider_recipient",
    ]);
    expect(provider.getSponsorshipConfiguration).toHaveBeenCalledTimes(3);
    expect(getNetworkFee).toHaveBeenCalledTimes(3);
    expect(provider.signAsFeePayer).toHaveBeenCalledOnce();
    expect(persistAccountingIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: scope.actor,
        attempt: 1,
      })
    );
    expect(vi.mocked(createFeePaymentAdapter).mock.calls.at(-1)?.[1]).toBe(
      "sdp:v1:sandbox:org_test_sponsorship:project:project_1:wallet:provider_recipient"
    );
  });

  it("refuses a historical managed reservation on self-hosted continuation instead of ignoring its charge", async () => {
    await seedTestDatabase(testEnv);
    await new SponsorshipBudgetRepository(getDb(testEnv)).createReservation({
      id: "sbr_historic_managed",
      network: "devnet",
      productEnvironment: "sandbox",
      organizationId: "org_test_sponsorship",
      projectId: "project_1",
      actorType: "wallet",
      actorId: "provider_recipient",
      transactionDigest: "historic-message",
      feePayer: FEE_PAYER,
      providerConfigFingerprint: "historic-configuration",
      recentBlockhash: BLOCKHASH,
      reservedLamports: 5_000,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      policyVersions: {},
    });
    const provider: FeePaymentPort = {
      providerId: "kora",
      getFeePayer: vi.fn().mockResolvedValue(FEE_PAYER),
      signAsFeePayer: vi.fn().mockImplementation(sponsorSignTestTransaction),
      signAndSend: vi.fn(),
    };
    vi.mocked(createFeePaymentAdapter).mockReturnValue(provider);
    const feePayment = createSponsorshipFeePayment(
      { ...testEnv, SDP_DEPLOYMENT_MODE: "self_hosted" },
      {
        environment: "sandbox",
        organizationId: "org_test_sponsorship",
        projectId: "project_1",
        movement: "payments.transfer",
        actor: { type: "wallet", id: "cwlt_recipient" },
        continuity: {
          deploymentMode: "self_hosted",
          legacyActor: { type: "wallet", id: "provider_recipient" },
          exactActor: { type: "wallet", id: "cwlt_recipient" },
          admission: "continue_only",
          reservationId: "sbr_historic_managed",
          persistAccountingIdentity: vi.fn(),
        },
      }
    );
    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toThrow(
      "Managed accounting evidence"
    );
    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
  });

  it.each(["sign", "send", "owned"] as const)(
    "refuses self-hosted continuity %s after organization revocation",
    async (operation) => {
      await seedTestDatabase(testEnv);
      readMoneyAdmissionFacts.mockResolvedValue({
        organizationStatus: "deleted",
        projectEnvironment: "sandbox",
        rawSettings: null,
      });
      const provider: FeePaymentPort = {
        providerId: "kora",
        getFeePayer: vi.fn().mockResolvedValue(FEE_PAYER),
        signAsFeePayer: vi.fn().mockImplementation(sponsorSignTestTransaction),
        signAndSend: vi.fn(),
      };
      vi.mocked(createFeePaymentAdapter).mockReturnValue(provider);
      const feePayment = createSponsorshipFeePayment(
        { ...testEnv, SDP_DEPLOYMENT_MODE: "self_hosted" },
        {
          movement: "payments.transfer",
          environment: "sandbox",
          organizationId: "org_test_sponsorship",
          projectId: "project_1",
          actor: { type: "wallet", id: "cwlt_recipient" },
          continuity: {
            deploymentMode: "self_hosted",
            legacyActor: { type: "wallet", id: "provider_recipient" },
            exactActor: { type: "wallet", id: "cwlt_recipient" },
            admission: "continue_only",
            persistAccountingIdentity: vi.fn(),
          },
        }
      );

      const result = {
        sign: () => feePayment.signAsFeePayer(buildTransaction()),
        send: () => feePayment.signAndSend(buildTransaction()),
        owned: () =>
          feePayment.prepareOwnedSubmission(buildTransaction(), {
            persistSigned: vi.fn(),
            markStarted: vi.fn(),
            hasStarted: vi.fn(),
          }),
      }[operation]();
      await expect(result).rejects.toMatchObject({
        code: "FORBIDDEN",
        reason: "organization_inactive",
      });
      expect(provider.signAsFeePayer).not.toHaveBeenCalled();
      expect(provider.signAndSend).not.toHaveBeenCalled();
    }
  );

  it("preserves self-hosted quota identity without fabricating managed accounting", async () => {
    await seedTestDatabase(testEnv);
    const provider: FeePaymentPort = {
      providerId: "kora",
      getFeePayer: vi.fn().mockResolvedValue(FEE_PAYER),
      signAsFeePayer: vi.fn().mockImplementation(sponsorSignTestTransaction),
      signAndSend: vi.fn(),
    };
    vi.mocked(createFeePaymentAdapter).mockReturnValue(provider);
    const persistAccountingIdentity = vi.fn();
    const feePayment = createSponsorshipFeePayment(
      { ...testEnv, SDP_DEPLOYMENT_MODE: "self_hosted" },
      {
        environment: "sandbox",
        organizationId: "org_test_sponsorship",
        projectId: "project_1",
        movement: "payments.transfer",
        actor: { type: "wallet", id: "cwlt_recipient" },
        continuity: {
          deploymentMode: "self_hosted",
          legacyActor: { type: "wallet", id: "provider_recipient" },
          exactActor: { type: "wallet", id: "cwlt_recipient" },
          admission: "continue_only",
          persistAccountingIdentity,
        },
      }
    );
    await expect(feePayment.signAsFeePayer(buildTransaction())).resolves.toBeInstanceOf(Uint8Array);
    expect(persistAccountingIdentity).not.toHaveBeenCalled();
    expect(vi.mocked(createFeePaymentAdapter).mock.calls.at(-1)?.[1]).toBe(
      "sdp:v1:sandbox:org_test_sponsorship:project:project_1:wallet:provider_recipient"
    );
    const repository = new SponsorshipBudgetRepository(getDb(testEnv));
    await expect(
      repository.getWindowUsage({
        network: "devnet",
        organizationId: "org_test_sponsorship",
        projectId: "project_1",
        hourBucket: "2026-08-03T10:00:00.000Z",
        dayBucket: "2026-08-03T00:00:00.000Z",
      })
    ).resolves.toEqual({
      hour: { global: 0, organization: 0, project: 0 },
      day: { global: 0, organization: 0, project: 0 },
    });
  });

  it.each([
    [undefined, "self_hosted"],
    ["self_hosted", "managed"],
  ] as const)(
    "refuses retained deployment mode %s/%s before constructing a provider",
    (runtimeMode, deploymentMode) => {
      expect(() =>
        createSponsorshipFeePayment(
          { ...testEnv, SDP_DEPLOYMENT_MODE: runtimeMode },
          {
            environment: "sandbox",
            organizationId: "org_test_sponsorship",
            projectId: "project_1",
            movement: "payments.transfer",
            actor: { type: "wallet", id: "cwlt_recipient" },
            continuity: {
              deploymentMode,
              legacyActor: { type: "wallet", id: "provider_recipient" },
              exactActor: { type: "wallet", id: "cwlt_recipient" },
              admission: "after_writer_retirement",
              persistAccountingIdentity: vi.fn(),
            },
          }
        )
      ).toThrow("Deployment mode");
      expect(createFeePaymentAdapter).not.toHaveBeenCalled();
    }
  );

  it("fences concurrent compatible writers while the real reservation waits for domain linkage", async () => {
    await seedTestDatabase(testEnv);
    vi.spyOn(solanaRpc, "getTransactionNetworkFee").mockResolvedValue(5_000n);
    const provider: FeePaymentPort = {
      providerId: "kora",
      getFeePayer: vi.fn().mockResolvedValue(FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue({
        signerAddress: FEE_PAYER,
        maxAllowedLamports: 1_000_000n,
        feePayerMayTransferLamports: false,
        feePayerPolicy: { system: { allow_transfer: false } },
      }),
      signAsFeePayer: vi.fn().mockImplementation(sponsorSignTestTransaction),
      signAndSend: vi.fn(),
    };
    vi.mocked(createFeePaymentAdapter).mockReturnValue(provider);
    let releaseLinkage = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseLinkage = resolve;
    });
    let publishIdentity: (identity: SponsorshipAccountingIdentity) => void = () => {};
    const linked = new Promise<SponsorshipAccountingIdentity>((resolve) => {
      publishIdentity = resolve;
    });
    const scope = {
      environment: "sandbox" as const,
      organizationId: "org_test_sponsorship",
      projectId: "project_1",
      movement: "payments.transfer" as const,
      actor: { type: "wallet" as const, id: "cwlt_recipient" },
      continuity: {
        deploymentMode: "managed" as const,
        legacyActor: { type: "wallet" as const, id: "provider_recipient" },
        exactActor: { type: "wallet" as const, id: "cwlt_recipient" },
        admission: "after_writer_retirement" as const,
        persistAccountingIdentity: async (identity: SponsorshipAccountingIdentity) => {
          publishIdentity(identity);
          await gate;
        },
      },
    };
    const first = createSponsorshipFeePayment(testEnv, scope).signAsFeePayer(buildTransaction());
    const identity = await linked;
    try {
      await expect(
        createSponsorshipFeePayment(testEnv, scope).signAsFeePayer(buildTransaction())
      ).rejects.toThrow("in progress");
      expect(provider.signAsFeePayer).not.toHaveBeenCalled();
    } finally {
      releaseLinkage();
    }
    await expect(first).resolves.toBeInstanceOf(Uint8Array);
    expect(provider.signAsFeePayer).toHaveBeenCalledOnce();
    await expect(
      new SponsorshipBudgetRepository(getDb(testEnv)).findReservationEvidence({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        transactionDigest: identity.transactionDigest,
      })
    ).resolves.toEqual([
      expect.objectContaining({ id: identity.reservationId, status: "signed", attempt: 1 }),
    ]);
  });

  it("refuses a foreign self-hosted actor before constructing its quota provider", () => {
    expect(() =>
      createSponsorshipFeePayment(
        { ...testEnv, SDP_DEPLOYMENT_MODE: "self_hosted" },
        {
          environment: "sandbox",
          organizationId: "org_test_sponsorship",
          projectId: "project_1",
          movement: "payments.transfer",
          actor: { type: "wallet", id: "foreign_wallet" },
          continuity: {
            deploymentMode: "self_hosted",
            legacyActor: { type: "wallet", id: "provider_recipient" },
            exactActor: { type: "wallet", id: "cwlt_recipient" },
            admission: "after_writer_retirement",
            persistAccountingIdentity: vi.fn(),
          },
        }
      )
    ).toThrow("does not belong");
    expect(createFeePaymentAdapter).not.toHaveBeenCalled();
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
      movement: "payments.transfer",
      environment: "sandbox",
      organizationId: "org_test_sponsorship",
      projectId: "project_1",
      actor: { type: "user", id: "usr_test_sponsorship" },
    });
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
    const feePayment = createSponsorshipFeePayment({ SDP_DEPLOYMENT_MODE: "self_hosted" } as Env, {
      movement: "payments.transfer",
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
  it("derives background and public scopes from persisted project ownership", async () => {
    projectMocks.getProject.mockResolvedValue({
      id: "project_stored",
      organizationId: "org_stored",
      environment: "production",
      status: "active",
    });
    const env: Env = { ...testEnv, FEE_PAYMENT_PROVIDER: "kora" };
    await createProjectSponsorshipFeePayment(env, {
      movement: "recurring.collect",
      organizationId: "org_stored",
      projectId: "project_stored",
      actor: { type: "wallet", id: "wallet_stored" },
    });
    expect(createFeePaymentAdapter).toHaveBeenCalledWith(
      env,
      "sdp:v1:production:org_stored:project:project_stored:wallet:wallet_stored",
      undefined
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
      createProjectSponsorshipFeePayment(testEnv, {
        movement: "recurring.collect",
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
