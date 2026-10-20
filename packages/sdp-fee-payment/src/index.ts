/**
 * Fee Payment Adapters Registry
 *
 * Builds the Kora adapter for the open cluster scope. Kora is the only Fee Payer.
 */

import { KORA_UPSTREAM_RPC_ENV_KEYS } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import { KoraAdapter, type KoraAdapterConfig } from "./kora.adapter";
import { type FeePaymentEnv, FeePaymentError } from "./port";

/** One Kora service: where it is and how the adapter authenticates to it. */
export interface KoraEndpoint {
  rpcUrl: string;
  apiKey?: string;
  identityTokenAudience?: string;
}

/** Each cluster's Kora env keys: the service the API calls and the Solana RPC that Kora reads. */
export const KORA_ENV_KEYS = {
  devnet: {
    serviceUrl: "KORA_DEVNET_URL",
    upstreamRpcUrl: KORA_UPSTREAM_RPC_ENV_KEYS.devnet,
    apiKey: "KORA_DEVNET_API_KEY",
    identityTokenAudience: "KORA_DEVNET_CLOUD_RUN_AUDIENCE",
  },
  "mainnet-beta": {
    serviceUrl: "KORA_MAINNET_URL",
    upstreamRpcUrl: KORA_UPSTREAM_RPC_ENV_KEYS["mainnet-beta"],
    apiKey: "KORA_MAINNET_API_KEY",
    identityTokenAudience: "KORA_MAINNET_CLOUD_RUN_AUDIENCE",
  },
} as const satisfies Record<SolanaCluster, Record<string, keyof FeePaymentEnv>>;

/**
 * Boot check: each cluster's Kora is configured whole or not at all. The sponsor signs through
 * `KORA_<CLUSTER>_URL` and the budget prices and settles through `KORA_<CLUSTER>_RPC_URL`, so one
 * without the other refuses to start instead of failing sponsored requests after a deploy.
 *
 * @param env - Process environment naming each cluster's Kora.
 * @throws Error naming the missing key when a cluster sets exactly one of the two.
 */
export function assertKoraConfigured(env: FeePaymentEnv): void {
  for (const [cluster, envKeys] of Object.entries(KORA_ENV_KEYS)) {
    const serviceUrl = env[envKeys.serviceUrl]?.trim();
    const upstreamRpcUrl = env[envKeys.upstreamRpcUrl]?.trim();
    if (Boolean(serviceUrl) !== Boolean(upstreamRpcUrl)) {
      const missingEnvKey = serviceUrl ? envKeys.upstreamRpcUrl : envKeys.serviceUrl;
      throw new Error(`Kora is half-configured for ${cluster}: set ${missingEnvKey}`);
    }
  }
}

/**
 * The Kora that sponsors on the open scope's cluster, or null when none is configured for it.
 *
 * Each cluster has its own Kora with its own signer, policy and credentials, so the endpoint
 * follows the scope's cluster, never the process default. There is no built-in default URL: a
 * paymaster is money, and a deployment reaches one only by naming it. `assertKoraConfigured`
 * guarantees at boot that a cluster with a URL also has its upstream RPC.
 *
 * @param env - API environment naming each cluster's Kora.
 * @returns The scope's cluster's Kora, or null when its `KORA_<CLUSTER>_URL` is unset.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function resolveKoraEndpoint(env: FeePaymentEnv): KoraEndpoint | null {
  const envKeys = KORA_ENV_KEYS[currentClusterScope().cluster];
  const serviceUrl = env[envKeys.serviceUrl]?.trim();
  if (!serviceUrl) return null;
  return {
    rpcUrl: serviceUrl,
    apiKey: env[envKeys.apiKey],
    identityTokenAudience: env[envKeys.identityTokenAudience],
  };
}

/**
 * The Kora adapter for the open scope's cluster. Built per request because it carries the
 * caller's `user_id`; SDP application callers pass the server-derived identity from their owned
 * sponsorship boundary.
 *
 * @param env - API environment naming each cluster's Kora.
 * @param userId - The Kora `user_id` the adapter forwards.
 * @returns The adapter.
 * @throws FeePaymentError `PROVIDER_NOT_AVAILABLE` when the scope's cluster has no Kora.
 */
export function createKoraAdapter(env: FeePaymentEnv, userId: string): KoraAdapter {
  const endpoint = resolveKoraEndpoint(env);
  if (!endpoint) {
    const { cluster } = currentClusterScope();
    const envKeys = KORA_ENV_KEYS[cluster];
    throw new FeePaymentError(
      `Kora is not configured for ${cluster}: set ${envKeys.serviceUrl} and ${envKeys.upstreamRpcUrl}`,
      "PROVIDER_NOT_AVAILABLE"
    );
  }

  const config: KoraAdapterConfig = {
    ...endpoint,
    timeoutMs: env.KORA_TIMEOUT_MS ? Number.parseInt(env.KORA_TIMEOUT_MS, 10) : undefined,
    userId,
  };

  return new KoraAdapter(config);
}
