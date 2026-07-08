import type { OrganizationRpcProvider } from "@sdp/types";

export interface RpcEnv {
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
  SOLANA_NETWORK?: "devnet" | "mainnet-beta";
  SDP_DEPLOYMENT_MODE?: string;
}

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; rows: T[] }>;
  run(): Promise<number>;
}

export interface DatabaseClient {
  prepare(query: string): PreparedStatement;
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
