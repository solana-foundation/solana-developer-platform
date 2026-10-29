import { createZolanaClient } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import { address } from "@solana/kit";
import { withConfiguredAddressErrorBridge } from "./error-bridge.js";

/** The client's Solana RPC leg, as the vendored client exposes it. */
export type RingsSolanaRpc = ZolanaClient["solanaRpc"];

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
   * Carries the indexer and prover legs; the client's own Solana RPC leg is
   * overridden through {@link RingsClientConfig.solanaRpc} instead, because the
   * client builds that transport internally and cannot take a fetch.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Replaces the client's Solana RPC, the one leg its `fetch` config cannot
   * carry (checked at 0.1.6-alpha: the library builds that transport
   * internally with no seam for one). A caller dials a tenant-supplied
   * `solanaRpcUrl` through its egress guard by handing in a client built on a
   * guarded transport.
   */
  readonly solanaRpc?: RingsSolanaRpc;
}

/**
 * The only way this package constructs a client: `createZolanaClient` also loads
 * the Poseidon hasher, which `new ZolanaClient` does not.
 */
export async function createRingsClient(config: RingsClientConfig): Promise<ZolanaClient> {
  const { tree } = config;
  const client = await createZolanaClient({
    solanaRpcUrl: config.solanaRpcUrl,
    indexerUrl: config.indexerUrl,
    proverUrl: config.proverUrl,
    tree: tree === undefined ? undefined : withConfiguredAddressErrorBridge(() => address(tree)),
    allowInsecureHttp: config.allowInsecureHttp ?? false,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  });
  if (config.solanaRpc !== undefined) {
    // The vendored field is readonly-typed and a plain property at runtime, so
    // the override fits through a narrow cast. Drop it when zolana grows a
    // transport seam for its Solana RPC leg.
    (client as { solanaRpc: RingsSolanaRpc }).solanaRpc = config.solanaRpc;
  }
  return client;
}
