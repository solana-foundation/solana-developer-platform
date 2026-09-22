/**
 * Sorky protocol configuration and development registry.
 *
 * This file centralizes:
 * - supported networks
 * - RPC/runtime defaults
 * - asset metadata
 * - token classification
 * - portfolio normalization settings
 * - pricing configuration
 * - agent behavior defaults
 * - alert thresholds
 * - execution safety limits
 * - development-only test assets
 *
 * IMPORTANT:
 * This file contains public configuration only.
 * Never place private keys, seed phrases, API secrets, or signer credentials here.
 */

export type ChainFamily = "solana" | "evm";

export type NetworkId =
  | "solana-mainnet"
  | "solana-devnet"
  | "ethereum"
  | "base"
  | "arbitrum"
  | "optimism";

export type AssetKind =
  | "native"
  | "stablecoin"
  | "fungible-token"
  | "test-token"
  | "unknown";

export type RiskLevel =
  | "low"
  | "medium"
  | "high"
  | "experimental";

export interface NetworkConfig {
  id: NetworkId;
  family: ChainFamily;
  name: string;
  enabled: boolean;
  testnet: boolean;
  nativeSymbol: string;
  nativeDecimals: number;
  explorerBaseUrl: string;
  rpcEnvironmentVariable: string;
  blockTimeMsEstimate: number;
}

export interface AssetConfig {
  id: string;
  chain: NetworkId;
  name: string;
  symbol: string;
  address: string | null;
  decimals: number;
  kind: AssetKind;
  risk: RiskLevel;
  testOnly?: boolean;
  description?: string;
}

export interface WalletConfig {
  label: string;
  chainFamily: ChainFamily;
  address: string;
  purpose: "agent" | "monitoring" | "testing";
}

export interface AlertThresholds {
  largeTransferUsd: number;
  portfolioMovePercent: number;
  concentrationPercent: number;
  newAssetMinimumUsd: number;
}

export interface ExecutionLimits {
  enabled: boolean;
  requireHumanApproval: boolean;
  maxTradeUsd: number;
  maxDailyNotionalUsd: number;
  maxSlippageBps: number;
  allowUnknownTokens: boolean;
}

/* -------------------------------------------------------------------------- */
/*                                   NETWORKS                                 */
/* -------------------------------------------------------------------------- */

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  "solana-mainnet": {
    id: "solana-mainnet",
    family: "solana",
    name: "Solana Mainnet",
    enabled: true,
    testnet: false,
    nativeSymbol: "SOL",
    nativeDecimals: 9,
    explorerBaseUrl: "https://solscan.io",
    rpcEnvironmentVariable: "SOLANA_RPC_URL",
    blockTimeMsEstimate: 400,
  },

  "solana-devnet": {
    id: "solana-devnet",
    family: "solana",
    name: "Solana Devnet",
    enabled: true,
    testnet: true,
    nativeSymbol: "SOL",
    nativeDecimals: 9,
    explorerBaseUrl: "https://solscan.io",
    rpcEnvironmentVariable: "SOLANA_DEVNET_RPC_URL",
    blockTimeMsEstimate: 400,
  },

  ethereum: {
    id: "ethereum",
    family: "evm",
    name: "Ethereum",
    enabled: true,
    testnet: false,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    explorerBaseUrl: "https://etherscan.io",
    rpcEnvironmentVariable: "ETHEREUM_RPC_URL",
    blockTimeMsEstimate: 12000,
  },

  base: {
    id: "base",
    family: "evm",
    name: "Base",
    enabled: true,
    testnet: false,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    explorerBaseUrl: "https://basescan.org",
    rpcEnvironmentVariable: "BASE_RPC_URL",
    blockTimeMsEstimate: 2000,
  },

  arbitrum: {
    id: "arbitrum",
    family: "evm",
    name: "Arbitrum",
    enabled: true,
    testnet: false,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    explorerBaseUrl: "https://arbiscan.io",
    rpcEnvironmentVariable: "ARBITRUM_RPC_URL",
    blockTimeMsEstimate: 250,
  },

  optimism: {
    id: "optimism",
    family: "evm",
    name: "Optimism",
    enabled: false,
    testnet: false,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    explorerBaseUrl: "https://optimistic.etherscan.io",
    rpcEnvironmentVariable: "OPTIMISM_RPC_URL",
    blockTimeMsEstimate: 2000,
  },
};

/* -------------------------------------------------------------------------- */
/*                              PUBLIC AGENT WALLETS                           */
/* -------------------------------------------------------------------------- */

export const PUBLIC_WALLETS: WalletConfig[] = [
  {
    label: "sorky-solana-agent",
    chainFamily: "solana",
    address: "9jHyqsHnFEe6HMQvdBnBboZU5EeScbKsduX8yFbwf6Nx",
    purpose: "agent",
  },
  {
    label: "sorky-evm-agent",
    chainFamily: "evm",
    address: "0xcdbaa111de811cc7ccac73348061f4d354d78642",
    purpose: "agent",
  },
];

