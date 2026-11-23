import type { EarnSwapLeg, EarnSwapPort } from "@sdp/earn/types";
import type { Env } from "@/types/env";
import { fetchJupiterSwapLeg, fetchJupiterSwapQuote } from "./jupiter-swap.service";
import { createVaultDeadline } from "./vault-deadline";

/**
 * The API's implementation of the execution packages' `EarnSwapPort`.
 *
 * Ondo's "vault instruction" is a Jupiter-routed spot swap and Hastra's liquid
 * exit ends in one; this port is how those packages build them WITHOUT owning
 * Jupiter's trust boundary. Every instruction admitted here went through
 * `fetchJupiterSwapLeg`'s reviewed contract (pinned aggregator/ATA programs, no
 * signer but the owner and an explicitly requested payer, encoded amounts
 * matching the request), the same admission swap-funded deposits rely on.
 *
 * Each port call runs under its own vault deadline because the port is
 * resolved per request from the provider registry's singletons, which have no
 * operation-scoped deadline to lend; the client's own `runOperation` bounds
 * the overall build around these calls.
 *
 * @param env - The API environment carrying the Jupiter credential.
 * @param subject - What a refused devnet request names, e.g. "Jupiter swaps".
 */
export function createJupiterSwapPort(env: Env, subject: string): EarnSwapPort {
  /** Jupiter routes mainnet only; a devnet request here is a wiring bug. */
  const assertMainnet = (cluster: string) => {
    if (cluster !== "mainnet-beta") {
      throw new Error(`${subject} are mainnet-only; refusing a ${cluster} swap request`);
    }
  };
  return {
    async buildSwapLeg(request): Promise<EarnSwapLeg> {
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
