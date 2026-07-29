import { AlphaLedgerService } from "@sdp/issuance/alphaledger/service";
import { requireEnv } from "@sdp/payments/ramps/shared";
import type { SdpEnvironment } from "@sdp/types";

/**
 * Create an AlphaLedgerService for the given SDP environment.
 *
 * Domain logic lives in `@sdp/issuance`; this module resolves the API key
 * from the app's environment bindings.
 *
 * @param env - Environment bindings holding ALPHALEDGER_API_KEY
 * @param environment - SDP environment; sandbox targets AlphaLedger QA, production targets beta
 * @returns Service authenticated against the matching AlphaLedger tenant
 */
export function createAlphaLedgerService(
  env: Record<string, string | undefined>,
  environment: SdpEnvironment
): AlphaLedgerService {
  return new AlphaLedgerService(requireEnv(env, "ALPHALEDGER_API_KEY"), environment);
}
