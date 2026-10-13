import type { ManagedRpcEnv } from "@sdp/rpc";

/**
 * Every managed pool env key `createClusterRpc()` reads, both clusters, blank. Must stay free of
 * runtime imports: `src/test/setup.ts` loads it before a suite's `vi.mock` registers, so any module
 * it pulled in (e.g. the `@sdp/types` barrel) would bind unmocked for the whole suite.
 */
export const BLANK_MANAGED_POOL_ENV = {
  SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: "",
  SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: "",
  SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL: "",
  SOLANA_RPC_QUICKNODE_DEVNET_API_KEY_URL: "",
  SOLANA_RPC_VALIDATIONCLOUD_DEVNET_API_KEY_URL: "",
  SOLANA_RPC_NODIT_DEVNET_API_KEY_URL: "",
  SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL: "",
  SOLANA_RPC_TRITON_MAINNET_API_KEY_URL: "",
  SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL: "",
  SOLANA_RPC_ALCHEMY_MAINNET_API_KEY_URL: "",
  SOLANA_RPC_QUICKNODE_MAINNET_API_KEY_URL: "",
  SOLANA_RPC_VALIDATIONCLOUD_MAINNET_API_KEY_URL: "",
  SOLANA_RPC_NODIT_MAINNET_API_KEY_URL: "",
  SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL: "",
} as const satisfies Required<ManagedRpcEnv>;

/**
 * The vitest setup blanks these so a suite that reaches the door without `installClusterRpcStub()`
 * fails with `RPC_NOT_CONFIGURED` instead of calling whatever pool the CI environment injects.
 */
export const MANAGED_POOL_ENV_KEYS = Object.keys(BLANK_MANAGED_POOL_ENV);
