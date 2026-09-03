import type { EarnVaultInstruction } from "@sdp/earn/types";
import type { SolanaCluster } from "@sdp/types";

/** Chain runtime for one operation: a genesis-proven endpoint and its cluster. */
export interface OndoRuntime {
  cluster: SolanaCluster;
  rpcUrl: string;
}

/**
 * The swap seam this package builds through, injected by the API.
 *
 * Ondo's "vault instruction" is a Jupiter-routed spot swap, and the API
 * already owns a reviewed trust boundary for admitting Jupiter's
 * response-controlled instructions into a transaction a custody wallet will
 * authorize wholesale (`services/earn/jupiter-swap.service.ts`). Injecting
 * that boundary as a port keeps it single-owner — this package must never
 * re-implement instruction admission — and keeps this package free of both
 * chain SDKs and Jupiter credentials, the same way `resolveProvenRpcUrl` keeps
 * genesis proof an API concern. Unit tests stub the port; the smoke test
 * provides a live one.
 */
export interface OndoSwapPort {
  /**
   * Build an ExactIn swap as admitted, plan-vocabulary instructions.
   *
   * The implementation must guarantee what the API's swap service guarantees:
   * instructions only from the pinned aggregator/ATA programs, no signer other
   * than `owner`, the encoded amounts matching `amount`/`slippageBps`, and a
   * `minOutAmount` equal to the route's guaranteed threshold.
   */
  buildSwapLeg(request: OndoSwapBuildRequest): Promise<OndoSwapLeg>;
  /** Price an ExactIn swap without building instructions (no owner needed). */
  quoteSwap(request: OndoSwapQuoteRequest): Promise<OndoSwapQuote>;
}

export interface OndoSwapBuildRequest {
  cluster: SolanaCluster;
  inputMint: string;
  outputMint: string;
  /** ExactIn amount in the INPUT token's units, decimal string. */
  amount: string;
  /** The wallet that signs, pays, and receives. */
  owner: string;
  /** Tolerance the route encodes; the threshold it yields is the real floor. */
  slippageBps: number;
}

export interface OndoSwapLeg {
  /** Setup + swap in execution order, already in the plan's own vocabulary. */
  instructions: EarnVaultInstruction[];
  lookupTableAddresses: string[];
  /** Quoted output at the live rate, OUTPUT token units, decimal string. */
  quotedAmount: string;
  /** The guaranteed output floor the instructions encode, OUTPUT token units. */
  minOutAmount: string;
  priceImpactPct: string;
  routeLabels: string[];
}

export interface OndoSwapQuoteRequest {
  cluster: SolanaCluster;
  inputMint: string;
  outputMint: string;
  /** ExactIn amount in the INPUT token's units, decimal string. */
  amount: string;
}

export interface OndoSwapQuote {
  /** Output at the live rate, OUTPUT token units, decimal string. */
  outAmount: string;
  priceImpactPct: string;
}

/**
 * API-owned execution guard for one provider operation — the API injects its
 * absolute vault deadline without a dependency from this package back to the
 * application layer. Same shape as the Veda/Kamino runners.
 */
export type OndoVaultOperationRunner = <T>(
  label: string,
  operation: (assertActive: () => void) => Promise<T>
) => Promise<T>;
