import { providerNotConfigured } from "@sdp/earn/errors";
import type { HastraSwapLeg, HastraSwapPort } from "@sdp/hastra/types";
import { isEarnHastraDexExitConfigured } from "@/lib/feature-flags";
import type { Env } from "@/types/env";
import { fetchJupiterSwapLeg, fetchJupiterSwapQuote } from "./jupiter-swap.service";
import { createVaultDeadline } from "./vault-deadline";

/**
 * API-owned Jupiter seam for Hastra's liquid PRIME exit.
 *
 * `@sdp/hastra` builds and validates the native PRIME -> wYLDS redeem. This
 * adapter contributes only the wYLDS -> USDC leg, preserving the single
 * reviewed Jupiter instruction boundary already used by swap-funded deposits
 * and Ondo: pinned programs, exact owner/mints/amount, bounded slippage, and no
 * foreign signer. The provider package owns no Jupiter credential or wire
 * response parsing.
 */
export function createHastraSwapPort(env: Env): HastraSwapPort {
  // Defense in depth for callers that hold the broader Hastra direct client
  // instead of resolving the runtime withdrawal capability. The execution
  // registry is the normal admission boundary, but this keeps a direct call
  // from ever reaching Jupiter while the rollout flag is off.
  if (!isEarnHastraDexExitConfigured(env)) {
    throw providerNotConfigured(
      "Hastra Jupiter exits are disabled for this deployment; use Hastra par redemption or configure EARN_HASTRA_DEX_EXIT_ENABLED=true with JUPITER_SWAP_API_KEY"
    );
  }

  return {
    async buildSwapLeg(request): Promise<HastraSwapLeg> {
      assertMainnet(request.cluster);
      const leg = await fetchJupiterSwapLeg(env, createVaultDeadline(), {
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        sourceAmount: request.amount,
        owner: request.owner,
        payer: request.payer,
        slippageBps: request.slippageBps,
        maxAccounts: request.maxAccounts,
      });
      return {
        instructions: leg.instructions,
        lookupTableAddresses: leg.lookupTableAddresses,
        quotedAmount: leg.quotedAmount,
        minOutAmount: leg.minOutAmount,
        priceImpactPct: leg.priceImpactPct,
        routeLabels: leg.routeLabels,
      };
    },
    async quoteSwap(request) {
      assertMainnet(request.cluster);
      const quote = await fetchJupiterSwapQuote(env, createVaultDeadline(), {
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        sourceAmount: request.amount,
      });
      return { outAmount: quote.outAmount, priceImpactPct: quote.priceImpactPct };
    },
  };
}

/** Jupiter and the verified Hastra deployment are mainnet-only. */
function assertMainnet(cluster: string): void {
  if (cluster !== "mainnet-beta") {
    throw new Error(`Hastra Jupiter exits are mainnet-only; refusing a ${cluster} swap request`);
  }
}
