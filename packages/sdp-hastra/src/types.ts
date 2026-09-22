import type { EarnVaultInstruction } from "@sdp/earn/types";
import type { SolanaCluster } from "@sdp/types";

/** Chain runtime for one operation: a genesis-proven endpoint and its cluster. */
export interface HastraRuntime {
  cluster: SolanaCluster;
  rpcUrl: string;
}

/**
 * Jupiter instruction admission remains owned by the API. This package asks
 * that boundary for an ExactIn wYLDS -> USDC leg and never trusts arbitrary
 * wire instructions directly.
 */
export interface HastraSwapPort {
  buildSwapLeg(request: HastraSwapBuildRequest): Promise<HastraSwapLeg>;
  quoteSwap(request: HastraSwapQuoteRequest): Promise<HastraSwapQuote>;
}

export interface HastraSwapBuildRequest {
  cluster: SolanaCluster;
  inputMint: string;
  outputMint: string;
  /** ExactIn amount in the input token's units. */
  amount: string;
  /** Token owner and required signer. */
  owner: string;
  /** Optional distinct payer for setup accounts emitted by Jupiter. */
  payer?: string;
  slippageBps: number;
  /** Bound route account fan-out so the composed Hastra transaction still fits. */
  maxAccounts?: number;
}

export interface HastraSwapLeg {
  instructions: EarnVaultInstruction[];
  lookupTableAddresses: string[];
  quotedAmount: string;
  minOutAmount: string;
  priceImpactPct: string;
  routeLabels: string[];
}

export interface HastraSwapQuoteRequest {
  cluster: SolanaCluster;
  inputMint: string;
  outputMint: string;
  /** ExactIn amount in the input token's units. */
  amount: string;
}

export interface HastraSwapQuote {
  outAmount: string;
  priceImpactPct: string;
}

/** API-owned deadline boundary, shared in shape with the other vault clients. */
export type HastraVaultOperationRunner = <T>(
  label: string,
  operation: (assertActive: () => void) => Promise<T>
) => Promise<T>;
