import { HeliusRingsError, type RingsGatewayPort } from "@sdp/helius-rings";
import { describe, expect, it } from "vitest";
import { createRingsGateway, type RingsGatewayConfig } from "./gateway.js";

/**
 * Unreachable on purpose. These tests assert the gateway's own behaviour — that
 * it fails closed, and that a dead upstream becomes a red status rather than a
 * thrown error — so no probe is expected to succeed.
 */
const CONFIG: RingsGatewayConfig = {
  solanaRpcUrl: "http://127.0.0.1:1/rpc",
  indexerUrl: "http://127.0.0.1:1",
  proverUrl: "http://127.0.0.1:1",
  allowInsecureHttp: true,
  healthTimeoutMs: 50,
};

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
      // case the flag exists for. Loopback http is always permitted, so the
      // other tests here need no flag to build a client.
      indexerUrl: "http://indexer.example",
      proverUrl: "http://prover.example",
      allowInsecureHttp: false,
    }).probeHealth();

    // The client cannot be built at all, so the gateway itself is the failure,
    // and the SDK's own code for it is what tells the operator which of the two
    // URLs it objected to.
    expect(health.gateway).toBe("red");
    expect(health.detail?.gateway).toContain("CLIENT_INVALID_CONFIG");
  });

  const unwired: Array<[string, (gateway: RingsGatewayPort) => Promise<unknown>]> = [
    ["provisionIdentity", (g) => g.provisionIdentity({ walletId: "hrw_1", sdpAddress: "addr" })],
    ["syncPhoton", (g) => g.syncPhoton({ walletId: "hrw_1" })],
    ["buildOperation", (g) => g.buildOperation({ operation: {} as never })],
    ["requestProof", (g) => g.requestProof({ operationId: "hro_1", ringsMetadata: {} as never })],
    ["verifyIndexed", (g) => g.verifyIndexed("sig")],
  ];

  it.each(unwired)("%s fails closed with gateway_unavailable", async (method, call) => {
    const error = await call(createRingsGateway(CONFIG)).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect((error as HeliusRingsError).code).toBe("gateway_unavailable");
    expect((error as HeliusRingsError).message).toContain(method);
  });

  // Loopback rather than the real Helius host: this asserts the gateway's own
  // redaction, and reaching a third party over the network to do it would make
  // a unit test depend on someone else's uptime.
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
    // "client unavailable" on its own sent operators looking with nothing to
    // look at, so the cause has to survive the redaction.
    expect(health.detail?.gateway).not.toBe("client unavailable: unknown error");
    expect(JSON.stringify(health)).not.toContain("super-secret-key");
  });
});
