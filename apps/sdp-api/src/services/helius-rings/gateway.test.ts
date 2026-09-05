import type { RingsGatewayPort } from "@sdp/helius-rings";
import { HeliusRingsError } from "@sdp/helius-rings";
import { describe, expect, it } from "vitest";
import { gatewayStub } from "@/test/fixtures/rings-gateway";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";
import type { ResolvedRingsConnection } from "./connection-resolver";
import {
  createConfiguredRingsGateway,
  type ResolveRingsGatewayDependencies,
  UnconfiguredRingsGateway,
} from "./gateway";

type CapturedConfig = Parameters<NonNullable<ResolveRingsGatewayDependencies["createGateway"]>>[0];

const env = {} as Env;
const tenant = { organizationId: "org_1", projectId: "prj_1" };
const connection: ResolvedRingsConnection = {
  id: "hrconn_1",
  name: "Shared devnet",
  solanaRpcUrl: "https://rpc.invalid/?api-key=key",
  indexerUrl: "https://indexer.invalid",
  proverUrl: "https://prover.invalid",
  allowInsecureHttp: false,
};

function capturingCreate() {
  const captured: CapturedConfig[] = [];
  const createGateway = (config: CapturedConfig): RingsGatewayPort => {
    captured.push(config);
    return gatewayStub({});
  };
  return { captured, createGateway };
}

function create(
  dependencies: ResolveRingsGatewayDependencies = {},
  overrides: Partial<ResolvedRingsConnection> = {}
) {
  return createConfiguredRingsGateway(env, tenant, { ...connection, ...overrides }, dependencies);
}

const allMethods: Array<[string, (gateway: RingsGatewayPort) => Promise<unknown>]> = [
  [
    "provisionIdentity",
    (gateway) => gateway.provisionIdentity({ walletId: "hrw_1", sdpAddress: "owner" }),
  ],
  ["provisionRing", (gateway) => gateway.provisionRing({ ringProgramId: "ring" })],
  ["readIdentity", (gateway) => gateway.readIdentity({ walletId: "hrw_1", owner: "owner" })],
  ["syncPhoton", (gateway) => gateway.syncPhoton({ walletId: "hrw_1", owner: "owner" })],
  [
    "buildOperation",
    (gateway) => gateway.buildOperation({ operation: {} as never, owner: "owner" }),
  ],
  ["verifyIndexed", (gateway) => gateway.verifyIndexed("sig")],
];

describe("createConfiguredRingsGateway", () => {
  it("builds the SDK gateway from the persisted connection", () => {
    const { captured, createGateway } = capturingCreate();
    create({ createGateway });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      solanaRpcUrl: connection.solanaRpcUrl,
      indexerUrl: connection.indexerUrl,
      proverUrl: connection.proverUrl,
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      allowInsecureHttp: false,
    });
  });

  it("forwards the optional Ring RPC", () => {
    const { captured, createGateway } = capturingCreate();
    create(
      { createGateway },
      { ringRpcUrl: "https://d1ojzfopdqqs5r.cloudfront.net", allowInsecureHttp: true }
    );

    expect(captured[0]).toMatchObject({
      ringRpcUrl: "https://d1ojzfopdqqs5r.cloudfront.net",
      allowInsecureHttp: true,
    });
  });

  it.each([
    ["submit_failed", true, "gateway_unavailable"],
    ["signer_failed", false, "invalid_input"],
    ["signer_failed", true, "gateway_unavailable"],
  ] as const)(
    "reports a %s adapter failure with retryable=%o as %s",
    async (failureCode, retryable, expected) => {
      const { captured, createGateway } = capturingCreate();
      const boom = new RingsAdapterError(failureCode, "boom", { retryable });
      create({
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

  it("does not expose an upstream URL from an adapter error", async () => {
    const { captured, createGateway } = capturingCreate();
    create({
      createGateway,
      submitOuterTransaction: async () => {
        throw new RingsAdapterError("submit_failed", `failed calling ${connection.solanaRpcUrl}`, {
          retryable: true,
        });
      },
    });

    const config = captured[0];
    if (!config) throw new Error("no gateway config was captured");
    await expect(config.submitTransaction("signed")).rejects.toThrow(/devnet SOL/);
    await expect(config.submitTransaction("signed")).rejects.not.toThrow(/api-key/);
  });

  it("leaves non-adapter failures unchanged", async () => {
    const { captured, createGateway } = capturingCreate();
    create({
      createGateway,
      submitOuterTransaction: async () => {
        throw new TypeError("something else entirely");
      },
    });

    const config = captured[0];
    if (!config) throw new Error("no gateway config was captured");
    await expect(config.submitTransaction("signed")).rejects.toBeInstanceOf(TypeError);
  });

  it("refuses ring bring-up when the persisted connection has no Ring RPC", async () => {
    const gateway = create({ createGateway: capturingCreate().createGateway });

    await expect(gateway.provisionRing({ ringProgramId: "ring" })).rejects.toMatchObject({
      code: "config_error",
      message: "ring bring-up needs a Ring RPC URL in the project's Helius Rings configuration",
    });
  });

  it("binds signing and submission to the tenant and persisted RPC", async () => {
    const { captured, createGateway } = capturingCreate();
    const signCalls: unknown[] = [];
    const submitCalls: unknown[] = [];
    create({
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
    expect(submitCalls[0]).toMatchObject({
      signedTxBase64: "signed",
      rpcUrl: connection.solanaRpcUrl,
    });
  });

  it("binds message signing to the tenant and owner", async () => {
    const { captured, createGateway } = capturingCreate();
    const calls: unknown[] = [];
    create({
      createGateway,
      signMessage: async (input) => {
        calls.push(input);
        return "message-signature";
      },
    });

    const config = captured[0];
    if (!config) throw new Error("no gateway config was captured");
    await expect(config.signMessage?.("attestation", "OwnerPublicKey")).resolves.toBe(
      "message-signature"
    );
    expect(calls[0]).toMatchObject({
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      owner: "OwnerPublicKey",
      messageBase64: "attestation",
    });
  });
});

describe("UnconfiguredRingsGateway", () => {
  const gateway = new UnconfiguredRingsGateway();

  it("reports every component red with the setup requirement", async () => {
    const health = await gateway.probeHealth();
    expect(health).toMatchObject({ rpc: "red", photon: "red", prover: "red" });
    for (const component of ["rpc", "photon", "prover"] as const) {
      expect(health.detail?.[component]).toBe("Helius Rings setup is required for this project");
    }
  });

  it.each(allMethods)("fails %s closed with config_error", async (_method, call) => {
    const error = await call(gateway).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HeliusRingsError);
    expect(error).toMatchObject({
      code: "config_error",
      message: "Helius Rings setup is required for this project",
    });
  });
});
