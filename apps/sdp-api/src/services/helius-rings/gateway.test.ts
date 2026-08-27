import type { RingsGatewayPort } from "@sdp/helius-rings";
import { HeliusRingsError } from "@sdp/helius-rings";
import { describe, expect, it } from "vitest";
import { gatewayStub } from "@/test/fixtures/rings-gateway";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";
import {
  type ResolveRingsGatewayDependencies,
  resolveRingsGateway,
  ringsUpstreamsConfigured,
  UnconfiguredRingsGateway,
} from "./gateway";

/**
 * Read off the seam rather than imported from `@sdp/helius-rings-sdk`:
 * `gateway.ts` is the only file in this app allowed to reach that package, and
 * a test is not a good reason to make it two.
 */
type CapturedConfig = Parameters<NonNullable<ResolveRingsGatewayDependencies["createGateway"]>>[0];

const tenant = { organizationId: "org_1", projectId: "prj_1" };

/** A fully configured deployment. Nothing here is ever dialled. */
const CONFIGURED = {
  HELIUS_RINGS_RPC_URL: "https://rpc.invalid/?api-key=key",
  HELIUS_RINGS_INDEXER_URL: "https://indexer.invalid",
  HELIUS_RINGS_PROVER_URL: "https://prover.invalid",
  HELIUS_RINGS_DETERMINISTIC_KA_SEED: Buffer.alloc(32, 7).toString("base64"),
} satisfies Partial<Env>;

function envOf(overrides: Partial<Env> = {}): Env {
  return { ...CONFIGURED, ...overrides } as Env;
}

/** Captures the config instead of building a real SDK gateway. */
function capturingCreate() {
  const captured: CapturedConfig[] = [];
  const createGateway = (config: CapturedConfig): RingsGatewayPort => {
    captured.push(config);
    return gatewayStub({});
  };
  return { captured, createGateway };
}

/** Every method a caller could reach for, so none of them can be forgotten. */
const allMethods: Array<[string, (gateway: RingsGatewayPort) => Promise<unknown>]> = [
  ["provisionIdentity", (g) => g.provisionIdentity({ walletId: "hrw_1", sdpAddress: "owner" })],
  ["readIdentity", (g) => g.readIdentity({ walletId: "hrw_1", owner: "owner" })],
  ["syncPhoton", (g) => g.syncPhoton({ walletId: "hrw_1", owner: "owner", cursor: null })],
  ["buildOperation", (g) => g.buildOperation({ operation: {} as never, keyRefs: [] })],
  ["requestProof", (g) => g.requestProof({ operationId: "hro_1", ringsMetadata: {} as never })],
  ["verifyIndexed", (g) => g.verifyIndexed("sig")],
];

