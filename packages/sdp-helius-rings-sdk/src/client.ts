import { createZolanaClient } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import { address } from "@solana/kit";
import { withConfiguredAddressErrorBridge } from "./error-bridge.js";

export interface RingsClientConfig {
  /** Full Helius RPC URL, API key included. */
  readonly solanaRpcUrl: string;
  readonly indexerUrl: string;
  readonly proverUrl: string;
  /** Shielded pool tree; the SDK's default devnet tree when omitted. */
  readonly tree?: string;
  /**
   * Required for plain-http indexer and prover endpoints. In plaintext the
   * indexer response reveals which notes an identity owns.
   */
  readonly allowInsecureHttp?: boolean;
  /**
   * Carries the indexer and prover legs; the Solana RPC leg is guarded through
   * {@link solanaRpcTransportConfig} instead, which zolana forwards to
   * `createSolanaRpc` as its transport config.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Transport config for the client's own Solana RPC leg, forwarded to
   * `createSolanaRpc` verbatim. On Node this carries a
   * `dispatcher_NODE_ONLY`, which is how the egress guard reaches the one
   * transport this package cannot hand a `fetch` to.
   */
  readonly solanaRpcTransportConfig?: Record<string, unknown>;
}

/**
 * The only way this package constructs a client: `createZolanaClient` also loads
 * the Poseidon hasher, which `new ZolanaClient` does not.
 */
export function createRingsClient(config: RingsClientConfig): Promise<ZolanaClient> {
  const { tree } = config;
  return createZolanaClient({
    solanaRpcUrl: config.solanaRpcUrl,
    indexerUrl: config.indexerUrl,
    proverUrl: config.proverUrl,
    tree: tree === undefined ? undefined : withConfiguredAddressErrorBridge(() => address(tree)),
    allowInsecureHttp: config.allowInsecureHttp ?? false,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    ...(config.solanaRpcTransportConfig === undefined
      ? {}
      : { solanaRpcTransportConfig: config.solanaRpcTransportConfig }),
  });
}
