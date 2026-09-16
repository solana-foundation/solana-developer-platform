import type { SdpEnvironment } from "@sdp/types";
import { internalError } from "@/lib/errors";
import type { Env } from "@/types/env";

function assertNeverEnvironment(environment: never): never {
  throw internalError(`Unsupported deployment environment: ${String(environment)}`);
}

/**
 * Maps the validated deployment runtime to the product environment used only
 * by anonymous Earn catalogue, quote, and transaction-build requests.
 */
export function resolveAnonymousEarnEnvironment(environment: Env["ENVIRONMENT"]): SdpEnvironment {
  switch (environment) {
    case "development":
      return "sandbox";
    case "production":
      return "production";
    default:
      return assertNeverEnvironment(environment);
  }
}
