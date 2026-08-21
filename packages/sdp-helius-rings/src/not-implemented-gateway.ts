import { HeliusRingsError } from "./errors";
import type { RingsGatewayPort } from "./port";

/**
 * The production gateway until Track B lands the live HTTP adapter. Every
 * method throws `gateway_unavailable` naming its seam, so an operation that
 * reaches the port ends in `failed:gateway_unavailable` (retryable) and the UI
 * reports the integration honestly instead of simulating it.
 */

function notImplemented(method: string): never {
  throw new HeliusRingsError(
    "gateway_unavailable",
    `${method} awaiting Zolana sidecar integration`
  );
}

export class NotImplementedRingsGateway implements RingsGatewayPort {
  async probeHealth(): Promise<never> {
    return notImplemented("probeHealth");
  }

  async provisionIdentity(): Promise<never> {
    return notImplemented("provisionIdentity");
  }

  async syncPhoton(): Promise<never> {
    return notImplemented("syncPhoton");
  }

  async buildOperation(): Promise<never> {
    return notImplemented("buildOperation");
  }

  async requestProof(): Promise<never> {
    return notImplemented("requestProof");
  }

  async verifyIndexed(): Promise<never> {
    return notImplemented("verifyIndexed");
  }
}
