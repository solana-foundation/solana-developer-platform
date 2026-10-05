import type { OrganizationRpcProvider } from "@sdp/types";

/**
 * The per-cluster managed pool: one complete endpoint URL (key embedded) per
 * provider per cluster, plus an optional preferred provider per cluster.
 */
export interface ManagedRpcEnv {
  SOLANA_RPC_DEFAULT_PROVIDER_DEVNET?: OrganizationRpcProvider;
  SOLANA_RPC_TRITON_DEVNET_API_KEY_URL?: string;
  SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL?: string;
  SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL?: string;
  SOLANA_RPC_QUICKNODE_DEVNET_API_KEY_URL?: string;
  SOLANA_RPC_VALIDATIONCLOUD_DEVNET_API_KEY_URL?: string;
  SOLANA_RPC_NODIT_DEVNET_API_KEY_URL?: string;
  SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL?: string;
  SOLANA_RPC_DEFAULT_PROVIDER_MAINNET?: OrganizationRpcProvider;
  SOLANA_RPC_TRITON_MAINNET_API_KEY_URL?: string;
  SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL?: string;
  SOLANA_RPC_ALCHEMY_MAINNET_API_KEY_URL?: string;
  SOLANA_RPC_QUICKNODE_MAINNET_API_KEY_URL?: string;
  SOLANA_RPC_VALIDATIONCLOUD_MAINNET_API_KEY_URL?: string;
  SOLANA_RPC_NODIT_MAINNET_API_KEY_URL?: string;
  SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL?: string;
}

export interface RpcEnv extends ManagedRpcEnv {
  SOLANA_RPC_URL?: string;
  SOLANA_RPC_DEFAULT_PROVIDER?: OrganizationRpcProvider;
  SOLANA_RPC_TRITON_URL?: string;
  SOLANA_RPC_TRITON_API_KEY?: string;
  SOLANA_RPC_HELIUS_URL?: string;
  SOLANA_RPC_HELIUS_API_KEY?: string;
  SOLANA_RPC_ALCHEMY_URL?: string;
  SOLANA_RPC_ALCHEMY_API_KEY?: string;
  SOLANA_RPC_QUICKNODE_URL?: string;
  SOLANA_RPC_QUICKNODE_API_KEY?: string;
  SOLANA_RPC_VALIDATIONCLOUD_URL?: string;
  SOLANA_RPC_VALIDATIONCLOUD_API_KEY?: string;
  SOLANA_RPC_NODIT_URL?: string;
  SOLANA_RPC_NODIT_API_KEY?: string;
  SOLANA_NETWORK?: "devnet" | "mainnet-beta";
  /** Per-cluster RPC overrides; the non-default cluster needs one (see `resolveClusterRpcUrl`). */
  SOLANA_DEVNET_RPC_URL?: string;
  SOLANA_MAINNET_RPC_URL?: string;
}

export interface KVPutOptions {
  expirationTtl?: number;
}

export interface KVStore {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string, options?: KVPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<{ keys: Array<{ name: string }> }>;
}

export interface KVStoreSet {
  cache: KVStore;
}