describe("resolveRingsGateway", () => {
  describe("gateway construction", () => {
    it("builds the SDK gateway when every upstream is configured", () => {
      const { captured, createGateway } = capturingCreate();

      resolveRingsGateway(envOf(), tenant, { createGateway });

      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        solanaRpcUrl: CONFIGURED.HELIUS_RINGS_RPC_URL,
        indexerUrl: CONFIGURED.HELIUS_RINGS_INDEXER_URL,
        proverUrl: CONFIGURED.HELIUS_RINGS_PROVER_URL,
        derivationSeed: CONFIGURED.HELIUS_RINGS_DETERMINISTIC_KA_SEED,
        // Fixed at construction: a gateway that took the tenant per call could
        // be handed a wallet id from another one and derive under its path.
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
      });
    });

    // The public devnet indexer and prover are plain http on a real host, so
    // the flag is the difference between the adapter working and reporting
    // red. It is read as a flag rather than inferred from the scheme of the
    // URLs, so a production typo cannot quietly authorise plaintext.
    it.each([
      [undefined, false],
      ["false", false],
      ["true", true],
      ["1", true],
    ])("passes HELIUS_RINGS_ALLOW_INSECURE_HTTP=%o through as %o", (flag, expected) => {
      const { captured, createGateway } = capturingCreate();

      resolveRingsGateway(envOf({ HELIUS_RINGS_ALLOW_INSECURE_HTTP: flag }), tenant, {
        createGateway,
      });

      expect(captured[0]).toMatchObject({ allowInsecureHttp: expected });
    });

    // An unfunded owner is an ordinary operator mistake, and it surfaces as a
    // RingsAdapterError from SDP's own RPC adapter. The SDK's error bridge only
    // recognises Zolana's error classes, so unless it is translated right here
    // it reaches the route unmapped and the operator gets a 500.
    it.each([
      ["submit_failed", true, "gateway_unavailable"],
      ["signer_failed", false, "invalid_input"],
      ["signer_failed", true, "gateway_unavailable"],
    ] as const)(
      "reports a %s adapter failure (retryable=%o) as %s",
      async (failureCode, retryable, expected) => {
        const { captured, createGateway } = capturingCreate();
        const boom = new RingsAdapterError(failureCode, "boom", { retryable });

        resolveRingsGateway(envOf(), tenant, {
          createGateway,
          signOuterTransaction: async () => {
            throw boom;
          },
          submitOuterTransaction: async () => {
            throw boom;
          },
        });

        const config = captured[0];
        if (!config) throw new Error("no gateway config was captured");

        const call =
          failureCode === "submit_failed"
            ? config.submitTransaction("signed")
            : config.signTransaction("unsigned", "OwnerPublicKey");

        await expect(call).rejects.toMatchObject({ code: expected });
      }
    );

    // The RPC URL carries a Helius API key and RPC errors quote the endpoint
    // they failed on, so the upstream text must not reach the response.
    it("does not forward the adapter's own message", async () => {
      const { captured, createGateway } = capturingCreate();

      resolveRingsGateway(envOf(), tenant, {
        createGateway,
        submitOuterTransaction: async () => {
          throw new RingsAdapterError(
            "submit_failed",
            `failed calling ${CONFIGURED.HELIUS_RINGS_RPC_URL}`,
            { retryable: true }
          );
        },
      });

      const config = captured[0];
      if (!config) throw new Error("no gateway config was captured");

      await expect(config.submitTransaction("signed")).rejects.toThrow(/devnet SOL for the fee/);
      await expect(config.submitTransaction("signed")).rejects.not.toThrow(/api-key/);
    });

    it("leaves a non-adapter failure alone for the API's own scrubbed fallback", async () => {
      const { captured, createGateway } = capturingCreate();

      resolveRingsGateway(envOf(), tenant, {
        createGateway,
        submitOuterTransaction: async () => {
          throw new TypeError("something else entirely");
        },
      });

      const config = captured[0];
      if (!config) throw new Error("no gateway config was captured");

      await expect(config.submitTransaction("signed")).rejects.toBeInstanceOf(TypeError);
    });

    it("binds the signing and submission callbacks to the tenant and the named owner", async () => {
      const { captured, createGateway } = capturingCreate();
      const signCalls: unknown[] = [];
      const submitCalls: unknown[] = [];

      resolveRingsGateway(envOf(), tenant, {
        createGateway,
        signOuterTransaction: async (input) => {
          signCalls.push(input);
          return "signed";
        },
        submitOuterTransaction: async (input) => {
          submitCalls.push(input);
          return "sig";
        },
      });

      const config = captured[0];
      if (!config) throw new Error("no gateway config was captured");
      await expect(config.signTransaction("unsigned", "OwnerPublicKey")).resolves.toBe("signed");
      await expect(config.submitTransaction("signed")).resolves.toBe("sig");

      // The owner reaches the signer: the identity is registered to one key and
      // the org default is not it.
      expect(signCalls[0]).toMatchObject({
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
        owner: "OwnerPublicKey",
        unsignedTxBase64: "unsigned",
      });
      expect(submitCalls[0]).toMatchObject({ signedTxBase64: "signed" });
    });
  });

  describe("incompletely configured", () => {
    const requiredKeys = [
      "HELIUS_RINGS_RPC_URL",
      "HELIUS_RINGS_INDEXER_URL",
      "HELIUS_RINGS_PROVER_URL",
      "HELIUS_RINGS_DETERMINISTIC_KA_SEED",
    ] as const satisfies ReadonlyArray<keyof Env>;

    it.each(requiredKeys)("names %s when it is absent", async (key) => {
      const env = envOf({ [key]: undefined });
      const gateway = resolveRingsGateway(env, tenant);

      expect(gateway).toBeInstanceOf(UnconfiguredRingsGateway);
      const health = await gateway.probeHealth();
      expect(health.detail?.gateway).toContain(key);
      // The indexing poll asks the same question, so it cannot wake up next to
      // a gateway that would refuse every operation it handed over.
      expect(ringsUpstreamsConfigured(env)).toBe(false);
    });

    // A `KEY=` line is an operator who has not filled it in, not one who chose
    // the empty URL, so it has to read as missing rather than be handed to the
    // SDK to fail on later.
    it("treats a blank value as absent", async () => {
      const env = envOf({ HELIUS_RINGS_PROVER_URL: "   " });
      const gateway = resolveRingsGateway(env, tenant);

      expect(gateway).toBeInstanceOf(UnconfiguredRingsGateway);
      expect((await gateway.probeHealth()).detail?.gateway).toContain("HELIUS_RINGS_PROVER_URL");
      expect(ringsUpstreamsConfigured(env)).toBe(false);
    });

    it("never builds the SDK gateway", () => {
      const { captured, createGateway } = capturingCreate();

      resolveRingsGateway(envOf({ HELIUS_RINGS_INDEXER_URL: undefined }), tenant, {
        createGateway,
      });

      expect(captured).toHaveLength(0);
    });

    it("does not throw at construction", () => {
      expect(() =>
        resolveRingsGateway(envOf({ HELIUS_RINGS_RPC_URL: undefined }), tenant)
      ).not.toThrow();
    });
  });
});

describe("ringsUpstreamsConfigured", () => {
  it("is true only when all four upstreams are set", () => {
    expect(ringsUpstreamsConfigured(envOf())).toBe(true);
  });
});

describe("UnconfiguredRingsGateway", () => {
  const gateway = new UnconfiguredRingsGateway([
    "HELIUS_RINGS_INDEXER_URL",
    "HELIUS_RINGS_PROVER_URL",
  ]);

  it("reports every component red naming the missing variables", async () => {
    const health = await gateway.probeHealth();

    expect(health).toMatchObject({ rpc: "red", photon: "red", prover: "red", gateway: "red" });
    for (const component of ["rpc", "photon", "prover", "gateway"] as const) {
      expect(health.detail?.[component]).toContain("HELIUS_RINGS_INDEXER_URL");
      expect(health.detail?.[component]).toContain("HELIUS_RINGS_PROVER_URL");
    }
  });

  it.each(allMethods)("fails %s closed with config_error", async (_method, call) => {
    const error = await call(gateway).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(HeliusRingsError);
    // Not `gateway_unavailable`: the fix is an environment edit, so a retry
    // button cannot succeed and must not be offered.
    expect(error).toMatchObject({ code: "config_error" });
    expect((error as Error).message).toContain("HELIUS_RINGS_INDEXER_URL");
  });

  it("reads as singular when only one variable is missing", async () => {
    const health = await new UnconfiguredRingsGateway(["HELIUS_RINGS_RPC_URL"]).probeHealth();

    expect(health.detail?.gateway).toContain("HELIUS_RINGS_RPC_URL is not configured");
  });
});
