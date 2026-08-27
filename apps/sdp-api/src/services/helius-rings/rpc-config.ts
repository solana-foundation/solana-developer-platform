import { HeliusRingsError } from "@sdp/helius-rings";
import { withHeliusApiKey } from "@sdp/rpc/relay";
import type { Env } from "@/types/env";

const API_KEY_PLACEHOLDER = "{API_KEY}";

type RingsHeliusRpcVariable = "SOLANA_RPC_HELIUS_URL" | "SOLANA_RPC_HELIUS_API_KEY";

export interface RingsHeliusRpcConfig {
  readonly rpcUrl: string | undefined;
  readonly missing: readonly RingsHeliusRpcVariable[];
}

/**
 * Resolves the one Solana endpoint Rings is allowed to use.
 *
 * A URL may carry its key already. When it carries an API-key placeholder,
 * however, leaving that placeholder unresolved is missing configuration rather
 * than a usable endpoint.
 */
export function resolveRingsHeliusRpcConfig(env: Env): RingsHeliusRpcConfig {
  const configuredUrl = env.SOLANA_RPC_HELIUS_URL;
  const rpcUrl = configuredUrl
    ? withHeliusApiKey(configuredUrl, env.SOLANA_RPC_HELIUS_API_KEY)
    : undefined;
  const missing: RingsHeliusRpcVariable[] = [];

  if (!configuredUrl) {
    missing.push("SOLANA_RPC_HELIUS_URL");
  }
  if (rpcUrl?.includes(API_KEY_PLACEHOLDER)) {
    missing.push("SOLANA_RPC_HELIUS_API_KEY");
  }

  return {
    rpcUrl: missing.length === 0 ? rpcUrl : undefined,
    missing,
  };
}

export function requireRingsHeliusRpcUrl(env: Env): string {
  const { rpcUrl, missing } = resolveRingsHeliusRpcConfig(env);
  if (!rpcUrl) {
    throw new HeliusRingsError(
      "config_error",
      `Rings Helius RPC is misconfigured: missing ${missing.join(", ")}`
    );
  }
  return rpcUrl;
}
