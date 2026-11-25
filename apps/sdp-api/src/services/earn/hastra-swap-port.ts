import { providerNotConfigured } from "@sdp/earn/errors";
import type { EarnSwapPort } from "@sdp/earn/types";
import { isEarnHastraDexExitConfigured } from "@/lib/feature-flags";
import type { Env } from "@/types/env";
import { createJupiterSwapPort } from "./jupiter-swap-port";

/**
 * API-owned Jupiter seam for Hastra's liquid PRIME exit.
 *
 * `@sdp/hastra` builds and validates the native PRIME -> wYLDS redeem. This
 * port contributes only the wYLDS -> USDC leg, through the same reviewed
 * Jupiter boundary as Ondo and swap-funded deposits (`createJupiterSwapPort`).
 * The provider package owns no Jupiter credential or wire response parsing.
 */
export function createHastraSwapPort(env: Env): EarnSwapPort {
  // Defense in depth for callers that hold the broader Hastra direct client
  // instead of resolving the runtime withdrawal capability. The execution
  // registry is the normal admission boundary, but this keeps a direct call
  // from ever reaching Jupiter while the rollout flag is off.
  if (!isEarnHastraDexExitConfigured(env)) {
    throw providerNotConfigured(
      "Hastra Jupiter exits are disabled for this deployment; use Hastra par redemption or configure EARN_HASTRA_DEX_EXIT_ENABLED=true with JUPITER_SWAP_API_KEY"
    );
  }
  return createJupiterSwapPort(env, "Hastra Jupiter exits");
}