/* -------------------------------------------------------------------------- */
/*                                ASSET REGISTRY                              */
/* -------------------------------------------------------------------------- */

export const ASSETS: AssetConfig[] = [
  {
    id: "sol",
    chain: "solana-mainnet",
    name: "Solana",
    symbol: "SOL",
    address: null,
    decimals: 9,
    kind: "native",
    risk: "low",
    description: "Native asset of the Solana network.",
  },

  {
    id: "eth",
    chain: "ethereum",
    name: "Ether",
    symbol: "ETH",
    address: null,
    decimals: 18,
    kind: "native",
    risk: "low",
    description: "Native asset of Ethereum and several EVM networks.",
  },

  {
    id: "dummycoin-devnet",
    chain: "solana-devnet",
    name: "DummyCoin",
    symbol: "DUMMY",
    address: "REPLACE_WITH_DUMMYCOIN_MINT_ADDRESS",
    decimals: 9,
    kind: "test-token",
    risk: "experimental",
    testOnly: true,
    description:
      "Development-only Solana test token used for parser, balance, portfolio, and swap simulation.",
  },
];

/* -------------------------------------------------------------------------- */
/*                                  DUMMYCOIN                                 */
/* -------------------------------------------------------------------------- */

/**
 * DummyCoin exists purely as a development asset.
 *
 * Intended uses:
 * - token balance parsing
 * - mock portfolio positions
 * - transaction normalization
 * - swap parser fixtures
 * - alert testing
 * - PnL calculation tests
 * - UI rendering
 *
 * It should not be treated as a production asset.
 */
export const DUMMY_COIN = {
  name: "DummyCoin",
  symbol: "DUMMY",
  network: "solana-devnet" as const,
  mintAddress: "REPLACE_WITH_DUMMYCOIN_MINT_ADDRESS",
  decimals: 9,
  testOnly: true,

  metadata: {
    category: "development",
    description: "Sorky development test asset.",
  },

  fixtures: {
    defaultBalance: "100000",
    defaultPriceUsd: 1,
    simulatedAverageCostUsd: 0.75,
  },
};

/* -------------------------------------------------------------------------- */
/*                              PORTFOLIO SETTINGS                             */
/* -------------------------------------------------------------------------- */

export const PORTFOLIO_CONFIG = {
  accountingMethod: "weighted-average" as const,

  treatKnownWalletTransfersAsInternal: true,

  stablecoinPegUsd: 1,

  ignoreDustBelowUsd: 0.01,

  markMissingPricesExplicitly: true,

  historicalSnapshots: {
    enabled: true,
    intervalSeconds: 300,
  },

  pnl: {
    realized: true,
    unrealized: true,
    includeFees: true,
  },
};

/* -------------------------------------------------------------------------- */
/*                               PRICING SETTINGS                              */
/* -------------------------------------------------------------------------- */

export const PRICING_CONFIG = {
  currentPriceTtlSeconds: 30,

  historicalPriceTtlSeconds: 86400 * 30,

  stablecoinSymbols: ["USDC", "USDT"],

  providers: {
    primary: "birdeye",
    fallback: "coingecko",
  },

  confidence: {
    minimumAccepted: 0.7,
    unresolvedBelow: 0.4,
  },
};

/* -------------------------------------------------------------------------- */
/*                              TRANSACTION PARSING                            */
/* -------------------------------------------------------------------------- */

export const PARSER_CONFIG = {
  solana: {
    inspectInnerInstructions: true,
    inspectTokenBalanceDeltas: true,
    inspectNativeBalanceDeltas: true,
    detectWrappedSol: true,

    knownProtocols: [
      "Jupiter",
      "Raydium",
      "Orca",
      "Meteora",
      "Phoenix",
      "OpenBook",
      "Pump.fun",
      "PumpSwap",
    ],
  },

  evm: {
    inspectReceiptLogs: true,
    inspectInternalTransfers: true,
    decodeErc20Transfers: true,
    detectWrappedEth: true,

    knownProtocols: [
      "Uniswap",
      "Aerodrome",
      "Curve",
      "PancakeSwap",
      "SushiSwap",
      "Balancer",
    ],
  },
};

/* -------------------------------------------------------------------------- */
/*                                AGENT SETTINGS                               */
/* -------------------------------------------------------------------------- */

export const AGENT_CONFIG = {
  name: "Sorky",

  mode: "observer" as const,

  chainAwareness: true,

  crossChainAnalysis: true,

  includeConfidenceScores: true,

  summarizeUnknownTransactions: false,

  maxTransactionsPerAnalysis: 250,

  capabilities: [
    "portfolio-summary",
    "wallet-activity",
    "position-change-detection",
    "cross-chain-comparison",
    "new-asset-detection",
    "large-transfer-detection",
    "pnl-summary",
  ],
};

/* -------------------------------------------------------------------------- */
/*                                   ALERTS                                    */
/* -------------------------------------------------------------------------- */

export const ALERT_THRESHOLDS: AlertThresholds = {
  largeTransferUsd: 5000,
  portfolioMovePercent: 10,
  concentrationPercent: 40,
  newAssetMinimumUsd: 100,
};

