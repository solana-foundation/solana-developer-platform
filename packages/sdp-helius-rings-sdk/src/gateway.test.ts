import { HeliusRingsError, type RingsGatewayPort } from "@sdp/helius-rings";
import { describe, expect, it } from "vitest";
import { createRingsGateway, type RingsGatewayConfig } from "./gateway.js";

/**
 * Unreachable on purpose: these tests assert that the gateway fails closed and
 * that a dead upstream becomes a red status rather than a thrown error, so
 * nothing leaves the host.
 */
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

const SYNC_INPUT = { walletId: "hrw_1", owner: "addr", cursor: null };

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
      // The public devnet endpoints are plain http on a real host, which is the
      // case the flag exists for. Loopback http is always permitted.
      indexerUrl: "http://indexer.example",
      proverUrl: "http://prover.example",
      allowInsecureHttp: false,
    }).probeHealth();

    // The client cannot be built at all, so the gateway itself is the failure,
    // and the SDK's own code names which of the two URLs it objected to.
    expect(health.gateway).toBe("red");
    expect(health.detail?.gateway).toContain("CLIENT_INVALID_CONFIG");
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

  // Refused rather than stubbed, so a spend cannot be mistaken for a deposit.
  const unimplementedFlows: Array<[string, (gateway: RingsGatewayPort) => Promise<unknown>]> = [
    [
      "buildOperation for a spend",
      (g) => g.buildOperation({ operation: { opType: "withdraw" } as never, keyRefs: [] }),
    ],
    [
      "requestProof for a spend",
      (g) => g.requestProof({ operationId: "hro_1", ringsMetadata: {} as never }),
    ],
  ];

  it.each(unimplementedFlows)("%s refuses to run at all", async (_method, call) => {
    const error = await call(createRingsGateway(CONFIG)).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect((error as HeliusRingsError).code).toBe("gateway_unavailable");
    expect((error as HeliusRingsError).message).toContain("money flows are not implemented");
  });

  // Null is how the port says "Photon has not indexed it yet", so a build that
  // cannot verify has to throw rather than leave an operation waiting forever.
  it("never answers not-indexed instead of refusing", async () => {
    await expect(createRingsGateway(CONFIG).verifyIndexed("sig")).rejects.toBeInstanceOf(
      HeliusRingsError
    );
  });

  // Loopback rather than the real Helius host: this asserts the gateway's own
  // redaction, not a third party's uptime.
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

    expect(health.detail?.gateway).toMatch(/^client unavailable: .+/);
    // "client unavailable" alone left operators with nothing to look at, so the
    // cause has to survive the redaction.
    expect(health.detail?.gateway).not.toBe("client unavailable: unknown error");
    expect(JSON.stringify(health)).not.toContain("super-secret-key");
  });
});
