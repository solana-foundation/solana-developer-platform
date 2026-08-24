import { describe, expect, it } from "vitest";
import { HeliusRingsError } from "./errors";
import { NotImplementedRingsGateway } from "./not-implemented-gateway";
import type { RingsGatewayPort } from "./port";

describe("NotImplementedRingsGateway", () => {
  const gateway: RingsGatewayPort = new NotImplementedRingsGateway();

  const calls: Array<[string, () => Promise<unknown>]> = [
    ["probeHealth", () => gateway.probeHealth()],
    [
      "provisionIdentity",
      () => gateway.provisionIdentity({ walletId: "hrw_1", sdpAddress: "addr" }),
    ],
    ["syncPhoton", () => gateway.syncPhoton({ walletId: "hrw_1", cursor: null })],
    ["buildOperation", () => gateway.buildOperation({ operation: {} as never, keyRefs: [] })],
    [
      "requestProof",
      () => gateway.requestProof({ operationId: "hro_1", ringsMetadata: {} as never }),
    ],
    ["verifyIndexed", () => gateway.verifyIndexed("sig")],
  ];

  it.each(calls)("%s throws gateway_unavailable naming the seam", async (method, call) => {
    const error = await call().then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect((error as HeliusRingsError).code).toBe("gateway_unavailable");
    expect((error as HeliusRingsError).message).toContain(method);
  });
});
