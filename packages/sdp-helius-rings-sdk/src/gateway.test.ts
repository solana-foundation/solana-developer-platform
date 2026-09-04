import { HeliusRingsError } from "@sdp/helius-rings";
import { describe, expect, it } from "vitest";
import { createRingsGateway, type RingsGatewayConfig } from "./gateway.js";

const CONFIG: RingsGatewayConfig = {
  solanaRpcUrl: "http://127.0.0.1:1/rpc",
  indexerUrl: "http://127.0.0.1:1",
  proverUrl: "http://127.0.0.1:1",
  organizationId: "org_1",
  projectId: "proj_1",
  signTransaction: async (unsigned) => unsigned,
  submitTransaction: async () => "sig",
  allowInsecureHttp: true,
  healthTimeoutMs: 50,
};

const SYNC_INPUT = { walletId: "hrw_1", owner: "addr" };
const RING_PROGRAM = "Stake11111111111111111111111111111111111111";

describe("createRingsGateway", () => {
  it("reports health instead of throwing when every upstream is unreachable", async () => {
    const health = await createRingsGateway(CONFIG).probeHealth();

    expect(health.rpc).toBe("red");
    expect(health.photon).toBe("red");
    expect(health.prover).toBe("red");
  });

  it("refuses non-loopback plain http unless it is explicitly allowed", async () => {
    const health = await createRingsGateway({
      ...CONFIG,
      indexerUrl: "http://indexer.example",
      proverUrl: "http://prover.example",
      allowInsecureHttp: false,
    }).probeHealth();

    // Client-init failure surfaces on each component tile so the reason
    // reaches the operator whichever they look at.
    expect(health.rpc).toBe("red");
    expect(health.detail?.rpc).toContain("CLIENT_INVALID_CONFIG");
  });

  it("classifies an invalid configured tree without exposing its value", async () => {
    const configuredTree = "not-a-solana-address";
    const error = await createRingsGateway({ ...CONFIG, tree: configuredTree })
      .syncPhoton(SYNC_INPUT)
      .then(
        () => null,
        (thrown: unknown) => thrown
      );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect(error).toMatchObject({
      code: "config_error",
      message: "the Rings gateway configuration is invalid",
    });
    expect((error as Error).message).not.toContain(configuredTree);
  });

  it("refuses ring bring-up when the ring RPC is not configured", async () => {
    const error = await createRingsGateway(CONFIG)
      .provisionRing({ ringProgramId: RING_PROGRAM })
      .then(
        () => null,
        (thrown: unknown) => thrown
      );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect(error).toMatchObject({
      code: "config_error",
      message: "ring bring-up needs a ring RPC URL",
    });
  });

  it("refuses ring bring-up when the message signer is not configured", async () => {
    const error = await createRingsGateway({ ...CONFIG, ringRpcUrl: "https://ring-rpc.example" })
      .provisionRing({ ringProgramId: RING_PROGRAM })
      .then(
        () => null,
        (thrown: unknown) => thrown
      );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect(error).toMatchObject({
      code: "config_error",
      message: "ring bring-up needs a custody message signer",
    });
  });

  it("refuses a plain-http ring RPC unless insecure http is explicitly allowed", async () => {
    const error = await createRingsGateway({
      ...CONFIG,
      ringRpcUrl: "http://ring-rpc.example",
      signMessage: async () => "sig",
      allowInsecureHttp: false,
    })
      .provisionRing({ ringProgramId: RING_PROGRAM })
      .then(
        () => null,
        (thrown: unknown) => thrown
      );

    // In plaintext the auditor-key response could be swapped in transit.
    expect(error).toBeInstanceOf(HeliusRingsError);
    expect(error).toMatchObject({ code: "config_error" });
    expect((error as Error).message).toContain("https");
  });

  it("classifies an unparseable ring RPC URL without exposing its value", async () => {
    const ringRpcUrl = "not-a-valid-url";
    const error = await createRingsGateway({
      ...CONFIG,
      ringRpcUrl,
      signMessage: async () => "sig",
    })
      .provisionRing({ ringProgramId: RING_PROGRAM })
      .then(
        () => null,
        (thrown: unknown) => thrown
      );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect(error).toMatchObject({
      code: "config_error",
      message: "the configured ring RPC URL is not a valid URL",
    });
    expect((error as Error).message).not.toContain(ringRpcUrl);
  });

  it("refuses unsupported operation types at build time", async () => {
    const error = await createRingsGateway(CONFIG)
      .buildOperation({
        operation: { opType: "merge", walletId: "hrw_1", input: {} } as never,
        owner: "11111111111111111111111111111111",
      })
      .then(
        () => null,
        (thrown: unknown) => thrown
      );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect((error as HeliusRingsError).code).toBe("invalid_input");
  });

  it("never answers not-indexed instead of refusing", async () => {
    await expect(createRingsGateway(CONFIG).verifyIndexed("sig")).rejects.toBeInstanceOf(
      HeliusRingsError
    );
  });

  const WITH_KEY = "http://127.0.0.1:1/?api-key=super-secret-key";

  it("never leaks the RPC URL into a health response", async () => {
    const health = await createRingsGateway({ ...CONFIG, solanaRpcUrl: WITH_KEY }).probeHealth();

    expect(JSON.stringify(health)).not.toContain("super-secret-key");
  });

  it("names the reason a client could not be built, without the key", async () => {
    const health = await createRingsGateway({
      ...CONFIG,
      solanaRpcUrl: WITH_KEY,
      indexerUrl: "http://indexer.example",
      allowInsecureHttp: false,
    }).probeHealth();

    expect(health.detail?.rpc).toMatch(/^client unavailable: .+/);
    expect(health.detail?.rpc).not.toBe("client unavailable: unknown error");
    expect(JSON.stringify(health)).not.toContain("super-secret-key");
  });
});
