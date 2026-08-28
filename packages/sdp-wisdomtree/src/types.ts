import type { SolanaCluster } from "@sdp/types";
import type { Address, Instruction } from "@solana/kit";

/**
 * Boundary contract for `@sdp/wisdomtree`. Same two rules as `@sdp/kamino`'s
 * types module: money is a decimal string, and nothing here references any
 * type outside `@solana/kit` (the repo's pinned version) and `@sdp/types`.
 */

/** Which cluster a call runs against, and how to reach it. Caller-supplied —
 * never read from process env — for the same reason as `KaminoRuntime`. */
export interface WisdomTreeRuntime {
  cluster: SolanaCluster;
  rpcUrl: string;
}

/** A built, unsigned unit of work: one complete transaction's instructions. */
export interface WisdomTreeInstructionPlan {
  cluster: SolanaCluster;
  instructions: readonly Instruction[];
  /** WisdomTree publishes no lookup tables; always empty, kept for the shared wire shape. */
  lookupTables: readonly Address[];
  assetIdentity: {
    /** The stablecoin leg's mint (USDC). */
    depositTokenMint: Address;
    /** The fund's Token-2022 mint — the instrument AND the receipt token. */
    shareMint: Address;
  };
  accepted: {
    /** Canonical deposit amount the instructions encode (deposits only). */
    amount?: string;
    /** Canonical fund-token quantity the instructions encode (redemptions only). */
    shares?: string;
  };
  /** True when this plan creates the owner's fund-token ATA, charging rent to the rent payer. */
  createsShareAccount?: boolean;
}