export const ALERT_CONFIG = {
  enabled: true,

  categories: {
    largeTransfer: true,
    newAsset: true,
    portfolioMove: true,
    concentration: true,
    newWalletActivity: true,
  },

  cooldownSeconds: 300,
};

/* -------------------------------------------------------------------------- */
/*                            EXECUTION SAFETY BOUNDARY                        */
/* -------------------------------------------------------------------------- */

/**
 * Sorky is read-only by default.
 *
 * If execution is added later, signing should live in a separate service.
 * The main agent process should never directly expose raw private-key material.
 */
export const EXECUTION_LIMITS: ExecutionLimits = {
  enabled: false,
  requireHumanApproval: true,
  maxTradeUsd: 100,
  maxDailyNotionalUsd: 500,
  maxSlippageBps: 100,
  allowUnknownTokens: false,
};

/* -------------------------------------------------------------------------- */
/*                                  PROVIDERS                                  */
/* -------------------------------------------------------------------------- */

export const PROVIDER_CONFIG = {
  solana: {
    rpcEnv: "SOLANA_RPC_URL",
    devnetRpcEnv: "SOLANA_DEVNET_RPC_URL",
    heliusApiKeyEnv: "HELIUS_API_KEY",
    birdeyeApiKeyEnv: "BIRDEYE_API_KEY",
  },

  evm: {
    ethereumRpcEnv: "ETHEREUM_RPC_URL",
    baseRpcEnv: "BASE_RPC_URL",
    arbitrumRpcEnv: "ARBITRUM_RPC_URL",
    optimismRpcEnv: "OPTIMISM_RPC_URL",
    etherscanApiKeyEnv: "ETHERSCAN_API_KEY",
  },

  ai: {
    apiKeyEnv: "OPENAI_API_KEY",
  },
};

/* -------------------------------------------------------------------------- */
/*                                   CACHING                                   */
/* -------------------------------------------------------------------------- */

export const CACHE_CONFIG = {
  enabled: true,

  ttlSeconds: {
    tokenMetadata: 86400,
    currentPrice: 30,
    walletSummary: 20,
    confirmedTransaction: 86400 * 365,
    historicalPrice: 86400 * 30,
  },
};

/* -------------------------------------------------------------------------- */
/*                                SYNC SETTINGS                                */
/* -------------------------------------------------------------------------- */

export const SYNC_CONFIG = {
  historicalBackfill: true,

  incrementalSync: true,

  maxConcurrentWallets: 5,

  maxConcurrentTransactions: 20,

  retry: {
    maxAttempts: 4,
    initialDelayMs: 500,
    maxDelayMs: 5000,
    multiplier: 2,
  },
};

/* -------------------------------------------------------------------------- */
/*                                  UTILITIES                                  */
/* -------------------------------------------------------------------------- */

export function getNetwork(id: NetworkId): NetworkConfig {
  return NETWORKS[id];
}

export function getAsset(id: string): AssetConfig | undefined {
  return ASSETS.find((asset) => asset.id === id);
}

export function getAssetsForNetwork(network: NetworkId): AssetConfig[] {
  return ASSETS.filter((asset) => asset.chain === network);
}

export function getEnabledNetworks(): NetworkConfig[] {
  return Object.values(NETWORKS).filter((network) => network.enabled);
}

export function getPublicWallets(
  chainFamily?: ChainFamily
): WalletConfig[] {
  if (!chainFamily) {
    return PUBLIC_WALLETS;
  }

  return PUBLIC_WALLETS.filter(
    (wallet) => wallet.chainFamily === chainFamily
  );
}

export function isTestAsset(asset: AssetConfig): boolean {
  return asset.testOnly === true || asset.kind === "test-token";
}

export function validatePublicConfiguration(): string[] {
  const warnings: string[] = [];

  if (DUMMY_COIN.mintAddress.startsWith("REPLACE_")) {
    warnings.push("DummyCoin mint address has not been configured.");
  }

  for (const wallet of PUBLIC_WALLETS) {
    if (!wallet.address.trim()) {
      warnings.push(`Missing public address for ${wallet.label}.`);
    }
  }

  return warnings;
}

/* -------------------------------------------------------------------------- */
/*                                  EXPORT                                     */
/* -------------------------------------------------------------------------- */

export const SORKY_CONFIG = {
  networks: NETWORKS,
  wallets: PUBLIC_WALLETS,
  assets: ASSETS,
  dummyCoin: DUMMY_COIN,
  portfolio: PORTFOLIO_CONFIG,
  pricing: PRICING_CONFIG,
  parser: PARSER_CONFIG,
  agent: AGENT_CONFIG,
  alerts: ALERT_CONFIG,
  alertThresholds: ALERT_THRESHOLDS,
  execution: EXECUTION_LIMITS,
  providers: PROVIDER_CONFIG,
  cache: CACHE_CONFIG,
  sync: SYNC_CONFIG,
} as const;
