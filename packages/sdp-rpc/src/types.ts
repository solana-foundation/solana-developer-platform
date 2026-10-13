/**
 * The per-cluster managed pool: one complete endpoint URL (key embedded) per
 * provider per cluster.
 */
export interface ManagedRpcEnv {
  SOLANA_RPC_TRITON_DEVNET_API_KEY_URL?: string;
  SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL?: string;
  SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL?: string;
  SOLANA_RPC_QUICKNODE_DEVNET_API_KEY_URL?: string;
  SOLANA_RPC_VALIDATIONCLOUD_DEVNET_API_KEY_URL?: string;
  SOLANA_RPC_NODIT_DEVNET_API_KEY_URL?: string;
  SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL?: string;
  SOLANA_RPC_TRITON_MAINNET_API_KEY_URL?: string;
  SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL?: string;
  SOLANA_RPC_ALCHEMY_MAINNET_API_KEY_URL?: string;
  SOLANA_RPC_QUICKNODE_MAINNET_API_KEY_URL?: string;
  SOLANA_RPC_VALIDATIONCLOUD_MAINNET_API_KEY_URL?: string;
  SOLANA_RPC_NODIT_MAINNET_API_KEY_URL?: string;
  SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL?: string;
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
