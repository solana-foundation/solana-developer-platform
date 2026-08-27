import type { RingsGatewayPort } from "@sdp/helius-rings";
import { SecretRef } from "@sdp/helius-rings";

/**
 * A gateway with only the methods a test needs; anything else throws rather than
 * answering with a default.
 */
export function gatewayStub(overrides: Partial<RingsGatewayPort>): RingsGatewayPort {
  const unexpected = (method: string) => async () => {
    throw new Error(`gateway.${method} was not expected in this test`);
  };
  return {
    probeHealth: unexpected("probeHealth"),
    provisionIdentity: unexpected("provisionIdentity"),
    readIdentity: unexpected("readIdentity"),
    syncPhoton: unexpected("syncPhoton"),
    buildOperation: unexpected("buildOperation"),
    requestProof: unexpected("requestProof"),
    verifyIndexed: unexpected("verifyIndexed"),
    ...overrides,
  } as RingsGatewayPort;
}

/**
 * The two port calls `runPipeline` makes before it reaches custody. The unsigned
 * transaction is a placeholder because the callers' signer stubs return real wire
 * bytes; `requiredSigners` is not, since the service demands exactly one.
 */
export function pipelineGateway(overrides: Partial<RingsGatewayPort> = {}): RingsGatewayPort {
  return gatewayStub({
    buildOperation: async ({ operation }) => ({
      outerUnsignedTxBase64: "dW5zaWduZWQ=",
      requiredSigners: [operation.walletId],
      ringsMetadata: new SecretRef({ seed: "pipeline" }),
    }),
    requestProof: async () => ({
      source: "simulated",
      ref: new SecretRef("proof"),
      createdAt: "2026-08-18T00:00:00.000Z",
    }),
    ...overrides,
  });
}
