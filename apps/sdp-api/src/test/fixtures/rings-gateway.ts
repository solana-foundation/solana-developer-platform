import type { RingsGatewayPort } from "@sdp/helius-rings";

/** Every method throws unless overridden, so a test names what it expects. */
export function gatewayStub(overrides: Partial<RingsGatewayPort>): RingsGatewayPort {
  const unexpected = (method: string) => async () => {
    throw new Error(`gateway.${method} was not expected in this test`);
  };
  return {
    probeHealth: unexpected("probeHealth"),
    provisionIdentity: unexpected("provisionIdentity"),
    provisionRing: unexpected("provisionRing"),
    readIdentity: unexpected("readIdentity"),
    rekeyIdentity: unexpected("rekeyIdentity"),
    syncPhoton: unexpected("syncPhoton"),
    buildOperation: unexpected("buildOperation"),
    verifyIndexed: unexpected("verifyIndexed"),
    ...overrides,
  } as RingsGatewayPort;
}
