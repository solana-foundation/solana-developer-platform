import type { OndoSwapLeg, OndoSwapPort } from "@sdp/ondo/types";
import type { Env } from "@/types/env";
import { fetchJupiterSwapLeg, fetchJupiterSwapQuote } from "./jupiter-swap.service";
import { createVaultDeadline } from "./vault-deadline";

/**
 * The API's implementation of `@sdp/ondo`'s swap seam.
 *
 * Ondo's "vault instruction" is a Jupiter-routed spot swap, and this port is
 * how the provider package builds one WITHOUT owning Jupiter's trust boundary:
 * every instruction admitted here went through `fetchJupiterSwapLeg`'s
 * reviewed contract (pinned aggregator/ATA programs, no signer but the owner,
 * encoded amounts matching the request) — the same admission the swap-funded
 * deposit path relies on, deliberately single-owner.
 *
 * Each port call runs under its own vault deadline because the port is
 * resolved per request from the provider registry's singletons, which have no
 * operation-scoped deadline to lend; the client's own `runOperation` bounds
 * the overall build around these calls.
 */
export function createOndoSwapPort(env: Env): OndoSwapPort {
  return {
    async buildSwapLeg(request): Promise<OndoSwapLeg> {
      assertMainnet(request.cluster);
      // The default account headroom fits: unlike a swap-funded vault deposit,
      // the swap here IS the whole transaction (plus a compute-budget
      // instruction and the request memo), so no tighter ceiling is needed.
      const leg = await fetchJupiterSwapLeg(env, createVaultDeadline(), {
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        sourceAmount: request.amount,
        owner: request.owner,
        slippageBps: request.slippageBps,
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

/** Jupiter routes mainnet only; a devnet request here is a wiring bug. */
function assertMainnet(cluster: string): void {
  if (cluster !== "mainnet-beta") {
    throw new Error(`Jupiter swaps are mainnet-only; refusing a ${cluster} swap request`);
  }
}
