import type { ManagedRpcProvider } from "@sdp/types/rpc";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import type { ManagedRpcEnv } from "./types";

/**
 * Each cluster's managed pool env key per provider. Key order is the failover order;
 * `default` (often a public endpoint) last. Internal to this package: no export path exposes it.
 */
export const MANAGED_RPC_ENV_KEYS = {
  devnet: {
    triton: "SOLANA_RPC_TRITON_DEVNET_API_KEY_URL",
    helius: "SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL",
    alchemy: "SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL",
    quicknode: "SOLANA_RPC_QUICKNODE_DEVNET_API_KEY_URL",
    validationcloud: "SOLANA_RPC_VALIDATIONCLOUD_DEVNET_API_KEY_URL",
    nodit: "SOLANA_RPC_NODIT_DEVNET_API_KEY_URL",
    default: "SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL",
  },
  "mainnet-beta": {
    triton: "SOLANA_RPC_TRITON_MAINNET_API_KEY_URL",
    helius: "SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL",
    alchemy: "SOLANA_RPC_ALCHEMY_MAINNET_API_KEY_URL",
    quicknode: "SOLANA_RPC_QUICKNODE_MAINNET_API_KEY_URL",
    validationcloud: "SOLANA_RPC_VALIDATIONCLOUD_MAINNET_API_KEY_URL",
    nodit: "SOLANA_RPC_NODIT_MAINNET_API_KEY_URL",
    default: "SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL",
  },
} as const satisfies Record<SolanaCluster, Record<ManagedRpcProvider, keyof ManagedRpcEnv>>;

/**
 * The host each managed provider serves each cluster from, checked when the pool reads its URL
 * so a URL pasted into another cluster's slot fails at boot rather than at the genesis probe.
 * `*.` matches exactly one label (an account subdomain). `default` is `null`: it takes any host,
 * for self-hosted operators, except one that `MANAGED_RPC_HOSTS` or `PUBLIC_CLUSTER_HOSTS` gives
 * to another cluster; the genesis guard still proves it.
 */
export const MANAGED_RPC_HOSTS = {
  devnet: {
    triton: "*.devnet.rpcpool.com",
    helius: "devnet.helius-rpc.com",
    alchemy: "solana-devnet.g.alchemy.com",
    quicknode: "*.solana-devnet.quiknode.pro",
    validationcloud: "devnet.solana.validationcloud.io",
    nodit: "solana-devnet.nodit.io",
    default: null,
  },
  "mainnet-beta": {
    triton: "*.mainnet.rpcpool.com",
    helius: "mainnet.helius-rpc.com",
    alchemy: "solana-mainnet.g.alchemy.com",
    quicknode: "*.solana-mainnet.quiknode.pro",
    validationcloud: "mainnet.solana.validationcloud.io",
    nodit: "solana-mainnet.nodit.io",
    default: null,
  },
} as const satisfies Record<SolanaCluster, Record<ManagedRpcProvider, string | null>>;

/**
 * The value a deployment writes into a slot it mounts before anyone has filled it: sdp-infra seeds
 * every app secret with it, and Doppler keeps it for a provider with no account yet. A slot holding
 * it is unset, so a deployment can mount every slot and its pool is whichever slots hold a URL.
 */
export const UNFILLED_SLOT_VALUE = "placeholder";

/**
 * A managed slot's endpoint URL, read from the environment.
 *
 * @param envKey - The slot's `SOLANA_RPC_<PROVIDER>_<CLUSTER>_API_KEY_URL` key.
 * @returns The URL, or `undefined` when the slot is empty or holds `UNFILLED_SLOT_VALUE`.
 */
export function managedRpcSlotUrl(envKey: string): string | undefined {
  const value = process.env[envKey];
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === UNFILLED_SLOT_VALUE) return undefined;
  return value;
}

/** Each cluster's public Solana Labs endpoint hosts, which only that cluster's slots may name. */
export const PUBLIC_CLUSTER_HOSTS = {
  devnet: ["api.devnet.solana.com"],
  "mainnet-beta": ["api.mainnet-beta.solana.com", "api.mainnet.solana.com"],
} as const satisfies Record<SolanaCluster, readonly string[]>;
