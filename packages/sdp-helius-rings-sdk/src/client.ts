import { createZolanaClient } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import { address } from "@solana/kit";

export interface RingsClientConfig {
  /** Full Helius RPC URL, API key included. */
  readonly solanaRpcUrl: string;
  readonly indexerUrl: string;
  readonly proverUrl: string;
  /** Shielded pool tree; the SDK's default devnet tree when omitted. */
  readonly tree?: string;
  /**
   * Required for plain-http indexer and prover endpoints. In plaintext the
   * indexer response reveals which notes an identity owns and the prover
   * request carries the witness, so this is a deliberate per-environment
   * decision rather than a default.
   */
  readonly allowInsecureHttp?: boolean;
}

/**
 * The only way this package constructs a client. `createZolanaClient` also
 * loads the Poseidon hasher, which `new ZolanaClient` does not, and every
 * balance and proof path needs it.
 */
export function createRingsClient(config: RingsClientConfig): Promise<ZolanaClient> {
  return createZolanaClient({
    solanaRpcUrl: config.solanaRpcUrl,
    indexerUrl: config.indexerUrl,
    proverUrl: config.proverUrl,
    tree: config.tree === undefined ? undefined : address(config.tree),
    allowInsecureHttp: config.allowInsecureHttp ?? false,
  });
}
