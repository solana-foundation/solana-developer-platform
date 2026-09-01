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
 * Read off the seam rather than imported: `gateway.ts` is the only file in this
 * app allowed to reach `@sdp/helius-rings-sdk`.
 */
type CapturedConfig = Parameters<NonNullable<ResolveRingsGatewayDependencies["createGateway"]>>[0];

const tenant = { organizationId: "org_1", projectId: "prj_1" };

/** A fully configured deployment. Nothing here is ever dialled. */
const CONFIGURED = {
  HELIUS_RINGS_RPC_URL: "https://rpc.invalid/?api-key=key",
  HELIUS_RINGS_INDEXER_URL: "https://indexer.invalid",
  HELIUS_RINGS_PROVER_URL: "https://prover.invalid",
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
  ["syncPhoton", (g) => g.syncPhoton({ walletId: "hrw_1", owner: "owner" })],
  ["buildOperation", (g) => g.buildOperation({ operation: {} as never, owner: "owner" })],
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
        // Fixed at construction: a per-call tenant could derive key material
        // under another organization's path.
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
      });
    });

    // Read as an explicit flag rather than inferred from the URL scheme, so a
    // production typo cannot quietly authorise plaintext.
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

    // The SDK's error bridge only recognises Zolana's error classes, so an
    // untranslated adapter failure reaches the route as a 500.
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

    // RPC errors quote the endpoint they failed on, and it carries a Helius API
    // key.
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
    ] as const satisfies ReadonlyArray<keyof Env>;

    it.each(requiredKeys)("names %s when it is absent", async (key) => {
      const env = envOf({ [key]: undefined });
      const gateway = resolveRingsGateway(env, tenant);

      expect(gateway).toBeInstanceOf(UnconfiguredRingsGateway);
      const health = await gateway.probeHealth();
      expect(health.detail?.rpc).toContain(key);
      expect(ringsUpstreamsConfigured(env)).toBe(false);
    });

    // A `KEY=` line is an unfilled variable, not a chosen empty URL.
    it("treats a blank value as absent", async () => {
      const env = envOf({ HELIUS_RINGS_PROVER_URL: "   " });
      const gateway = resolveRingsGateway(env, tenant);

      expect(gateway).toBeInstanceOf(UnconfiguredRingsGateway);
      expect((await gateway.probeHealth()).detail?.rpc).toContain("HELIUS_RINGS_PROVER_URL");
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

    expect(health).toMatchObject({ rpc: "red", photon: "red", prover: "red" });
    for (const component of ["rpc", "photon", "prover"] as const) {
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
    // cannot succeed.
    expect(error).toMatchObject({ code: "config_error" });
    expect((error as Error).message).toContain("HELIUS_RINGS_INDEXER_URL");
  });

  it("reads as singular when only one variable is missing", async () => {
    const health = await new UnconfiguredRingsGateway(["HELIUS_RINGS_RPC_URL"]).probeHealth();

    expect(health.detail?.rpc).toContain("HELIUS_RINGS_RPC_URL is not configured");
  });
});
